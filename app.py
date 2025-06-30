#!/usr/bin/env python3

import gc
import sys
import fitz  # PyMuPDF
import os
import math
import uuid
import threading
import time
import logging
import sqlite3
import tempfile
from flask import Flask, request, jsonify, render_template, send_from_directory, abort
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
app.config['MAX_CONTENT_LENGTH'] = 250 * 1024 * 1024  # 250 MB limit

# Setup logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(threadName)s - %(message)s')
app.logger.handlers.clear()
for handler in logging.getLogger().handlers:
    handler.setFormatter(logging.Formatter('%(asctime)s - %(levelname)s - %(threadName)s - %(message)s'))
app.logger.setLevel(logging.INFO)

# --- Tiling Configuration ---
try:
    TILE_SIZE_PX = int(os.environ.get("PDF_TILE_SIZE_PX", "9600"))
    if TILE_SIZE_PX < 1024:
        logging.warning(f"PDF_TILE_SIZE_PX is set to a low value ({TILE_SIZE_PX}). Clamping to minimum of 1024.")
        TILE_SIZE_PX = 1024
except (ValueError, TypeError):
    logging.warning("Invalid value for PDF_TILE_SIZE_PX environment variable. Using default 9600.")
    TILE_SIZE_PX = 9600
logging.info(f"Using tile size of {TILE_SIZE_PX}px for PDF rasterization.")


os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(PROCESSED_FOLDER, exist_ok=True)

# --- SQLite Database Setup ---
def get_db_connection():
    conn = sqlite3.connect(DATABASE_FILE, timeout=10, check_same_thread=False)
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
                timestamp_last_updated REAL,
                cancellation_requested INTEGER DEFAULT 0,
                worker_pid INTEGER,
                heartbeat_timestamp REAL
            )
        ''')
        conn.commit()

        table_info = cursor.execute("PRAGMA table_info(task_status);").fetchall()
        column_names = [info['name'] for info in table_info]

        migrations = {
            'original_size_bytes': "ALTER TABLE task_status ADD COLUMN original_size_bytes INTEGER;",
            'processed_size_bytes': "ALTER TABLE task_status ADD COLUMN processed_size_bytes INTEGER;",
            'output_target_format': "ALTER TABLE task_status ADD COLUMN output_target_format TEXT;",
            'cancellation_requested': "ALTER TABLE task_status ADD COLUMN cancellation_requested INTEGER DEFAULT 0;",
            'worker_pid': "ALTER TABLE task_status ADD COLUMN worker_pid INTEGER;",
            'heartbeat_timestamp': "ALTER TABLE task_status ADD COLUMN heartbeat_timestamp REAL;"
        }

        # Legacy column migration example
        if 'image_format' in column_names and 'page_raster_format' not in column_names:
            try:
                cursor.execute("ALTER TABLE task_status RENAME COLUMN image_format TO page_raster_format;")
                conn.commit()
                app.logger.info("Renamed 'image_format' to 'page_raster_format' in task_status table.")
            except sqlite3.Error as e_alter:
                if "duplicate column name" not in str(e_alter).lower():
                    app.logger.error(f"Error renaming column: {e_alter}")

        for col_name, alter_sql in migrations.items():
            if col_name not in column_names:
                try:
                    cursor.execute(alter_sql)
                    conn.commit()
                    app.logger.info(f"DB Migration: Added '{col_name}' column to task_status table.")
                except sqlite3.Error as e_alter:
                    app.logger.error(f"DB Migration Error adding '{col_name}' column: {e_alter}")

        app.logger.info("Database initialized successfully.")
    except sqlite3.Error as e:
        app.logger.error(f"Database initialization error: {e}", exc_info=True)
    finally:
        if conn: conn.close()

# Let the parallelism happen at the Gunicorn worker level, not within the process.
MAX_PDF_WORKERS = 1
app.logger.info(f"Initializing PDF processor with {MAX_PDF_WORKERS} max workers per Flask worker.")
pdf_processor_executor = ThreadPoolExecutor(max_workers=MAX_PDF_WORKERS, thread_name_prefix="PDFWorker")


def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

# --- Task Management and Cancellation Helper Functions ---
def check_cancellation(task_id):
    """Checks the database to see if a cancellation has been requested for the task."""
    conn = None
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT cancellation_requested FROM task_status WHERE task_id = ?", (task_id,))
        result = cursor.fetchone()
        return result and result['cancellation_requested'] == 1
    except sqlite3.Error as e:
        app.logger.error(f"DB Error checking cancellation for task {task_id}: {e}")
        return False # Fail safe: don't cancel if DB check fails
    finally:
        if conn: conn.close()

def cleanup_and_delete_task_record(task_id):
    """Removes files and the database entry for a given task_id. (Used by monitor and DELETE route)"""
    conn = None
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT input_path, output_path FROM task_status WHERE task_id = ?", (task_id,))
        task_row = cursor.fetchone()

        if task_row:
            # Clean up associated files first
            paths_to_clean = filter(None, [task_row['input_path'], task_row['output_path']])
            for file_path in paths_to_clean:
                if os.path.exists(file_path):
                    try:
                        os.remove(file_path)
                        app.logger.info(f"Cleanup: Removed file {file_path} for task {task_id}")
                    except OSError as e:
                        app.logger.error(f"Cleanup: Error removing file {file_path} for task {task_id}: {e}")

            # Delete the record from DB
            cursor.execute("DELETE FROM task_status WHERE task_id = ?", (task_id,))
            conn.commit()
            app.logger.info(f"Cleanup: Removed task record {task_id} from DB.")
            return True
        return False
    except sqlite3.Error as e:
        app.logger.error(f"DB Error during cleanup for task {task_id}: {e}", exc_info=True)
        return False
    finally:
        if conn: conn.close()

def update_task_in_db(task_id, status=None, message=None, progress=None,
                      original_size_bytes_val=None, processed_size_bytes_val=None,
                      worker_pid=None, update_heartbeat=False):
    conn = None
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        fields_to_update = []
        params = []
        current_time = time.time()

        if status is not None: fields_to_update.append("status = ?"); params.append(status)
        if message is not None: fields_to_update.append("message = ?"); params.append(message)
        if progress is not None: fields_to_update.append("progress = ?"); params.append(progress)
        if original_size_bytes_val is not None: fields_to_update.append("original_size_bytes = ?"); params.append(original_size_bytes_val)
        if processed_size_bytes_val is not None: fields_to_update.append("processed_size_bytes = ?"); params.append(processed_size_bytes_val)
        if worker_pid is not None: fields_to_update.append("worker_pid = ?"); params.append(worker_pid)
        if update_heartbeat: fields_to_update.append("heartbeat_timestamp = ?"); params.append(current_time)

        if not fields_to_update: return

        fields_to_update.append("timestamp_last_updated = ?"); params.append(current_time)
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

    # --- Task Start: Announce PID and Initial Heartbeat ---
    worker_pid = os.getpid()
    app.logger.info(f"Task {task_id} starting on worker PID {worker_pid}.")
    update_task_in_db(task_id, status='processing', worker_pid=worker_pid, update_heartbeat=True)

    if check_cancellation(task_id):
        app.logger.info(f"Task {task_id} was cancelled before processing started.")
        cleanup_and_delete_task_record(task_id)
        return

    app.logger.info(
        f"Task {task_id} ({original_input_filename}) processing. Target: {output_target_format.upper()}. "
        f"DPI: {dpi}, Page Raster Format: {page_raster_format}, "
        f"JPEG Quality: {jpeg_raster_quality if page_raster_format == 'jpeg' else 'N/A'}. "
        f"Thread: {threading.current_thread().name}"
    )
    update_task_in_db(task_id, message='Preparing: Opening your PDF...', progress=5, update_heartbeat=True)

    original_size = None
    processed_size = None
    input_doc = None
    output_doc_for_pdf = None

    with tempfile.TemporaryDirectory(prefix=f"pdftask_{task_id}_") as temp_processing_dir:
        app.logger.info(f"Task {task_id}: Using temporary directory {temp_processing_dir} for intermediate files.")
        temp_image_files_for_stitching = []

        try:
            if not os.path.exists(input_pdf_path):
                update_task_in_db(task_id, status='failed', message="Error: Input PDF was not found on server.")
                app.logger.error(f"Task {task_id}: Input PDF {input_pdf_path} not found.")
                return

            try:
                if os.path.exists(input_pdf_path): original_size = os.path.getsize(input_pdf_path)
            except OSError as e:
                app.logger.warning(f"Task {task_id}: Could not get size of input file {input_pdf_path}: {e}")

            input_doc = fitz.open(input_pdf_path)
            num_pages = len(input_doc)

            if num_pages == 0:
                if output_target_format == 'pdf':
                    output_doc_for_pdf = fitz.open()
                    output_doc_for_pdf.save(output_file_path, garbage=4, deflate=True, clean=True)
                    if os.path.exists(output_file_path): processed_size = os.path.getsize(output_file_path)
                    update_task_in_db(task_id, status='completed', message="Input PDF has no pages. An empty processed PDF has been created.", progress=100, original_size_bytes_val=original_size, processed_size_bytes_val=processed_size)
                elif output_target_format == 'image':
                    update_task_in_db(task_id, status='failed', message="Input PDF has no pages. Cannot create a combined image.", progress=100, original_size_bytes_val=original_size)
                return

            if output_target_format == 'image' and not Image:
                update_task_in_db(task_id, status='failed', message="Image processing library (Pillow) not available on server.")
                app.logger.error(f"Task {task_id}: Pillow not installed, cannot create combined image target.")
                return

            update_task_in_db(task_id, message=f"Processing: Analyzing {num_pages} pages...", progress=10, update_heartbeat=True)

            if output_target_format == 'pdf':
                output_doc_for_pdf = fitz.open()

            for page_num in range(num_pages):
                if check_cancellation(task_id):
                    app.logger.info(f"Task {task_id} cancelled by user during page processing loop.")
                    cleanup_and_delete_task_record(task_id)
                    return

                current_page_progress = int(80 * ((page_num + 1) / num_pages))
                update_task_in_db(task_id, progress=(10 + current_page_progress), message=f"Rasterizing: Page {page_num + 1} of {num_pages}...", update_heartbeat=True)

                page_instance = None
                try:
                    page_instance = input_doc.load_page(page_num)
                    zoom = dpi / 72.0
                    matrix = fitz.Matrix(zoom, zoom)

                    if output_target_format == 'pdf':
                        page_rect = page_instance.rect
                        new_page = output_doc_for_pdf.new_page(width=page_rect.width, height=page_rect.height)
                        page_pixel_width = page_rect.width * zoom
                        page_pixel_height = page_rect.height * zoom
                        save_args = {"output": page_raster_format}
                        if page_raster_format == 'jpeg': save_args["jpg_quality"] = jpeg_raster_quality

                        app.logger.info(f"Task {task_id}: Page {page_num + 1} ({page_pixel_width:.0f}x{page_pixel_height:.0f}px). Using memory-saving tiling.")
                        num_tiles_x = math.ceil(page_pixel_width / TILE_SIZE_PX)
                        num_tiles_y = math.ceil(page_pixel_height / TILE_SIZE_PX)
                        total_tiles = num_tiles_x * num_tiles_y
                        processed_tiles = 0

                        for y_tile in range(num_tiles_y):
                            for x_tile in range(num_tiles_x):
                                if check_cancellation(task_id):
                                    app.logger.info(f"Task {task_id} cancelled by user during tiling.")
                                    cleanup_and_delete_task_record(task_id)
                                    return

                                processed_tiles += 1
                                update_task_in_db(task_id, message=f"Rasterizing Page {page_num + 1}: Tile {processed_tiles}/{total_tiles}...", update_heartbeat=True)
                                app.logger.info(f"Task {task_id}: Rasterizing Page {page_num + 1}: Tile {processed_tiles}/{total_tiles}...")

                                x0 = (x_tile * TILE_SIZE_PX) / zoom; y0 = (y_tile * TILE_SIZE_PX) / zoom
                                x1 = min(((x_tile + 1) * TILE_SIZE_PX) / zoom, page_rect.width)
                                y1 = min(((y_tile + 1) * TILE_SIZE_PX) / zoom, page_rect.height)
                                tile_rect = fitz.Rect(x0, y0, x1, y1)

                                if tile_rect.is_empty: continue

                                tile_pix = page_instance.get_pixmap(matrix=matrix, clip=tile_rect, alpha=False)
                                try:
                                    image_bytes_for_tile = tile_pix.tobytes(**save_args)
                                    new_page.insert_image(tile_rect, stream=image_bytes_for_tile)
                                except Exception as img_e:
                                    app.logger.warning(f"Task {task_id}: Failed to convert tile, fallback to pixmap. Error: {img_e}")
                                    new_page.insert_image(tile_rect, pixmap=tile_pix)
                                tile_pix = None

                    elif output_target_format == 'image':
                        temp_page_filename = f"page_{page_num:04d}.{page_raster_format}"
                        temp_page_filepath = os.path.join(temp_processing_dir, temp_page_filename)
                        try:
                            pix_map = page_instance.get_pixmap(matrix=matrix, alpha=False)
                            if page_raster_format == 'jpeg': pix_map.save(temp_page_filepath, jpg_quality=jpeg_raster_quality)
                            else: pix_map.save(temp_page_filepath)
                            temp_image_files_for_stitching.append(temp_page_filepath)
                            pix_map = None
                        except Exception as e_save_temp_img:
                            error_msg = f"Error saving temp image for page {page_num + 1}: {str(e_save_temp_img)[:100]}"
                            update_task_in_db(task_id, status='failed', message=error_msg)
                            app.logger.error(f"Task {task_id}: {error_msg}", exc_info=True)
                            return
                finally:
                    if page_instance: page_instance.clean_contents(); page_instance = None

            if check_cancellation(task_id):
                app.logger.info(f"Task {task_id} cancelled by user before finalization.")
                cleanup_and_delete_task_record(task_id)
                return

            if output_target_format == 'pdf':
                update_task_in_db(task_id, progress=95, message="Finalizing: Saving new PDF...", update_heartbeat=True)
                output_doc_for_pdf.save(output_file_path, garbage=4, deflate=True, deflate_images=True, clean=True)

            elif output_target_format == 'image':
                if not temp_image_files_for_stitching:
                    update_task_in_db(task_id, status='failed', message="Error: No page images were created.")
                    return

                update_task_in_db(task_id, progress=95, message="Finalizing: Stitching images...", update_heartbeat=True)
                pil_page_images, final_image_pil = [], None
                try:
                    actual_max_width, actual_total_height = 0, 0
                    for i, temp_file_path in enumerate(temp_image_files_for_stitching):
                        if check_cancellation(task_id):
                            app.logger.info(f"Task {task_id} cancelled by user during image stitching.")
                            cleanup_and_delete_task_record(task_id)
                            return
                        update_task_in_db(task_id, message=f"Stitching: Loading page {i + 1}...", update_heartbeat=True)
                        img = Image.open(temp_file_path)
                        pil_page_images.append(img)
                        actual_max_width = max(actual_max_width, img.width)
                        actual_total_height += img.height

                    if actual_max_width == 0 or actual_total_height == 0:
                        update_task_in_db(task_id, status='failed', message="Error: Calculated image dimensions are zero.")
                        return

                    final_image_pil = Image.new('RGB', (actual_max_width, actual_total_height), (255, 255, 255))
                    current_y_offset = 0
                    for i, pil_img_to_paste in enumerate(pil_page_images):
                        update_task_in_db(task_id, message=f"Stitching: Pasting page {i + 1}...", update_heartbeat=True)
                        final_image_pil.paste(pil_img_to_paste, (0, current_y_offset))
                        current_y_offset += pil_img_to_paste.height

                    save_params_pil = {}
                    if page_raster_format == 'jpeg': save_params_pil.update({'quality': jpeg_raster_quality, 'optimize': True})
                    final_image_pil.save(output_file_path, **save_params_pil)
                except Exception as e_stitch_pil:
                    error_msg = f"Error stitching/saving final image (possibly out of memory): {str(e_stitch_pil)[:100]}..."
                    update_task_in_db(task_id, status='failed', message=error_msg)
                    return
                finally:
                    if final_image_pil: final_image_pil.close()
                    for img_obj in pil_page_images: img_obj.close()

            try:
                if os.path.exists(output_file_path): processed_size = os.path.getsize(output_file_path)
            except OSError as e: app.logger.warning(f"Task {task_id}: Could not get size of output file: {e}")

            update_task_in_db(task_id, status='completed', message="Success! Your processed file is ready.", progress=100, original_size_bytes_val=original_size, processed_size_bytes_val=processed_size)
            app.logger.info(f"Task {task_id} completed successfully. Original: {original_size} bytes, Processed: {processed_size} bytes.")

        except Exception as e_main:
            crit_error_msg = f"Critical error during processing: {str(e_main)[:100]}..."
            update_task_in_db(task_id, status='failed', message=crit_error_msg)
            app.logger.error(f"Task {task_id} critical error: {e_main}", exc_info=True)
            return
        finally:
            if input_doc: input_doc.close()
            if output_doc_for_pdf: output_doc_for_pdf.close()
            gc.collect()

    if os.path.exists(input_pdf_path):
        try:
            os.remove(input_pdf_path)
            app.logger.info(f"Cleaned up input file: {input_pdf_path} for task {task_id}.")
        except OSError as e:
            app.logger.warning(f"Could not remove input file {input_pdf_path} for task {task_id}: {e}")

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/health')
def health_check():
    return jsonify({'status': 'ok'}), 200

@app.route('/upload', methods=['POST'])
def upload_file():
    if 'pdf_file' not in request.files: return jsonify({'error': 'No file part in the request.'}), 400
    file = request.files['pdf_file']
    if file.filename == '': return jsonify({'error': 'No file selected for upload.'}), 400

    if file and allowed_file(file.filename):
        original_filename_secure = secure_filename(file.filename)
        task_id = str(uuid.uuid4())
        try: dpi = int(request.form.get('dpi', '72'));_ = (10 <= dpi <= 600) or exec("raise ValueError")
        except: dpi = 72
        page_raster_format = request.form.get('image_format', 'jpeg').lower();_ = (page_raster_format in ['jpeg', 'png']) or exec("page_raster_format='jpeg'")
        jpeg_quality_val = None
        if page_raster_format == 'jpeg':
            try: jpeg_quality_val = int(request.form.get('jpeg_quality', '75'));_ = (1 <= jpeg_quality_val <= 100) or exec("raise ValueError")
            except: jpeg_quality_val = 75
        output_target_format = request.form.get('output_target_format', 'pdf').lower();_ = (output_target_format in ['pdf', 'image']) or exec("output_target_format='pdf'")
        if output_target_format == 'image' and not Image: return jsonify({'error': 'Server configuration error: Image processing (Pillow) is not available.'}), 503

        server_input_filename = f"{task_id}_{original_filename_secure}"
        input_pdf_path = os.path.join(app.config['UPLOAD_FOLDER'], server_input_filename)
        original_basename = os.path.splitext(original_filename_secure)[0]
        if output_target_format == 'pdf':
            server_output_filename = f"{task_id}_processed.pdf"; user_facing_dl_name = f"Compressed_{original_basename}.pdf"
        elif output_target_format == 'image':
            image_ext = page_raster_format; server_output_filename = f"{task_id}_combined.{image_ext}"; user_facing_dl_name = f"Combined_{original_basename}.{image_ext}"
        output_path = os.path.join(app.config['PROCESSED_FOLDER'], server_output_filename)

        try: file.save(input_pdf_path)
        except Exception as e: return jsonify({'error': f'Could not save uploaded file: {str(e)}'}), 500

        conn = None
        try:
            conn = get_db_connection()
            current_time = time.time()
            conn.execute("""
                INSERT INTO task_status (task_id, status, message, input_path, output_path, original_filename, user_facing_output_filename, dpi, page_raster_format, jpeg_quality, output_target_format, timestamp_created, timestamp_last_updated)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (task_id, 'queued', 'Queued for processing.', input_pdf_path, output_path, original_filename_secure, user_facing_dl_name, dpi, page_raster_format, jpeg_quality_val, output_target_format, current_time, current_time))
            conn.commit()
        except sqlite3.Error as e:
            if os.path.exists(input_pdf_path): os.remove(input_pdf_path)
            return jsonify({'error': 'Failed to queue task due to a database error.'}), 500
        finally:
            if conn: conn.close()

        pdf_processor_executor.submit(process_pdf_task, task_id, input_pdf_path, output_path, dpi, original_filename_secure, page_raster_format, jpeg_quality_val, output_target_format)
        app.logger.info(f"Task {task_id} ({original_filename_secure}) submitted for processing.")
        return jsonify({'task_id': task_id, 'message': 'File upload successful, processing queued.'})
    else:
        return jsonify({'error': 'Invalid file type. Only PDF files are allowed.'}), 400

@app.route('/status/<task_id>')
def task_status(task_id):
    conn = None
    try:
        conn = get_db_connection()
        task_row = conn.execute("SELECT * FROM task_status WHERE task_id = ?", (task_id,)).fetchone()
    except sqlite3.Error as e:
        app.logger.error(f"DB Error fetching status for task {task_id}: {e}", exc_info=True)
        return jsonify({'status': 'error', 'message': 'Error querying task status.'}), 500
    finally:
        if conn: conn.close()

    if not task_row: return jsonify({'status': 'not_found', 'message': 'Task ID not found or has been cleaned up.'}), 404

    task_dict = dict(task_row)
    task_dict['output_filename'] = task_dict.get('user_facing_output_filename', None)
    return jsonify(task_dict)

@app.route('/download/<task_id>')
def download_file_route(task_id):
    conn = None
    try:
        conn = get_db_connection()
        task_row = conn.execute("SELECT status, output_path, user_facing_output_filename, message FROM task_status WHERE task_id = ?", (task_id,)).fetchone()
    except sqlite3.Error as e:
        return jsonify({'error': 'Error preparing file for download.'}), 500
    finally:
        if conn: conn.close()
    if not task_row: return jsonify({'error': 'Task not found or has been cleaned up.'}), 404
    if task_row['status'] != 'completed': return jsonify({'error': task_row['message'] or 'File is not ready or processing failed.'}), 400
    if not task_row['user_facing_output_filename'] or not task_row['output_path']: return jsonify({'error': 'Output file details incomplete.'}), 500

    actual_disk_filename = os.path.basename(task_row['output_path'])
    if not os.path.exists(os.path.join(app.config['PROCESSED_FOLDER'], actual_disk_filename)):
        update_task_in_db(task_id, status='failed', message='Error: Processed file missing on server.')
        return jsonify({'error': 'Processed file could not be found.'}), 404

    try:
        return send_from_directory(directory=app.config['PROCESSED_FOLDER'], path=actual_disk_filename, as_attachment=True, download_name=task_row['user_facing_output_filename'])
    except Exception as e:
        return jsonify({'error': f'An unexpected error occurred during download.'}), 500

@app.route('/task/<task_id>', methods=['DELETE'])
def delete_task(task_id):
    conn = get_db_connection()
    task_row = conn.execute("SELECT status FROM task_status WHERE task_id = ?", (task_id,)).fetchone()
    if not task_row:
        conn.close()
        abort(404, description="Task not found.")

    status = task_row['status']
    if status in ['completed', 'failed']:
        conn.close()
        if cleanup_and_delete_task_record(task_id):
            return jsonify({'message': f'Task {task_id} has been deleted.'}), 200
        else:
            return jsonify({'error': 'Failed to delete task resources.'}), 500

    elif status in ['queued', 'processing']:
        try:
            conn.execute("""
                UPDATE task_status
                SET cancellation_requested = 1, status = 'cancelling', message = 'Cancellation requested by user...'
                WHERE task_id = ?
            """, (task_id,))
            conn.commit()
            app.logger.info(f"Cancellation requested for active task {task_id}.")
            return jsonify({'message': f'Cancellation initiated for task {task_id}.'}), 202
        except sqlite3.Error as e:
            app.logger.error(f"DB error during cancellation request for {task_id}: {e}")
            return jsonify({'error': 'Database error during cancellation request.'}), 500
        finally:
            conn.close()
    else: # e.g., 'cancelling'
        conn.close()
        return jsonify({'message': f'Task {task_id} is already being cancelled.'}), 202

# The cleanup logic is now in monitor.py and started by gunicorn.conf.py
# This ensures it only runs ONCE for the entire application.
# The code block below is left for context during `flask run` but is not used by Gunicorn.
if __name__ == '__main__':
    init_db()
    if Image is None:
        app.logger.warning("Pillow library is not installed. Functionality to output combined images will be disabled.")

    # In a simple `flask run` scenario, a monitor isn't running.
    # For development, you might want to run monitor.py in a separate terminal.
    app.logger.info("Starting Flask development server...")
    app.logger.warning("NOTE: The worker monitor/cleanup service does not run in this mode.")
    app.logger.warning("For production, use Gunicorn via 'run.sh'.")

    app.run(debug=False, host='0.0.0.0', port=7001)
else:
    # This block runs when Gunicorn imports the app.
    # We initialize the DB for each worker process.
    init_db()
    if Image is None and os.environ.get("WERKZEUG_RUN_MAIN") != "true":
        app.logger.warning("Pillow library is not installed. Functionality to output combined images will be disabled in this worker.")