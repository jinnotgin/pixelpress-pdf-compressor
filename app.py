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
app.logger.handlers.clear() # Clear default Flask handlers if any
for handler in logging.getLogger().handlers: # Apply format to root logger handlers
    handler.setFormatter(logging.Formatter('%(asctime)s - %(levelname)s - %(threadName)s - %(message)s'))
app.logger.setLevel(logging.INFO)


# Ensure upload and processed directories exist
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(PROCESSED_FOLDER, exist_ok=True)

# --- SQLite Database Setup ---
def get_db_connection():
    conn = sqlite3.connect(DATABASE_FILE, timeout=10) # Increased timeout
    conn.row_factory = sqlite3.Row  # Access columns by name
    return conn

def init_db():
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
                timestamp_created REAL NOT NULL,
                timestamp_last_updated REAL
            )
        ''')
        conn.commit()
        app.logger.info("Database initialized successfully.")
    except sqlite3.Error as e:
        app.logger.error(f"Database initialization error: {e}", exc_info=True)
    finally:
        if conn:
            conn.close()

# --- ThreadPoolExecutor for background tasks ---
MAX_PDF_WORKERS = int(os.environ.get("MAX_PDF_WORKERS", os.cpu_count() or 2))
app.logger.info(f"Initializing PDF processor with {MAX_PDF_WORKERS} max workers.")
pdf_processor_executor = ThreadPoolExecutor(max_workers=MAX_PDF_WORKERS, thread_name_prefix="PDFWorker")


def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

def update_task_in_db(task_id, status=None, message=None, progress=None, user_facing_output_filename_val=None):
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
        if user_facing_output_filename_val is not None: # Only on completion usually
            fields_to_update.append("user_facing_output_filename = ?")
            params.append(user_facing_output_filename_val)

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

def rasterize_pdf_to_new_pdf_web(task_id, input_pdf_path, output_pdf_path, dpi, original_filename_for_naming):
    app.logger.info(f"Task {task_id} ({original_filename_for_naming}) starting rasterization. DPI: {dpi}. Thread: {threading.current_thread().name}")

    # Determine the user-facing output name (can also be fetched if stored during upload)
    user_facing_output_filename = f"Compressed_{original_filename_for_naming}"

    update_task_in_db(task_id, status='processing', message='Preparing: Opening your PDF...', progress=5)

    input_doc = None
    output_doc = None

    try:
        if not os.path.exists(input_pdf_path):
            update_task_in_db(task_id, status='failed', message="Error: Input PDF was not found on server.")
            app.logger.error(f"Task {task_id}: Input PDF {input_pdf_path} not found.")
            return False

        input_doc = fitz.open(input_pdf_path)
        output_doc = fitz.open()
        num_pages = len(input_doc)

        if num_pages == 0:
            output_doc.save(output_pdf_path, garbage=4, deflate=True) # Save empty PDF
            update_task_in_db(task_id, status='completed',
                              message="Input PDF has no pages. An empty processed PDF has been created.",
                              progress=100, user_facing_output_filename_val=user_facing_output_filename)
            app.logger.info(f"Task {task_id}: Input PDF has no pages. Empty PDF created.")
            return True

        update_task_in_db(task_id, message=f"Processing: Analyzing {num_pages} pages...", progress=10)

        for page_num in range(num_pages):
            current_page_progress = int(80 * ((page_num + 1) / num_pages))
            update_task_in_db(task_id, progress=(10 + current_page_progress),
                              message=f"Rasterizing: Page {page_num + 1} of {num_pages} at {dpi} DPI...")
            
            try:
                page = input_doc.load_page(page_num)
                zoom = dpi / 72.0
                matrix = fitz.Matrix(zoom, zoom)
                pix = page.get_pixmap(matrix=matrix, alpha=False)
                page_width_pt = pix.width * 72.0 / dpi
                page_height_pt = pix.height * 72.0 / dpi
                new_page = output_doc.new_page(width=page_width_pt, height=page_height_pt)
                new_page.insert_image(new_page.rect, pixmap=pix)
                pix = None 
                page.clean_contents()
                page = None 
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
        output_doc.save(output_pdf_path, garbage=4, deflate=True, linear=True)
        
        update_task_in_db(task_id, status='completed',
                          message=f"Success! Your PDF '{user_facing_output_filename}' is ready for download.",
                          progress=100, user_facing_output_filename_val=user_facing_output_filename)
        app.logger.info(f"Task {task_id} ({original_filename_for_naming}) completed successfully.")
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
        
        if os.path.exists(input_pdf_path):
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
            
        server_input_filename = f"{task_id}_{original_filename_secure}"
        server_output_filename = f"{task_id}_processed.pdf"
        input_pdf_path = os.path.join(app.config['UPLOAD_FOLDER'], server_input_filename)
        output_pdf_path = os.path.join(app.config['PROCESSED_FOLDER'], server_output_filename)
        
        # This will be used for the final download name and message construction
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
            cursor.execute("""
                INSERT INTO task_status (task_id, status, message, progress, input_path, output_path, 
                                         original_filename, user_facing_output_filename, dpi, 
                                         timestamp_created, timestamp_last_updated)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (task_id, 'queued', 'File received. Queued for processing.', 0, input_pdf_path, output_pdf_path,
                  original_filename_secure, user_facing_dl_name, dpi, current_time, current_time))
            conn.commit()
        except sqlite3.Error as e:
            app.logger.error(f"DB Error creating task {task_id}: {e}", exc_info=True)
            # Cleanup saved file if DB insert fails
            if os.path.exists(input_pdf_path): os.remove(input_pdf_path)
            return jsonify({'error': 'Failed to queue task due to a database error.'}), 500
        finally:
            if conn:
                conn.close()

        pdf_processor_executor.submit(rasterize_pdf_to_new_pdf_web, task_id, input_pdf_path, output_pdf_path, dpi, original_filename_secure)
        app.logger.info(f"Task {task_id} ({original_filename_secure}) submitted for processing.")
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
    
    task_dict = dict(task_row)
    # Map user_facing_output_filename to output_filename for API consistency with previous versions
    if 'user_facing_output_filename' in task_dict:
        task_dict['output_filename'] = task_dict.pop('user_facing_output_filename')
    else:
        task_dict['output_filename'] = None # Ensure key exists if original was None

    return jsonify(task_dict)

@app.route('/download/<task_id>')
def download_file_route(task_id): # Renamed to avoid conflict with built-in `download_file`
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
        return jsonify({'error': 'File is not yet ready or processing failed.'}), 400 # 400 Bad Request
        
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
        # This could also mean the output_path in DB is stale after a manual file deletion
        update_task_in_db(task_id, status='failed', message='Error: Processed file missing on server.')
        return jsonify({'error': 'Processed file could not be found on the server.'}), 404
    except Exception as e:
        app.logger.error(f"Error during download for task {task_id}: {e}", exc_info=True)
        return jsonify({'error': f'An unexpected error occurred during download.'}), 500


def cleanup_old_tasks():
    while True:
        time.sleep(3600) # Run every hour
        app.logger.info("Running hourly cleanup task...")
        conn = None
        deleted_count = 0
        try:
            conn = get_db_connection()
            cursor = conn.cursor()
            two_hours_ago = time.time() - 7200
            
            # Find tasks to clean up
            cursor.execute("""
                SELECT task_id, input_path, output_path FROM task_status
                WHERE status IN ('completed', 'failed') AND timestamp_last_updated < ?
            """, (two_hours_ago,))
            tasks_to_remove = cursor.fetchall()

            if not tasks_to_remove:
                app.logger.info("Cleanup: No old tasks met criteria for removal.")
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
                
                # Delete from DB
                cursor.execute("DELETE FROM task_status WHERE task_id = ?", (task_id,))
                deleted_count += 1
                app.logger.info(f"Cleanup: Removed old task entry: {task_id}")
            
            conn.commit()
            if deleted_count > 0:
                app.logger.info(f"Cleanup finished. Removed {deleted_count} old task entries and their files.")
            else:
                app.logger.info("Cleanup finished. No tasks were actually deleted in this run (might have been cleaned already).")

        except sqlite3.Error as e:
            app.logger.error(f"Cleanup: Database error during cleanup: {e}", exc_info=True)
        except Exception as e:
            app.logger.error(f"Cleanup: General error during cleanup: {e}", exc_info=True)
        finally:
            if conn:
                conn.close()

if __name__ == '__main__':
    init_db() # Initialize DB (create table if not exists)
    
    cleanup_thread = threading.Thread(target=cleanup_old_tasks, daemon=True, name="CleanupThread")
    cleanup_thread.start()
    app.logger.info("Cleanup thread started.")

    app.logger.info("Starting Flask development server...")
    app.run(debug=True, host='0.0.0.0', port=7001, threaded=True) # threaded=True for dev server
else:
    # This block runs when Gunicorn (or another WSGI server) imports the app
    init_db() 
    # You might want to start the cleanup thread here too,
    # but ensure it only runs in one process if Gunicorn forks.
    # A common pattern for Gunicorn is to start such threads in the `post_fork` server hook,
    # but for simplicity, if only one Gunicorn worker is used or the cleanup is idempotent,
    # starting it here might be acceptable. For multiple workers and non-idempotent cleanup,
    # a dedicated scheduler or external cron job is better for the cleanup task.
    # For now, let's assume Gunicorn might start it or rely on dev mode.
    # If you run with multiple gunicorn workers, each might try to run this thread.
    # A simple way to avoid multiple cleanup threads with Gunicorn:
    if os.environ.get("WERKZEUG_RUN_MAIN") != "true": # Prevents reloader from starting it twice in dev
        # Only start cleanup if not already running (e.g., check a global flag or specific Gunicorn worker)
        # This can be tricky with Gunicorn. A robust solution uses an external scheduler
        # or Gunicorn's master process if possible (though Gunicorn hooks are preferred).
        # For this example, we'll start it, but be mindful of multiple instances with multiple workers.
        # One simple check (not foolproof for all Gunicorn setups):
        if not hasattr(app, '_cleanup_thread_started'):
            cleanup_thread = threading.Thread(target=cleanup_old_tasks, daemon=True, name="CleanupThread-Gunicorn")
            cleanup_thread.start()
            app._cleanup_thread_started = True
            app.logger.info("Cleanup thread started in Gunicorn worker.")