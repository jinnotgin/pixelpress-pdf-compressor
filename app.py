#!/usr/bin/env python3

import fitz  # PyMuPDF
import os
import uuid
import threading
import time
import logging
import sqlite3 # For SQLite database
from flask import Flask, request, jsonify, render_template, send_from_directory, url_for
from werkzeug.utils import secure_filename
from concurrent.futures import ThreadPoolExecutor

app = Flask(__name__)

# --- Configuration ---
UPLOAD_FOLDER = 'uploads'
PROCESSED_FOLDER = 'processed'
ALLOWED_EXTENSIONS = {'pdf'}
DATABASE_FILE = 'tasks.db' # SQLite database file

app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
app.config['PROCESSED_FOLDER'] = PROCESSED_FOLDER
app.config['MAX_CONTENT_LENGTH'] = 100 * 1024 * 1024  # 100 MB limit

# Setup logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(threadName)s - %(message)s')
app.logger.handlers.clear()
for handler in logging.getLogger().handlers:
    handler.setFormatter(logging.Formatter('%(asctime)s - %(levelname)s - %(threadName)s - %(message)s'))
app.logger.setLevel(logging.INFO)


os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(PROCESSED_FOLDER, exist_ok=True)

# --- SQLite Database Setup ---
def get_db_connection():
    conn = sqlite3.connect(DATABASE_FILE, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = None
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS task_status (
                task_id TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                message TEXT,
                progress INTEGER DEFAULT 0,
                input_path TEXT,
                output_path TEXT,
                original_filename TEXT,
                user_facing_output_filename TEXT,
                dpi INTEGER,
                image_format TEXT,
                jpeg_quality INTEGER,
                original_size_bytes INTEGER,    -- New column
                processed_size_bytes INTEGER,   -- New column
                timestamp_created REAL NOT NULL,
                timestamp_last_updated REAL
            )
        ''')
        conn.commit() # Commit creation first

        # Check and add columns if they don't exist (for schema migration)
        table_info = cursor.execute("PRAGMA table_info(task_status);").fetchall()
        column_names = [info['name'] for info in table_info]

        if 'original_size_bytes' not in column_names:
            try:
                cursor.execute("ALTER TABLE task_status ADD COLUMN original_size_bytes INTEGER;")
                conn.commit()
                app.logger.info("Added 'original_size_bytes' column to task_status table.")
            except sqlite3.Error as e_alter:
                app.logger.error(f"Error adding 'original_size_bytes' column: {e_alter}")

        if 'processed_size_bytes' not in column_names:
            try:
                cursor.execute("ALTER TABLE task_status ADD COLUMN processed_size_bytes INTEGER;")
                conn.commit()
                app.logger.info("Added 'processed_size_bytes' column to task_status table.")
            except sqlite3.Error as e_alter:
                app.logger.error(f"Error adding 'processed_size_bytes' column: {e_alter}")

        app.logger.info("Database initialized successfully.")
    except sqlite3.Error as e:
        app.logger.error(f"Database initialization error: {e}", exc_info=True)
    finally:
        if conn:
            conn.close()

MAX_PDF_WORKERS = int(os.environ.get("MAX_PDF_WORKERS", os.cpu_count() or 2))
app.logger.info(f"Initializing PDF processor with {MAX_PDF_WORKERS} max workers.")
pdf_processor_executor = ThreadPoolExecutor(max_workers=MAX_PDF_WORKERS, thread_name_prefix="PDFWorker")


def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

def update_task_in_db(task_id, status=None, message=None, progress=None,
                      user_facing_output_filename_val=None,
                      original_size_bytes_val=None, processed_size_bytes_val=None): # Added size params
    conn = None
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        fields_to_update = []
        params = []

        if status is not None:
            fields_to_update.append("status = ?")
            params.append(status)
        if message is not None:
            fields_to_update.append("message = ?")
            params.append(message)
        if progress is not None:
            fields_to_update.append("progress = ?")
            params.append(progress)
        if user_facing_output_filename_val is not None:
            fields_to_update.append("user_facing_output_filename = ?")
            params.append(user_facing_output_filename_val)
        if original_size_bytes_val is not None: # New
            fields_to_update.append("original_size_bytes = ?")
            params.append(original_size_bytes_val)
        if processed_size_bytes_val is not None: # New
            fields_to_update.append("processed_size_bytes = ?")
            params.append(processed_size_bytes_val)

        if not fields_to_update:
            return

        fields_to_update.append("timestamp_last_updated = ?")
        params.append(time.time())

        query = f"UPDATE task_status SET {', '.join(fields_to_update)} WHERE task_id = ?"
        params.append(task_id)

        cursor.execute(query, tuple(params))
        conn.commit()
    except sqlite3.Error as e:
        app.logger.error(f"DB Error updating task {task_id}: {e}", exc_info=True)
    finally:
        if conn:
            conn.close()

def rasterize_pdf_to_new_pdf_web(task_id, input_pdf_path, output_pdf_path, dpi,
                                 original_filename_for_naming, image_format='jpeg', jpeg_quality=75):
    app.logger.info(
        f"Task {task_id} ({original_filename_for_naming}) starting rasterization. "
        f"DPI: {dpi}, Format: {image_format}, "
        f"JPEG Quality: {jpeg_quality if image_format == 'jpeg' else 'N/A'}. "
        f"Thread: {threading.current_thread().name}"
    )

    user_facing_output_filename = f"Compressed_{original_filename_for_naming}"
    update_task_in_db(task_id, status='processing', message='Preparing: Opening your PDF...', progress=5)

    input_doc = None
    output_doc = None
    original_size = None
    processed_size = None

    try:
        if not os.path.exists(input_pdf_path):
            update_task_in_db(task_id, status='failed', message="Error: Input PDF was not found on server.")
            app.logger.error(f"Task {task_id}: Input PDF {input_pdf_path} not found.")
            return False

        try: # Get original size before any processing
            if os.path.exists(input_pdf_path):
                original_size = os.path.getsize(input_pdf_path)
            else:
                app.logger.warning(f"Task {task_id}: Input file {input_pdf_path} does not exist for size check.")
        except OSError as e:
            app.logger.warning(f"Task {task_id}: Could not get size of input file {input_pdf_path}: {e}")


        input_doc = fitz.open(input_pdf_path)
        output_doc = fitz.open()
        num_pages = len(input_doc)

        if num_pages == 0:
            output_doc.save(output_pdf_path, garbage=4, deflate=True, deflate_images=True, clean=True)
            if os.path.exists(output_pdf_path):
                processed_size = os.path.getsize(output_pdf_path)
            update_task_in_db(task_id, status='completed',
                              message="Input PDF has no pages. An empty processed PDF has been created.",
                              progress=100, user_facing_output_filename_val=user_facing_output_filename,
                              original_size_bytes_val=original_size,
                              processed_size_bytes_val=processed_size)
            app.logger.info(f"Task {task_id}: Input PDF has no pages. Empty PDF created. Original: {original_size} bytes, Processed: {processed_size} bytes.")
            return True

        update_task_in_db(task_id, message=f"Processing: Analyzing {num_pages} pages...", progress=10)

        for page_num in range(num_pages):
            current_page_progress = int(80 * ((page_num + 1) / num_pages))
            update_task_in_db(task_id, progress=(10 + current_page_progress),
                              message=f"Rasterizing: Page {page_num + 1} of {num_pages} as {image_format.upper()} at {dpi} DPI...")

            page_instance = None
            pix_map = None
            try:
                page_instance = input_doc.load_page(page_num)
                zoom = dpi / 72.0
                matrix = fitz.Matrix(zoom, zoom)
                pix_map = page_instance.get_pixmap(matrix=matrix, alpha=False)

                page_width_pt = pix_map.width * 72.0 / dpi
                page_height_pt = pix_map.height * 72.0 / dpi

                new_page = output_doc.new_page(width=page_width_pt, height=page_height_pt)

                if image_format == 'jpeg':
                    try:
                        image_bytes = pix_map.tobytes(output="jpeg", jpg_quality=jpeg_quality)
                        new_page.insert_image(new_page.rect, stream=image_bytes)
                        app.logger.debug(f"Task {task_id}: Page {page_num+1} inserted as JPEG (quality: {jpeg_quality})")
                    except Exception as img_e:
                        app.logger.warning(f"Task {task_id}: Failed to convert page {page_num+1} to JPEG stream, falling back to default pixmap insertion. Error: {img_e}")
                        new_page.insert_image(new_page.rect, pixmap=pix_map) # Fallback
                elif image_format == 'png':
                    try:
                        image_bytes = pix_map.tobytes(output="png")
                        new_page.insert_image(new_page.rect, stream=image_bytes)
                        app.logger.debug(f"Task {task_id}: Page {page_num+1} inserted as PNG stream")
                    except Exception as img_e:
                        app.logger.warning(f"Task {task_id}: Failed to convert page {page_num+1} to PNG stream, falling back to default pixmap insertion. Error: {img_e}")
                        new_page.insert_image(new_page.rect, pixmap=pix_map) # Fallback
                else:
                    app.logger.warning(f"Task {task_id}: Unknown image format '{image_format}', using default pixmap insertion for page {page_num+1}.")
                    new_page.insert_image(new_page.rect, pixmap=pix_map)

                pix_map = None
                page_instance.clean_contents()
                page_instance = None

                fitz.TOOLS.mupdf_display_errors(False)
                fitz.TOOLS.mupdf_warnings(False)
            except Exception as e:
                error_msg = f"Error on page {page_num + 1}: {str(e)[:100]}..."
                update_task_in_db(task_id, status='failed', message=error_msg)
                app.logger.error(f"Task {task_id} failed on page {page_num + 1}: {e}", exc_info=True)
                if os.path.exists(output_pdf_path):
                    try: os.remove(output_pdf_path)
                    except OSError: app.logger.warning(f"Task {task_id}: Could not remove partial output {output_pdf_path}")
                return False

        update_task_in_db(task_id, progress=95, message="Finalizing: Compiling and saving your new PDF...")
        output_doc.save(output_pdf_path, garbage=4, deflate=True, deflate_images=True, clean=True, linear=True)

        try: # Get processed size after saving
            if os.path.exists(output_pdf_path):
                processed_size = os.path.getsize(output_pdf_path)
            else:
                app.logger.warning(f"Task {task_id}: Output file {output_pdf_path} does not exist for size check.")
        except OSError as e:
            app.logger.warning(f"Task {task_id}: Could not get size of output file {output_pdf_path}: {e}")

        update_task_in_db(task_id, status='completed',
                          message=f"Success! Your PDF '{user_facing_output_filename}' is ready for download.",
                          progress=100, user_facing_output_filename_val=user_facing_output_filename,
                          original_size_bytes_val=original_size,
                          processed_size_bytes_val=processed_size)
        app.logger.info(f"Task {task_id} ({original_filename_for_naming}) completed successfully. Original: {original_size} bytes, Processed: {processed_size} bytes.")
        return True

    except Exception as e:
        crit_error_msg = f"Critical error during processing: {str(e)[:100]}..."
        update_task_in_db(task_id, status='failed', message=crit_error_msg)
        app.logger.error(f"Task {task_id} critical error: {e}", exc_info=True)
        if os.path.exists(output_pdf_path):
            try: os.remove(output_pdf_path)
            except OSError: app.logger.warning(f"Task {task_id}: Could not remove output {output_pdf_path} on critical error.")
        return False
    finally:
        if input_doc:
            try: input_doc.close()
            except Exception as e_close: app.logger.warning(f"Task {task_id}: Error closing input_doc: {e_close}")
        if output_doc:
            try: output_doc.close()
            except Exception as e_close: app.logger.warning(f"Task {task_id}: Error closing output_doc: {e_close}")

        if os.path.exists(input_pdf_path): # Input file is cleaned up after its size is potentially read
            try:
                os.remove(input_pdf_path)
                app.logger.info(f"Cleaned up input file: {input_pdf_path} for task {task_id}")
            except OSError as e:
                app.logger.warning(f"Could not remove input file {input_pdf_path} for task {task_id}: {e}")

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/upload', methods=['POST'])
def upload_file():
    if 'pdf_file' not in request.files:
        return jsonify({'error': 'No file part in the request.'}), 400
    file = request.files['pdf_file']
    if file.filename == '':
        return jsonify({'error': 'No file selected for upload.'}), 400

    if file and allowed_file(file.filename):
        original_filename_secure = secure_filename(file.filename)
        task_id = str(uuid.uuid4())

        try:
            dpi_str = request.form.get('dpi', '72')
            dpi = int(dpi_str)
            if not (10 <= dpi <= 600):
                 app.logger.warning(f"Task {task_id}: Invalid DPI value '{dpi_str}'. Defaulting to 72.")
                 dpi = 72
        except ValueError:
            app.logger.warning(f"Task {task_id}: Non-integer DPI value '{request.form.get('dpi')}'. Defaulting to 72.")
            dpi = 72

        image_format = request.form.get('image_format', 'jpeg').lower()
        jpeg_quality_val = 75

        if image_format not in ['jpeg', 'png']:
            app.logger.warning(f"Task {task_id}: Invalid image_format '{image_format}' from form. Defaulting to 'jpeg'.")
            image_format = 'jpeg'

        if image_format == 'jpeg':
            try:
                jpeg_quality_str = request.form.get('jpeg_quality', '75')
                jpeg_quality_val = int(jpeg_quality_str)
                if not (1 <= jpeg_quality_val <= 100):
                    app.logger.warning(f"Task {task_id}: Invalid JPEG quality '{jpeg_quality_str}'. Defaulting to 75.")
                    jpeg_quality_val = 75
            except ValueError:
                app.logger.warning(f"Task {task_id}: Non-integer JPEG quality '{request.form.get('jpeg_quality')}'. Defaulting to 75.")
                jpeg_quality_val = 75
        else:
            jpeg_quality_val = None

        server_input_filename = f"{task_id}_{original_filename_secure}"
        server_output_filename = f"{task_id}_processed.pdf"
        input_pdf_path = os.path.join(app.config['UPLOAD_FOLDER'], server_input_filename)
        output_pdf_path = os.path.join(app.config['PROCESSED_FOLDER'], server_output_filename)

        user_facing_dl_name = f"Compressed_{original_filename_secure}"

        try:
            file.save(input_pdf_path)
            app.logger.info(f"Task {task_id}: File '{original_filename_secure}' saved to '{input_pdf_path}'.")
        except Exception as e:
            app.logger.error(f"Error saving file {original_filename_secure} for task {task_id}: {e}", exc_info=True)
            return jsonify({'error': f'Could not save uploaded file: {str(e)}'}), 500

        conn = None
        try:
            conn = get_db_connection()
            cursor = conn.cursor()
            current_time = time.time()
            # original_size_bytes and processed_size_bytes will be NULL initially
            cursor.execute("""
                INSERT INTO task_status (task_id, status, message, progress, input_path, output_path,
                                         original_filename, user_facing_output_filename, dpi,
                                         image_format, jpeg_quality,
                                         timestamp_created, timestamp_last_updated)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (task_id, 'queued', 'File received. Queued for processing.', 0, input_pdf_path, output_pdf_path,
                  original_filename_secure, user_facing_dl_name, dpi,
                  image_format, jpeg_quality_val,
                  current_time, current_time))
            conn.commit()
        except sqlite3.Error as e:
            app.logger.error(f"DB Error creating task {task_id}: {e}", exc_info=True)
            if os.path.exists(input_pdf_path):
                try: os.remove(input_pdf_path)
                except OSError: app.logger.warning(f"Could not remove {input_pdf_path} after DB error for task {task_id}")
            return jsonify({'error': 'Failed to queue task due to a database error.'}), 500
        finally:
            if conn:
                conn.close()

        pdf_processor_executor.submit(rasterize_pdf_to_new_pdf_web, task_id, input_pdf_path,
                                      output_pdf_path, dpi, original_filename_secure,
                                      image_format, jpeg_quality_val)
        app.logger.info(f"Task {task_id} ({original_filename_secure}) submitted for processing with format: {image_format}.")
        return jsonify({'task_id': task_id, 'message': 'File upload successful, processing has been queued.'})
    else:
        return jsonify({'error': 'Invalid file type. Only PDF files are allowed.'}), 400

@app.route('/status/<task_id>')
def task_status(task_id):
    conn = None
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM task_status WHERE task_id = ?", (task_id,))
        task_row = cursor.fetchone()
    except sqlite3.Error as e:
        app.logger.error(f"DB Error fetching status for task {task_id}: {e}", exc_info=True)
        return jsonify({'status': 'error', 'message': 'Error querying task status.'}), 500
    finally:
        if conn:
            conn.close()

    if not task_row:
        app.logger.warning(f"Status request for unknown/cleaned task ID: {task_id}")
        return jsonify({'status': 'not_found', 'message': 'Task ID not found or has been cleaned up.'}), 404

    task_dict = dict(task_row) # This will include original_size_bytes and processed_size_bytes
    if 'user_facing_output_filename' in task_dict:
        task_dict['output_filename'] = task_dict.pop('user_facing_output_filename')
    else:
        task_dict['output_filename'] = None

    return jsonify(task_dict)

@app.route('/download/<task_id>')
def download_file_route(task_id):
    conn = None
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT status, output_path, user_facing_output_filename FROM task_status WHERE task_id = ?", (task_id,))
        task_row = cursor.fetchone()
    except sqlite3.Error as e:
        app.logger.error(f"DB Error fetching download info for task {task_id}: {e}", exc_info=True)
        return jsonify({'error': 'Error preparing file for download.'}), 500
    finally:
        if conn:
            conn.close()

    if not task_row:
        app.logger.warning(f"Download request for unknown/cleaned task ID: {task_id}")
        return jsonify({'error': 'Task not found or has been cleaned up.'}), 404

    if task_row['status'] != 'completed':
        app.logger.warning(f"Download attempt for task {task_id} not completed. Status: {task_row['status']}")
        return jsonify({'error': 'File is not yet ready or processing failed.'}), 400

    if not task_row['user_facing_output_filename'] or not task_row['output_path']:
        app.logger.error(f"Task {task_id} completed but output details missing in DB: {dict(task_row)}")
        return jsonify({'error': 'Output file details incomplete for completed task.'}), 500

    actual_disk_filename = os.path.basename(task_row['output_path'])
    user_download_name = task_row['user_facing_output_filename']

    app.logger.info(f"Download request for task {task_id}. File: {actual_disk_filename}, As: {user_download_name}")
    try:
        return send_from_directory(
            directory=app.config['PROCESSED_FOLDER'],
            path=actual_disk_filename,
            as_attachment=True,
            download_name=user_download_name
        )
    except FileNotFoundError:
        app.logger.error(f"Processed file not found on disk for task {task_id} at {task_row['output_path']}")
        update_task_in_db(task_id, status='failed', message='Error: Processed file missing on server.')
        return jsonify({'error': 'Processed file could not be found on the server.'}), 404
    except Exception as e:
        app.logger.error(f"Error during download for task {task_id}: {e}", exc_info=True)
        return jsonify({'error': f'An unexpected error occurred during download.'}), 500


def cleanup_old_tasks():
    while True:
        time.sleep(3600)
        app.logger.info("Running hourly cleanup task...")
        conn = None
        deleted_count = 0
        try:
            conn = get_db_connection()
            cursor = conn.cursor()
            two_hours_ago = time.time() - (2 * 60 * 60)

            cursor.execute("""
                SELECT task_id, input_path, output_path FROM task_status
                WHERE status IN ('completed', 'failed') AND timestamp_last_updated < ?
            """, (two_hours_ago,))
            tasks_to_remove = cursor.fetchall()

            if not tasks_to_remove:
                app.logger.info("Cleanup: No old tasks met criteria for removal.")
                if conn: conn.close()
                continue

            for task_row in tasks_to_remove:
                task_id = task_row['task_id']
                paths_to_clean = [task_row['input_path'], task_row['output_path']]
                for file_path in paths_to_clean:
                    if file_path and os.path.exists(file_path):
                        try:
                            os.remove(file_path)
                            app.logger.info(f"Cleanup: Removed old file: {file_path} for task {task_id}")
                        except OSError as e:
                            app.logger.error(f"Cleanup: Error removing file {file_path} for task {task_id}: {e}")

                cursor.execute("DELETE FROM task_status WHERE task_id = ?", (task_id,))
                deleted_count += 1
                app.logger.info(f"Cleanup: Removed old task entry: {task_id}")

            conn.commit()
            if deleted_count > 0:
                app.logger.info(f"Cleanup finished. Removed {deleted_count} old task entries and their files.")
            else:
                app.logger.info("Cleanup finished. No tasks were deleted in this run, or selected tasks had files already cleaned.")

        except sqlite3.Error as e:
            app.logger.error(f"Cleanup: Database error during cleanup: {e}", exc_info=True)
        except Exception as e:
            app.logger.error(f"Cleanup: General error during cleanup: {e}", exc_info=True)
        finally:
            if conn:
                conn.close()

if __name__ == '__main__':
    init_db()

    cleanup_thread = threading.Thread(target=cleanup_old_tasks, daemon=True, name="CleanupThread")
    cleanup_thread.start()
    app.logger.info("Cleanup thread started.")

    app.logger.info("Starting Flask development server...")
    app.run(debug=True, host='0.0.0.0', port=7001, threaded=True)
else:
    init_db()
    if os.environ.get("WERKZEUG_RUN_MAIN") != "true": # Avoid running twice with Werkzeug reloader
        if not hasattr(app, '_cleanup_thread_started_gunicorn'): # Ensure only one thread per worker
            cleanup_thread_gunicorn = threading.Thread(target=cleanup_old_tasks, daemon=True, name="CleanupThread-Gunicorn")
            cleanup_thread_gunicorn.start()
            app._cleanup_thread_started_gunicorn = True
            app.logger.info("Cleanup thread started in Gunicorn worker context.")