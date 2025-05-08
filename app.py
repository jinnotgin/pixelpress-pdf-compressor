#!/usr/bin/env python3

import fitz  # PyMuPDF
import os
import uuid
import threading
import time
from flask import Flask, request, jsonify, render_template, send_from_directory, url_for
from werkzeug.utils import secure_filename

app = Flask(__name__)

# Configuration
UPLOAD_FOLDER = 'uploads'
PROCESSED_FOLDER = 'processed'
ALLOWED_EXTENSIONS = {'pdf'}
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
app.config['PROCESSED_FOLDER'] = PROCESSED_FOLDER
app.config['MAX_CONTENT_LENGTH'] = 100 * 1024 * 1024  # 100 MB limit

# Ensure upload and processed directories exist
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(PROCESSED_FOLDER, exist_ok=True)

tasks = {} # In-memory store for task statuses

def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

def rasterize_pdf_to_new_pdf_web(task_id, input_pdf_path, output_pdf_path, dpi=72):
    global tasks
    task_info = tasks[task_id]
    original_basename = os.path.basename(task_info['original_filename'])
    user_facing_output_filename = f"Compressed_{original_basename}"

    task_info['status'] = 'processing'
    task_info['message'] = 'Preparing: Opening your PDF...'
    task_info['progress'] = 5

    try:
        if not os.path.exists(input_pdf_path):
            task_info['status'] = 'failed'
            task_info['message'] = f"Error: Input PDF was not found on server."
            return False

        input_doc = fitz.open(input_pdf_path)
        output_doc = fitz.open()
        num_pages = len(input_doc)

        if num_pages == 0:
            task_info['status'] = 'completed'
            task_info['message'] = "Input PDF has no pages. An empty processed PDF has been created."
            task_info['progress'] = 100
            output_doc.save(output_pdf_path, garbage=4, deflate=True)
            task_info['output_filename'] = user_facing_output_filename # Set for download
            input_doc.close()
            output_doc.close()
            return True

        task_info['message'] = f"Processing: Analyzing {num_pages} pages..."
        task_info['progress'] = 10

        for page_num in range(num_pages):
            # Progress: 10% (setup) + 80% (page processing) + 10% (saving/cleanup)
            current_page_progress = int(80 * ((page_num + 1) / num_pages))
            task_info['progress'] = 10 + current_page_progress
            task_info['message'] = f"Rasterizing: Page {page_num + 1} of {num_pages} at {dpi} DPI..."
            
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
                page = None 

            except Exception as e:
                task_info['status'] = 'failed'
                task_info['message'] = f"Error on page {page_num + 1}: {str(e)[:100]}..." # Truncate long errors
                app.logger.error(f"Task {task_id} failed on page {page_num + 1}: {e}")
                if 'input_doc' in locals() and not input_doc.is_closed: input_doc.close()
                if 'output_doc' in locals() and not output_doc.is_closed: output_doc.close()
                if os.path.exists(output_pdf_path):
                    try: os.remove(output_pdf_path)
                    except OSError: pass
                return False
        
        task_info['progress'] = 95
        task_info['message'] = "Finalizing: Compiling and saving your new PDF..."
        output_doc.save(output_pdf_path, garbage=4, deflate=True)
        
        task_info['status'] = 'completed'
        task_info['message'] = f"Success! Your PDF '{user_facing_output_filename}' is ready for download."
        task_info['progress'] = 100
        task_info['output_filename'] = user_facing_output_filename # Critical for download link
        return True

    except Exception as e:
        task_info['status'] = 'failed'
        task_info['message'] = f"Critical error during processing: {str(e)[:100]}..."
        app.logger.error(f"Task {task_id} critical error: {e}")
        if os.path.exists(output_pdf_path):
            try: os.remove(output_pdf_path)
            except OSError: pass
        return False
    finally:
        if 'input_doc' in locals() and input_doc and not input_doc.is_closed:
            input_doc.close()
        if 'output_doc' in locals() and output_doc and not output_doc.is_closed:
            output_doc.close()
        
        # Clean up the original uploaded file after processing is fully done (success or fail)
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
        original_filename = secure_filename(file.filename)
        task_id = str(uuid.uuid4())
        
        try:
            dpi = int(request.form.get('dpi', 72))
            if not (10 <= dpi <= 600):
                 dpi = 72 
        except ValueError:
            dpi = 72
            
        # Use a unique name for the uploaded file on the server to avoid conflicts
        # but store original_filename for user-facing names.
        server_input_filename = f"{task_id}_{original_filename}"
        server_output_filename = f"{task_id}_processed.pdf"
        
        input_pdf_path = os.path.join(app.config['UPLOAD_FOLDER'], server_input_filename)
        output_pdf_path = os.path.join(app.config['PROCESSED_FOLDER'], server_output_filename)

        try:
            file.save(input_pdf_path)
        except Exception as e:
            app.logger.error(f"Error saving uploaded file {original_filename}: {e}")
            return jsonify({'error': f'Could not save uploaded file: {str(e)}'}), 500

        tasks[task_id] = {
            'status': 'queued', 
            'message': 'File received. Your PDF is now in the processing queue.',
            'progress': 0,
            'input_path': input_pdf_path,
            'output_path': output_pdf_path,
            'original_filename': original_filename, # Store original for naming conventions
            'output_filename': None # Will be set on completion: "Compressed_original_filename.pdf"
        }

        thread = threading.Thread(target=rasterize_pdf_to_new_pdf_web, args=(task_id, input_pdf_path, output_pdf_path, dpi))
        thread.start()

        return jsonify({'task_id': task_id, 'message': 'File upload successful, processing started.'})
    else:
        return jsonify({'error': 'Invalid file type. Only PDF files are allowed.'}), 400

@app.route('/status/<task_id>')
def task_status(task_id):
    task = tasks.get(task_id)
    if not task:
        return jsonify({'status': 'failed', 'message': 'Task ID not found or task has expired.'}), 404
    return jsonify(task)

@app.route('/download/<task_id>')
def download_file(task_id):
    task = tasks.get(task_id)
    if not task:
        return jsonify({'error': 'Task not found.'}), 404
    if task['status'] != 'completed':
        return jsonify({'error': 'File is not yet ready for download or processing failed.'}), 404
    if not task.get('output_filename') or not task.get('output_path'):
        app.logger.error(f"Task {task_id} completed but output details missing: {task}")
        return jsonify({'error': 'Output file details missing for completed task.'}), 500

    try:
        # The 'output_filename' in the task is the user-facing download name (e.g., Compressed_...)
        # The 'output_path' points to the actual file on disk (e.g., taskid_processed.pdf)
        return send_from_directory(
            directory=app.config['PROCESSED_FOLDER'],
            path=os.path.basename(task['output_path']), # Actual filename on disk
            as_attachment=True,
            download_name=task['output_filename'] # Suggested name for the user
        )
    except FileNotFoundError:
        app.logger.error(f"Processed file not found for task {task_id} at {task['output_path']}")
        return jsonify({'error': 'Processed file could not be found on the server.'}), 404
    except Exception as e:
        app.logger.error(f"Error during download for task {task_id}: {e}")
        return jsonify({'error': f'An unexpected error occurred during download: {str(e)}'}), 500

# Optional: A simple scheduled cleanup for old task entries and files
# This is very basic. For production, use a more robust job scheduler.
def cleanup_old_tasks():
    while True:
        time.sleep(3600) # Run every hour
        now = time.time()
        tasks_to_delete = []
        for task_id, task_data in tasks.items():
            # Example: Clean up tasks older than 2 hours (completed or failed)
            task_age = task_data.get('timestamp', now) # Add 'timestamp': time.time() when task created/updated
            if (now - task_age > 7200 and task_data['status'] in ['completed', 'failed']):
                tasks_to_delete.append(task_id)
                if os.path.exists(task_data['output_path']):
                    try: 
                        os.remove(task_data['output_path'])
                        app.logger.info(f"Cleaned up old processed file: {task_data['output_path']}")
                    except OSError as e:
                        app.logger.error(f"Error cleaning old processed file {task_data['output_path']}: {e}")
                # Input files are cleaned up immediately after processing now

        for task_id in tasks_to_delete:
            del tasks[task_id]
            app.logger.info(f"Removed old task entry: {task_id}")

if __name__ == '__main__':
    os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)
    os.makedirs(app.config['PROCESSED_FOLDER'], exist_ok=True)
    
    # If you want to run the cleanup thread (optional, make sure to add 'timestamp' to tasks)
    # cleanup_thread = threading.Thread(target=cleanup_old_tasks, daemon=True)
    # cleanup_thread.start()

    app.run(debug=True, host='0.0.0.0', port=7001)