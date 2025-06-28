#!/bin/bash
#
# run.sh: Starts the Gunicorn server for the PDF processing app.
# - Automatically detects CPU cores for optimal worker processes.
# - Uses multi-process workers to bypass the Python GIL for true concurrency.
# - Works when run from terminal or double-clicked.

# --- Configuration & Environment Setup ---
# Get the absolute path of the directory where this script is located.
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"

# Set all paths relative to the script's location for robustness.
# NOTE: This assumes a pyenv virtual environment named after the project folder.
# Adjust VENV_PATH if you use a different venv manager (e.g., a local 'venv' folder).
VENV_NAME=$(basename "$SCRIPT_DIR")
VENV_PATH="$HOME/.pyenv/versions/$VENV_NAME"
GUNICORN_CMD="$VENV_PATH/bin/gunicorn"

PORT=7001
HOST="0.0.0.0"
APP_MODULE="app:app"
TIMEOUT=1200
LOG_FILE="$SCRIPT_DIR/gunicorn.log"

PIPELINE_PID=""


# --- NEW: Gunicorn Worker Configuration ---
# This section enables true parallel processing by using multiple worker processes,
# which gets around the limitations of Python's Global Interpreter Lock (GIL).

# 1. Automatically detect the number of available CPU cores. Fallback to 2 if undetected.
CPU_COUNT=$(python3 -c 'import os; print(os.cpu_count() or 2)')

# 2. Set smart defaults. A common starting point for gthread workers is (num_cores).
#    You can override these with environment variables, e.g.,
#    `GUNICORN_WORKERS=4 GUNICORN_THREADS=2 ./run.sh`
DEFAULT_WORKERS=$CPU_COUNT
WORKERS=${GUNICORN_WORKERS:-$DEFAULT_WORKERS}
THREADS=${GUNICORN_THREADS:-2}
WORKER_CLASS="gthread"
# WORKER_MAX_REQUEST_BEFORE_TERMINATE=50
# WORKER_MAX_REQUEST_JITTER=10


# --- Shutdown Function ---
shutdown_server() {
    echo ""
    echo "🛑 Initiating shutdown..."
    if [ -n "$PIPELINE_PID" ] && ps -p "$PIPELINE_PID" > /dev/null; then
        echo "   Killing process group (PID: $PIPELINE_PID)..."
        # Use kill with the PID to terminate the entire process group started by Gunicorn.
        kill "$PIPELINE_PID"
        wait "$PIPELINE_PID" 2>/dev/null
        echo "✅ Server stopped."
    else
        echo "   Server process not found. Was it already stopped?"
    fi
    exit 0
}

# --- Trap Signals ---
trap 'shutdown_server' SIGINT SIGTERM

# --- Main Script ---

# --- Pre-flight Checks ---
echo "--> Verifying environment..."
if ! command -v python3 &> /dev/null; then
    echo "❌ Error: 'python3' is not in your PATH. It is required to detect CPU cores."
    exit 1
fi

if [ ! -d "$VENV_PATH" ]; then
    echo "❌ Error: Virtual environment '$VENV_NAME' not found."
    echo "   The expected path was '$VENV_PATH'."
    echo "   Please run the setup script first: ./setup.sh"
    exit 1
fi

if [ ! -x "$GUNICORN_CMD" ]; then
    echo "❌ Error: 'gunicorn' command not found at '$GUNICORN_CMD'."
    echo "   Please run './setup.sh' again to install dependencies."
    exit 1
fi
echo "✅ Environment checks passed. Using gunicorn from '$VENV_NAME'."
echo ""

# --- Execution ---
echo "📝 Clearing previous log file: $LOG_FILE"
> "$LOG_FILE"

echo "🚀 Starting Gunicorn server from directory: $SCRIPT_DIR"
# --- MODIFIED: Added worker info to startup message ---
echo "   Host: $HOST | Port: $PORT"
echo "   Worker Processes: $WORKERS | Threads per Worker: $THREADS (Class: $WORKER_CLASS)"
echo "   Logs will be streamed here and also saved to '$LOG_FILE'."

# --- MODIFIED: Gunicorn command now includes worker/thread configuration ---
# Use --chdir to ensure Gunicorn runs in the correct project directory,
# which is essential when the script is double-clicked.
"$GUNICORN_CMD" \
    --workers "$WORKERS" \
    --threads "$THREADS" \
    --worker-class "$WORKER_CLASS" \
    --chdir "$SCRIPT_DIR" \
    --timeout "$TIMEOUT" \
    --bind "$HOST:$PORT" \
    "$APP_MODULE" 2>&1 | tee "$LOG_FILE" &
    
    # --max-requests "$WORKER_MAX_REQUEST_BEFORE_TERMINATE" \
    # --max-requests-jitter "$WORKER_MAX_REQUEST_JITTER" \

PIPELINE_PID=$!
sleep 1

if ! ps -p "$PIPELINE_PID" > /dev/null; then
    echo "❌ Gunicorn failed to start. Review '$LOG_FILE' for errors."
    exit 1
fi

echo "✅ Gunicorn is starting up (PID: $PIPELINE_PID)..."
echo -n "   Waiting for server to become available on port $PORT"

# Wait for the port to be open before proceeding
while ! nc -z localhost "$PORT"; do
  sleep 0.1
  echo -n "."
done

echo ""
echo "🌍 Server is ready! Launching browser at http://localhost:$PORT"
# Use 'open' on macOS, 'xdg-open' on Linux
if command -v open &> /dev/null; then
  open "http://localhost:$PORT"
elif command -v xdg-open &> /dev/null; then
  xdg-open "http://localhost:$PORT"
fi

echo ""
echo "✨ Server is running. Press Ctrl+C in this terminal to shut down."

# Wait for the background Gunicorn process to exit. This is crucial for the trap to work.
wait "$PIPELINE_PID"
