#!/usr/bin/env python3

import sys # Ensure sys is imported
import fitz  # PyMuPDF
import os
import math
import uuid
import threading
import time
import logging
import sqlite3 # For SQLite database
import tempfile # For temporary directory management
from flask import Flask, request, jsonify, render_template, send_from_directory, url_for
from werkzeug.utils import secure_filename
from concurrent.futures import ThreadPoolExecutor

# Attempt to import Pillow (PIL)
try:
    from PIL import Image
except ImportError:
    Image = None
    logging.warning("Pillow library not found. Combined image output target will not be available. Please install Pillow: pip install Pillow")

# --- Path Configuration for PyInstaller ---
def get_base_path():
    if getattr(sys, 'frozen', False) and hasattr(sys, '_MEIPASS'):
        return sys._MEIPASS
    else:
        return os.path.dirname(os.path.abspath(__file__))

BUNDLE_DIR = get_base_path()

app = Flask(__name__,
            template_folder=os.path.join(BUNDLE_DIR, 'templates'),
            static_folder=os.path.join(BUNDLE_DIR, 'static')
           )

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
                page_raster_format TEXT,
                jpeg_quality INTEGER,
                output_target_format TEXT,
                original_size_bytes INTEGER,
                processed_size_bytes INTEGER,
                timestamp_created REAL NOT NULL,
                timestamp_last_updated REAL
            )
        ''')
        conn.commit()

        table_info = cursor.execute("PRAGMA table_info(task_status);").fetchall()
        column_names = [info['name'] for info in table_info]

        migrations = {
            'original_size_bytes': "ALTER TABLE task_status ADD COLUMN original_size_bytes INTEGER;",
            'processed_size_bytes': "ALTER TABLE task_status ADD COLUMN processed_size_bytes INTEGER;",
            'output_target_format': "ALTER TABLE task_status ADD COLUMN output_target_format TEXT;",
        }
        
        if 'image_format' in column_names and 'page_raster_format' not in column_names:
            try:
                cursor.execute("ALTER TABLE task_status ADD COLUMN page_raster_format TEXT;")
                conn.commit()
                app.logger.info("Added 'page_raster_format' column to task_status table. If old 'image_format' column exists, it is now legacy.")
            except sqlite3.Error as e_alter:
                if "duplicate column name" not in str(e_alter).lower():
                    app.logger.error(f"Error adding 'page_raster_format' column: {e_alter}")

        for col_name, alter_sql in migrations.items():
            if col_name not in column_names:
                try:
                    cursor.execute(alter_sql)
                    conn.commit()
                    app.logger.info(f"Added '{col_name}' column to task_status table.")
                except sqlite3.Error as e_alter:
                    app.logger.error(f"Error adding '{col_name}' column: {e_alter}")
        
        app.logger.info("Database initialized successfully.")
    except sqlite3.Error as e:
        app.logger.error(f"Database initialization error: {e}", exc_info=True)
    finally:
        if conn:
            conn.close()

# Calculate half of the available CPU cores, rounded down
# half_cpu_count = math.floor((os.cpu_count() or 2) / 2)

MAX_PDF_WORKERS = int(os.environ.get("MAX_PDF_WORKERS", os.cpu_count() or 2))
app.logger.info(f"Initializing PDF processor with {MAX_PDF_WORKERS} max workers.")
pdf_processor_executor = ThreadPoolExecutor(max_workers=MAX_PDF_WORKERS, thread_name_prefix="PDFWorker")


def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

def update_task_in_db(task_id, status=None, message=None, progress=None,
                      original_size_bytes_val=None, processed_size_bytes_val=None):
    conn = None
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        fields_to_update = []
        params = []

        if status is not None: fields_to_update.append("status = ?"); params.append(status)
        if message is not None: fields_to_update.append("message = ?"); params.append(message)
        if progress is not None: fields_to_update.append("progress = ?"); params.append(progress)
        if original_size_bytes_val is not None: fields_to_update.append("original_size_bytes = ?"); params.append(original_size_bytes_val)
        if processed_size_bytes_val is not None: fields_to_update.append("processed_size_bytes = ?"); params.append(processed_size_bytes_val)

        if not fields_to_update: return

        fields_to_update.append("timestamp_last_updated = ?"); params.append(time.time())
        query = f"UPDATE task_status SET {', '.join(fields_to_update)} WHERE task_id = ?"; params.append(task_id)
        cursor.execute(query, tuple(params))
        conn.commit()
    except sqlite3.Error as e:
        app.logger.error(f"DB Error updating task {task_id}: {e}", exc_info=True)
    finally:
        if conn: conn.close()

def process_pdf_task(task_id, input_pdf_path, output_file_path, dpi,
                     original_input_filename, 
                     page_raster_format, jpeg_raster_quality,
                     output_target_format):
    app.logger.info(
        f"Task {task_id} ({original_input_filename}) starting processing. Target: {output_target_format.upper()}. "
        f"DPI: {dpi}, Page Raster Format: {page_raster_format}, "
        f"JPEG Quality: {jpeg_raster_quality if page_raster_format == 'jpeg' else 'N/A'}. "
        f"Thread: {threading.current_thread().name}"
    )
    update_task_in_db(task_id, status='processing', message='Preparing: Opening your PDF...', progress=5)

    original_size = None
    processed_size = None
    input_doc = None
    output_doc_for_pdf = None # Only for PDF output

    # tempfile.TemporaryDirectory provides a context manager for auto-cleanup
    with tempfile.TemporaryDirectory(prefix=f"pdftask_{task_id}_") as temp_processing_dir:
        app.logger.info(f"Task {task_id}: Using temporary directory {temp_processing_dir} for intermediate files.")
        temp_image_files_for_stitching = [] # Stores paths to individual page images for Pillow

        try:
            if not os.path.exists(input_pdf_path):
                update_task_in_db(task_id, status='failed', message="Error: Input PDF was not found on server.")
                app.logger.error(f"Task {task_id}: Input PDF {input_pdf_path} not found.")
                return False

            try:
                if os.path.exists(input_pdf_path): original_size = os.path.getsize(input_pdf_path)
            except OSError as e:
                app.logger.warning(f"Task {task_id}: Could not get size of input file {input_pdf_path}: {e}")

            input_doc = fitz.open(input_pdf_path)
            num_pages = len(input_doc)

            if num_pages == 0:
                # Handle 0-page PDF based on output target
                if output_target_format == 'pdf':
                    output_doc_for_pdf = fitz.open()
                    output_doc_for_pdf.save(output_file_path, garbage=4, deflate=True, clean=True)
                    if os.path.exists(output_file_path): processed_size = os.path.getsize(output_file_path)
                    update_task_in_db(task_id, status='completed',
                                      message="Input PDF has no pages. An empty processed PDF has been created.",
                                      progress=100, original_size_bytes_val=original_size,
                                      processed_size_bytes_val=processed_size)
                elif output_target_format == 'image':
                    update_task_in_db(task_id, status='failed',
                                      message="Input PDF has no pages. Cannot create a combined image.",
                                      progress=100, original_size_bytes_val=original_size)
                return True # Task is "handled" whether success or "valid" fail

            if output_target_format == 'image' and not Image:
                update_task_in_db(task_id, status='failed', message="Image processing library (Pillow) not available on server.")
                app.logger.error(f"Task {task_id}: Pillow not installed, cannot create combined image target.")
                return False

            update_task_in_db(task_id, message=f"Processing: Analyzing {num_pages} pages...", progress=10)

            if output_target_format == 'pdf':
                output_doc_for_pdf = fitz.open()

            for page_num in range(num_pages):
                current_page_progress = int(80 * ((page_num + 1) / num_pages))
                update_task_in_db(task_id, progress=(10 + current_page_progress),
                                  message=f"Rasterizing: Page {page_num + 1} of {num_pages} as {page_raster_format.upper()} at {dpi} DPI...")
                
                page_instance = None
                pix_map = None
                try:
                    page_instance = input_doc.load_page(page_num)
                    zoom = dpi / 72.0
                    matrix = fitz.Matrix(zoom, zoom)
                    pix_map = page_instance.get_pixmap(matrix=matrix, alpha=False) # RGB, no alpha

                    if output_target_format == 'pdf':
                        page_width_pt = pix_map.width * 72.0 / dpi
                        page_height_pt = pix_map.height * 72.0 / dpi
                        new_page = output_doc_for_pdf.new_page(width=page_width_pt, height=page_height_pt)
                        
                        save_args = {"output": page_raster_format}
                        if page_raster_format == 'jpeg': save_args["jpg_quality"] = jpeg_raster_quality
                        
                        try:
                            image_bytes_for_pdf_page = pix_map.tobytes(**save_args)
                            new_page.insert_image(new_page.rect, stream=image_bytes_for_pdf_page)
                        except Exception as img_e:
                            app.logger.warning(f"Task {task_id}: Failed to convert page {page_num+1} to {page_raster_format} stream for PDF, fallback to pixmap. Error: {img_e}")
                            new_page.insert_image(new_page.rect, pixmap=pix_map)

                    elif output_target_format == 'image':
                        temp_page_filename = f"page_{page_num:04d}.{page_raster_format}"
                        temp_page_filepath = os.path.join(temp_processing_dir, temp_page_filename)
                        try:
                            # PyMuPDF's pix.save infers format from extension
                            if page_raster_format == 'jpeg':
                                pix_map.save(temp_page_filepath, jpg_quality=jpeg_raster_quality)
                            else: # png
                                pix_map.save(temp_page_filepath)
                            temp_image_files_for_stitching.append(temp_page_filepath)
                        except Exception as e_save_temp_img:
                            error_msg = f"Error saving temp image for page {page_num + 1}: {str(e_save_temp_img)[:100]}"
                            update_task_in_db(task_id, status='failed', message=error_msg)
                            app.logger.error(f"Task {task_id}: {error_msg}", exc_info=True)
                            return False # Temp dir will be auto-cleaned

                except Exception as e_page:
                    error_msg = f"Error processing page {page_num + 1}: {str(e_page)[:100]}..."
                    update_task_in_db(task_id, status='failed', message=error_msg)
                    app.logger.error(f"Task {task_id} failed on page {page_num + 1}: {e_page}", exc_info=True)
                    if os.path.exists(output_file_path): # Try to remove partially created final output
                        try: os.remove(output_file_path)
                        except OSError: pass
                    return False # Temp dir will be auto-cleaned
                finally:
                    if pix_map: pix_map = None
                    if page_instance: page_instance.clean_contents(); page_instance = None
            
            # --- Post-page-loop processing ---
            if output_target_format == 'pdf':
                update_task_in_db(task_id, progress=95, message="Finalizing: Compiling and saving your new PDF...")
                output_doc_for_pdf.save(output_file_path, garbage=4, deflate=True, deflate_images=True, clean=True)

            elif output_target_format == 'image':
                if not temp_image_files_for_stitching:
                    update_task_in_db(task_id, status='failed', message="Error: No page images were created for stitching.")
                    app.logger.error(f"Task {task_id}: No temporary image files available for stitching.")
                    return False

                update_task_in_db(task_id, progress=95, message="Finalizing: Stitching page images with Pillow...")
                
                pil_page_images = []
                final_image_pil = None
                try:
                    actual_max_width = 0
                    actual_total_height = 0
                    for i, temp_file_path in enumerate(temp_image_files_for_stitching):
                        update_task_in_db(task_id, message=f"Stitching: Loading image of page {i + 1}...")
                        img = Image.open(temp_file_path)
                        pil_page_images.append(img)
                        actual_max_width = max(actual_max_width, img.width)
                        actual_total_height += img.height
                    
                    if actual_max_width == 0 or actual_total_height == 0:
                        update_task_in_db(task_id, status='failed', message="Error: Calculated image dimensions are zero after loading pages.")
                        app.logger.error(f"Task {task_id}: Stitching error, final image dimensions zero.")
                        return False

                    final_image_pil = Image.new('RGB', (actual_max_width, actual_total_height), (255, 255, 255)) # White background
                    current_y_offset = 0
                    for i, pil_img_to_paste in enumerate(pil_page_images):
                        update_task_in_db(task_id, message=f"Stitching: Pasting image of page {i + 1}...")
                        final_image_pil.paste(pil_img_to_paste, (0, current_y_offset))
                        current_y_offset += pil_img_to_paste.height
                    
                    # Pillow's save format is determined by output_file_path extension.
                    # Ensure output_file_path has the correct extension (jpeg/png)
                    save_params_pil = {}
                    if page_raster_format == 'jpeg':
                        save_params_pil['quality'] = jpeg_raster_quality
                        save_params_pil['optimize'] = True # Good for JPEGs
                    
                    final_image_pil.save(output_file_path, **save_params_pil)

                except Exception as e_stitch_pil:
                    error_msg = f"Error stitching/saving final image: {str(e_stitch_pil)[:100]}..."
                    update_task_in_db(task_id, status='failed', message=error_msg)
                    app.logger.error(f"Task {task_id}: Failed during Pillow stitching/saving: {e_stitch_pil}", exc_info=True)
                    if os.path.exists(output_file_path): # Try remove partial
                        try: os.remove(output_file_path)
                        except OSError: pass
                    return False
                finally:
                    if final_image_pil:
                        try: final_image_pil.close()
                        except Exception: pass
                    for img_obj in pil_page_images:
                        try: img_obj.close()
                        except Exception: pass
                    # temp_image_files_for_stitching are in temp_processing_dir, which is auto-cleaned

            # --- Final steps for success ---
            try:
                if os.path.exists(output_file_path): processed_size = os.path.getsize(output_file_path)
            except OSError as e:
                app.logger.warning(f"Task {task_id}: Could not get size of output file {output_file_path}: {e}")

            update_task_in_db(task_id, status='completed',
                              message="Success! Your processed file is ready for download.",
                              progress=100, original_size_bytes_val=original_size,
                              processed_size_bytes_val=processed_size)
            app.logger.info(f"Task {task_id} ({original_input_filename}) completed successfully. Target: {output_target_format.upper()}. Original: {original_size} bytes, Processed: {processed_size} bytes.")
            return True

        except Exception as e_main:
            crit_error_msg = f"Critical error during processing: {str(e_main)[:100]}..."
            update_task_in_db(task_id, status='failed', message=crit_error_msg)
            app.logger.error(f"Task {task_id} critical error: {e_main}", exc_info=True)
            if os.path.exists(output_file_path): # Try remove partial
                try: os.remove(output_file_path)
                except OSError: pass
            return False
        finally:
            if input_doc:
                try: input_doc.close()
                except Exception as e_close: app.logger.warning(f"Task {task_id}: Error closing input_doc: {e_close}")
            if output_doc_for_pdf:
                try: output_doc_for_pdf.close()
                except Exception as e_close: app.logger.warning(f"Task {task_id}: Error closing output_doc_for_pdf: {e_close}")
            
            # The temp_processing_dir and its contents (temp_image_files_for_stitching)
            # are automatically removed when the 'with' block exits.

            # Original input PDF cleanup (moved outside the 'with' block to ensure it runs after temp dir is gone)
            # if os.path.exists(input_pdf_path): # This is already done by the caller or another finally
            #     try:
            #         os.remove(input_pdf_path)
            #         app.logger.info(f"Cleaned up input file: {input_pdf_path} for task {task_id}")
            #     except OSError as e:
            #         app.logger.warning(f"Could not remove input file {input_pdf_path} for task {task_id}: {e}")

    # End of 'with tempfile.TemporaryDirectory()' context manager
    # Now, cleanup the input PDF file from the UPLOAD_FOLDER
    if os.path.exists(input_pdf_path): 
        try:
            os.remove(input_pdf_path)
            app.logger.info(f"Cleaned up input file: {input_pdf_path} for task {task_id} (post-processing).")
        except OSError as e:
            app.logger.warning(f"Could not remove input file {input_pdf_path} for task {task_id} (post-processing): {e}")


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
            dpi = int(request.form.get('dpi', '72'))
            if not (10 <= dpi <= 600): dpi = 72
        except ValueError: dpi = 72

        page_raster_format = request.form.get('image_format', 'jpeg').lower()
        if page_raster_format not in ['jpeg', 'png']: page_raster_format = 'jpeg'

        jpeg_quality_val = 75
        if page_raster_format == 'jpeg':
            try:
                jpeg_quality_val = int(request.form.get('jpeg_quality', '75'))
                if not (1 <= jpeg_quality_val <= 100): jpeg_quality_val = 75
            except ValueError: jpeg_quality_val = 75
        else:
            jpeg_quality_val = None 

        output_target_format = request.form.get('output_target_format', 'pdf').lower()
        if output_target_format not in ['pdf', 'image']: output_target_format = 'pdf'
        
        if output_target_format == 'image' and not Image:
            app.logger.error(f"Task {task_id} ({original_filename_secure}) requested combined image, but Pillow is not installed.")
            return jsonify({'error': 'Server configuration error: Image processing library (Pillow) is not available. Cannot create combined image.'}), 503


        server_input_filename = f"{task_id}_{original_filename_secure}"
        input_pdf_path = os.path.join(app.config['UPLOAD_FOLDER'], server_input_filename)

        original_basename = os.path.splitext(original_filename_secure)[0]
        user_facing_dl_name = ""
        if output_target_format == 'pdf':
            server_output_filename = f"{task_id}_processed.pdf"
            user_facing_dl_name = f"Compressed_{original_basename}.pdf"
        elif output_target_format == 'image':
            image_ext = page_raster_format # 'jpeg' or 'png'
            server_output_filename = f"{task_id}_combined_image.{image_ext}"
            user_facing_dl_name = f"Combined_Pages_{original_basename}.{image_ext}"
        
        output_path = os.path.join(app.config['PROCESSED_FOLDER'], server_output_filename)

        try:
            file.save(input_pdf_path)
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
                                         page_raster_format, jpeg_quality, output_target_format,
                                         timestamp_created, timestamp_last_updated)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (task_id, 'queued', 'File received. Queued for processing.', 0, input_pdf_path, output_path,
                  original_filename_secure, user_facing_dl_name, dpi,
                  page_raster_format, jpeg_quality_val, output_target_format,
                  current_time, current_time))
            conn.commit()
        except sqlite3.Error as e:
            app.logger.error(f"DB Error creating task {task_id}: {e}", exc_info=True)
            if os.path.exists(input_pdf_path):
                try: os.remove(input_pdf_path)
                except OSError: pass
            return jsonify({'error': 'Failed to queue task due to a database error.'}), 500
        finally:
            if conn: conn.close()

        pdf_processor_executor.submit(process_pdf_task, task_id, input_pdf_path,
                                      output_path, dpi, original_filename_secure,
                                      page_raster_format, jpeg_quality_val, output_target_format)
        app.logger.info(f"Task {task_id} ({original_filename_secure}) submitted for processing. Target: {output_target_format.upper()}, Page Raster: {page_raster_format.upper()}.")
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
        if conn: conn.close()

    if not task_row:
        return jsonify({'status': 'not_found', 'message': 'Task ID not found or has been cleaned up.'}), 404

    task_dict = dict(task_row)
    task_dict['output_filename'] = task_dict.get('user_facing_output_filename', None)
    if 'image_format' in task_dict and 'page_raster_format' not in task_dict:
        task_dict['page_raster_format'] = task_dict.pop('image_format')
    return jsonify(task_dict)

@app.route('/download/<task_id>')
def download_file_route(task_id):
    conn = None
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT status, output_path, user_facing_output_filename, message FROM task_status WHERE task_id = ?", (task_id,))
        task_row = cursor.fetchone()
    except sqlite3.Error as e:
        return jsonify({'error': 'Error preparing file for download.'}), 500
    finally:
        if conn: conn.close()

    if not task_row: return jsonify({'error': 'Task not found or has been cleaned up.'}), 404

    if task_row['status'] != 'completed':
        msg = task_row['message'] if task_row['message'] else 'File is not yet ready or processing failed.'
        if task_row['status'] == 'failed' and "Cannot create a combined image" in msg: # 0-page specific
            return jsonify({'error': msg}), 400
        return jsonify({'error': 'File is not yet ready or processing failed.'}), 400

    if not task_row['user_facing_output_filename'] or not task_row['output_path']:
        return jsonify({'error': 'Output file details incomplete for completed task.'}), 500
    
    actual_disk_filename = os.path.basename(task_row['output_path'])
    user_download_name = task_row['user_facing_output_filename']
    processed_file_full_path = os.path.join(app.config['PROCESSED_FOLDER'], actual_disk_filename)

    if not os.path.exists(processed_file_full_path):
        update_task_in_db(task_id, status='failed', message='Error: Processed file missing on server.')
        return jsonify({'error': 'Processed file could not be found (it may have been cleaned up or an error occurred).'}), 404

    try:
        return send_from_directory(
            directory=app.config['PROCESSED_FOLDER'],
            path=actual_disk_filename,
            as_attachment=True,
            download_name=user_download_name
        )
    except Exception as e:
        app.logger.error(f"Error during download for task {task_id}: {e}", exc_info=True)
        return jsonify({'error': f'An unexpected error occurred during download.'}), 500


def cleanup_old_tasks():
    while True:
        time.sleep(3600) 
        app.logger.info("Running hourly cleanup task...")
        conn = None
        try:
            conn = get_db_connection()
            cursor = conn.cursor()
            cleanup_threshold_seconds = float(os.environ.get("CLEANUP_AFTER_HOURS", 2)) * 3600
            older_than_timestamp = time.time() - cleanup_threshold_seconds

            cursor.execute("""
                SELECT task_id, input_path, output_path FROM task_status
                WHERE status IN ('completed', 'failed') AND timestamp_last_updated < ?
            """, (older_than_timestamp,))
            tasks_to_remove = cursor.fetchall()

            deleted_count = 0
            if not tasks_to_remove:
                app.logger.info("Cleanup: No old tasks met criteria for removal.")
            else:
                for task_row in tasks_to_remove:
                    task_id = task_row['task_id']
                    # Input path already cleaned by process_pdf_task itself
                    paths_to_clean = filter(None, [task_row['output_path']]) # Only output_path needs explicit cleanup here

                    for file_path in paths_to_clean:
                        if os.path.exists(file_path): 
                            try:
                                os.remove(file_path)
                                app.logger.info(f"Cleanup: Removed old file: {file_path} for task {task_id}")
                            except OSError as e:
                                app.logger.error(f"Cleanup: Error removing file {file_path} for task {task_id}: {e}")
                        else:
                            app.logger.info(f"Cleanup: File {file_path} for task {task_id} already removed or never existed.")

                    cursor.execute("DELETE FROM task_status WHERE task_id = ?", (task_id,))
                    deleted_count += cursor.rowcount 
                    if cursor.rowcount > 0:
                        app.logger.info(f"Cleanup: Removed old task entry: {task_id}")
                conn.commit()
            
            if deleted_count > 0:
                app.logger.info(f"Cleanup finished. Removed {deleted_count} old task entries and their associated output files.")
            elif tasks_to_remove: # Tasks were found, but maybe no DB rows deleted (e.g., if commit failed before)
                 app.logger.info("Cleanup finished. Processed tasks but no DB entries were deleted in this pass (check logs for details).")
            else: # No tasks found to remove
                app.logger.info("Cleanup finished. No tasks eligible for removal.")


        except sqlite3.Error as e:
            app.logger.error(f"Cleanup: Database error during cleanup: {e}", exc_info=True)
        except Exception as e:
            app.logger.error(f"Cleanup: General error during cleanup: {e}", exc_info=True)
        finally:
            if conn: conn.close()

if __name__ == '__main__':
    init_db()
    if Image is None:
        app.logger.warning("Pillow library is not installed. Functionality to output combined images will be disabled.")
    
    cleanup_thread = threading.Thread(target=cleanup_old_tasks, daemon=True, name="CleanupThread")
    cleanup_thread.start()
    app.logger.info("Cleanup thread started.")

    app.logger.info("Starting Flask development server...")
    app.run(debug=False, host='0.0.0.0', port=7001, threaded=True) 
else: 
    init_db()
    if Image is None and os.environ.get("WERKZEUG_RUN_MAIN") != "true": # Log once per gunicorn worker start typically
        app.logger.warning("Pillow library is not installed. Functionality to output combined images will be disabled in this worker.")

    if os.environ.get("WERKZEUG_RUN_MAIN") != "true": 
        if not hasattr(app, '_cleanup_thread_started_gunicorn_process'):
            cleanup_thread_gunicorn = threading.Thread(target=cleanup_old_tasks, daemon=True, name=f"CleanupThread-GunicornPID-{os.getpid()}")
            cleanup_thread_gunicorn.start()
            app._cleanup_thread_started_gunicorn_process = True
            app.logger.info(f"Cleanup thread started in Gunicorn worker process PID {os.getpid()}.")