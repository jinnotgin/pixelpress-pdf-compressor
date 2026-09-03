# PixelPress PDF Compressor

A web-based tool to compress large PDFs, make them searchable via OCR, or combine all pages into a single image. It's especially effective on large, image-heavy PDFs exported from design tools like Figma.

<kbd><img width="1306" alt="image" src="https://github.com/user-attachments/assets/c7f6ca67-02e1-4806-9e40-f02a794570f8" /></kbd>

It features a multi-file upload queue, real-time progress tracking, and customizable output settings (including OCR and compression levels), all managed through a clean and simple web interface. The included setup scripts provide a fully automated environment configuration for macOS.

## Why PixelPress?

Design tools like Figma often export PDFs with enormous file sizes due to complex vector data, making them difficult to share. Scanned documents are often just images, making them impossible to search. PixelPress solves these problems:

1.  **Compression:** It converts each page into a lightweight, rasterized image (like a JPEG or PNG) and then packages those images into a new, much smaller PDF.
2.  **Searchability:** It can perform Optical Character Recognition (OCR) on the document's pages, adding a hidden text layer that makes the entire PDF content searchable.

This makes files significantly easier to store, share, view, and search, while retaining visual fidelity.

## Core Features

-   **Compress PDFs:** Converts complex vector or image pages into optimized images (JPEG/PNG) within a new PDF, often resulting in a dramatic reduction in file size.
-   **Searchable PDF Creation (OCR):** Uses the powerful Tesseract engine to add a text layer to your PDF, making its content fully searchable and selectable.
-   **Combine to Image:** Stitches all PDF pages vertically into a single, downloadable image file.
-   **Asynchronous & Queued Processing:** Upload multiple files at once. The server processes them one by one in the background so you don't have to wait.
-   **Live Progress Tracking:** Monitor the real-time status of your files, from "Queued" to "Processing" to "Completed", with a progress bar.
-   **Customizable Output:**
    -   Choose between **PDF** or a single **stitched Image** as your final output.
    -   Control the **DPI (Dots Per Inch)** for image quality.
    -   For image output, select the **image format (JPEG/PNG)**.
    -   For PDF output, set a **PDF Compression Level**.
    -   Enable **OCR (Optical Character Recognition)** to create searchable PDFs.
-   **Task Management:** Cancel in-progress jobs or clear completed/failed items from your history. Your session is remembered in your browser via `localStorage`.
-   **Drag & Drop Interface:** A modern, user-friendly UI for easy file uploads.
-   **Memory Efficient:** Uses a tiling strategy to process very high-resolution pages without running out of memory.
-   **Automatic Cleanup:** The server automatically cleans up old files (default: 72 hours) to conserve disk space.

## Technology Stack

-   **Backend:** Python 3, Flask, PyMuPDF, Pillow, ImageMagick, Tesseract, OCRmyPDF
-   **Database:** SQLite
-   **Frontend:** HTML, Bootstrap, Vanilla JavaScript (Fetch API)
-   **WSGI Server:** Gunicorn
-   **Development Environment (macOS):** Homebrew, pyenv, pyenv-virtualenv

## Getting Started (Automated macOS Setup)

These scripts provide a one-click setup and run experience on **macOS**.

### Prerequisites

-   **Xcode Command Line Tools**: Required for `pyenv` to build Python from source. If you don't have them, install them by running this command in your terminal:
    ```bash
    xcode-select --install
    ```
-   **Homebrew**: The script will install this for you if it's missing. The script will also use Homebrew to install all other dependencies like Python, ImageMagick, Tesseract, and OCRmyPDF.

### Step 1: Clone the Repository

```bash
git clone https://github.com/your-username/pixelpress-pdf-compressor.git
cd pixelpress-pdf-compressor
```

### Step 2: Run the Setup Script

This script automates the entire environment setup. Make it executable and run it.

```bash
chmod +x setup.sh
./setup.sh
```

The script will perform the following actions:
-   ✅ Install **Homebrew** (if not present).
-   ✅ Install backend tools like **ImageMagick**, **Tesseract** and **ocrmypdf**.
-   ✅ Install **pyenv** and the **pyenv-virtualenv** plugin.
-   ✅ Configure your shell (`.zshrc` or `.bash_profile`) for `pyenv`.
-   ✅ Install the latest patch version of Python 3.12 (or as configured in the script).
-   ✅ Create a virtual environment named after the project folder (e.g., `pixelpress-pdf-compressor`).
-   ✅ Install all required Python packages from `requirements.txt`.
-   ✅ Configure the directory to automatically use this environment in the future.

⚠️ **Important:** You may need to restart your terminal after the setup script runs for the first time to ensure the shell configuration is fully loaded.

### Step 3: Run the Application

Once setup is complete, use the `run.sh` script to start the server.

```bash
chmod +x run.sh
./run.sh
```

This script will:
-   🚀 Start the application using a production-ready **Gunicorn server**.
-   ⚙️ Automatically configure the optimal number of workers based on your CPU cores.
-   🌐 Launch the application in your default web browser at `http://localhost:7001`.
-   📝 Stream logs to your terminal and save them to `gunicorn.log`.

To stop the server, simply press `Ctrl+C` in the terminal where it's running.

## Manual Setup (For Linux, Windows, or non-pyenv users)

If you are not on macOS or prefer a manual setup, follow these steps.

### 1. Install System Dependencies

You need to install Python 3.8+, ImageMagick, Tesseract, and ocrmypdf using your system's package manager.

**On Debian/Ubuntu:**
```bash
sudo apt-get update
sudo apt-get install python3 python3-venv python3-pip imagemagick tesseract-ocr ocrmypdf
```

**On Fedora/CentOS:**
```bash
sudo dnf install python3 python3-venv python3-pip imagemagick tesseract ocrmypdf
```

**On Windows:**
Manual installation of ImageMagick, Tesseract and OCRmyPDF is required.

### 2. Create and Activate a Virtual Environment

It's highly recommended to use a virtual environment.

```bash
# Create a virtual environment named 'venv'
python3 -m venv venv

# Activate it
# On macOS/Linux:
source venv/bin/activate
# On Windows:
.\venv\Scripts\activate
```

### 3. Install Python Dependencies

Install the required packages using pip.

```bash
pip install --upgrade pip
pip install -r requirements.txt
```

### 4. Run the Application

You can run the app using the simple Flask development server (good for debugging) or Gunicorn (for performance).

**Option A: Flask Development Server**
```bash
python app.py
```
The application will be available at `http://127.0.0.1:7001`.

**Option B: Gunicorn (Production, Linux/macOS)**
```bash
gunicorn --workers 4 --threads 2 --bind 0.0.0.0:7001 app:app
```

## How It Works

1.  **Upload:** A user selects one or more PDF files and their desired output settings (DPI, OCR, compression, etc.) via the web UI.
2.  **Queue:** The Flask backend receives each file, creates a unique task ID, and stores the job's metadata in an SQLite database. The task is marked as `queued`.
3.  **Background Processing:** The task is submitted to a background `ThreadPoolExecutor`.
4.  **Rasterization:** A worker thread picks up the task. It uses the **PyMuPDF** library to iterate through each page of the PDF. A memory-saving tiling method is used to rasterize very large pages into images at the specified DPI without crashing.
5.  **Assembly & Processing:** The workflow depends on the user's chosen output:
    *   **Standard PDF:** The generated page images are inserted directly into a new, clean PDF document using PyMuPDF. This new PDF is then passed to `ocrmypdf` for a final optimization pass (without OCR).
    *   **Searchable PDF (OCR):** The rasterized page images are saved to a temporary directory. **Tesseract** processes these images to create a new PDF with an embedded, searchable text layer. This searchable PDF is then passed to `ocrmypdf` for final optimization.
    *   **Stitched Image:** The page images are stitched together vertically into one large image file using **ImageMagick**.
6.  **PDF Optimization:** For PDF outputs, an additional optimization step is performed using `ocrmypdf` based on the selected "Compression Level":
    *   **High (i.e. Level 1):** Applies lossless optimizations (e.g., better image encoding, stream compression).
    *   **Extreme (i.e. Level 3):** Includes all Level 1 optimizations, plus more aggresive lossy optimizations (like color quantization), for the smallest possible file size, potentially at the cost of some quality.
7.  **Status Updates:** The frontend periodically polls a status API endpoint to update the UI with the task's progress (`processing`, `completed`, `failed`).
8.  **Download:** Once a task is `completed`, a download link is provided to the user. The backend serves the processed file from the `processed` directory.

## Acknowledgments

- This project relies on several fantastic open-source libraries: **Flask**, **PyMuPDF**, **Pillow**, **ImageMagick**, **Tesseract OCR**, and **OCRmyPDF**.
- The concept and code structure were bootstrapped with the assistance of Google's Gemini Pro 2.5.