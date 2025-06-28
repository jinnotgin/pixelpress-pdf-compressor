#!/bin/bash

# --- Configuration ---
# Get the absolute path of the directory where this script is located.
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"

PORT=7001
HOST="0.0.0.0"
APP_MODULE="app:app"
TIMEOUT=1200
LOG_FILE="$SCRIPT_DIR/gunicorn.log"

# This will hold the Process ID (PID) of the background pipeline.
PIPELINE_PID=""

# --- NEW: Gunicorn Worker Configuration (from run.sh) ---
# This enables true parallel processing by using multiple worker processes,
# getting around the limitations of Python's Global Interpreter Lock (GIL).

# 1. Automatically detect CPU cores. Fallback to 2 if undetected.
CPU_COUNT=$(python3 -c 'import os; print(os.cpu_count() or 2)')

# 2. Set smart defaults for workers and threads.
DEFAULT_WORKERS=$CPU_COUNT
WORKERS=${GUNICORN_WORKERS:-$DEFAULT_WORKERS}
THREADS=${GUNICORN_THREADS:-2}
WORKER_CLASS="gthread"
# WORKER_MAX_REQUEST_BEFORE_TERMINATE=50
# WORKER_MAX_REQUEST_JITTER=10


# --- Shutdown Function ---
shutdown_server() {
    echo "" # Add a newline for cleaner output
    echo "🛑 Initiating shutdown..."
    if [ -n "$PIPELINE_PID" ] && ps -p "$PIPELINE_PID" > /dev/null; then
        echo "   Killing process group (PID: $PIPELINE_PID)..."
        # Kill the entire process group to ensure both gunicorn and tee are stopped.
        kill "$PIPELINE_PID"
        wait "$PIPELINE_PID" 2>/dev/null
        echo "✅ Server stopped."
    else
        echo "   Server process not found. Was it already stopped?"
    fi
    exit 0
}

# --- Trap Signals ---
# On SIGINT (Ctrl+C) or SIGTERM, call the shutdown_server function.
trap 'shutdown_server' SIGINT SIGTERM

# --- Main Script ---

# --- NEW: Pre-flight Checks ---
echo "--> Verifying environment..."
if ! command -v python3 &> /dev/null; then
    echo "❌ Error: 'python3' is not in your PATH. It is required to detect CPU cores."
    exit 1
fi
if ! command -v gunicorn &> /dev/null; then
    echo "❌ Error: 'gunicorn' is not in your PATH."
    echo "   Please install it first (e.g., 'pip install gunicorn')."
    exit 1
fi
echo "✅ Environment checks passed."
echo ""

# Clear the log file from the previous run.
echo "📝 Clearing previous log file: $LOG_FILE"
> "$LOG_FILE"

echo "🚀 Starting Gunicorn server..."
# --- MODIFIED: Added worker info to startup message ---
echo "   Host: $HOST | Port: $PORT"
echo "   Worker Processes: $WORKERS | Threads per Worker: $THREADS (Class: $WORKER_CLASS)"
echo "   Logs will be streamed here and also saved to '$LOG_FILE'."

# --- MODIFIED: Gunicorn command now includes worker/thread configuration ---
# Using 'gunicorn' directly, assuming it's in the system PATH.
# Use --chdir to ensure Gunicorn runs in the correct project directory.
gunicorn \
    --workers "$WORKERS" \
    --threads "$THREADS" \
    --worker-class "$WORKER_CLASS" \
    --chdir "$SCRIPT_DIR" \
    --timeout "$TIMEOUT" \
    --bind "$HOST:$PORT" \
    "$APP_MODULE" 2>&1 | tee "$LOG_FILE" &

    # --max-requests "$WORKER_MAX_REQUEST_BEFORE_TERMINATE" \
    # --max-requests-jitter "$WORKER_MAX_REQUEST_JITTER" \

# Capture the PID of the last command in the pipeline (tee)
PIPELINE_PID=$!

# Give Gunicorn a moment to start or fail
sleep 1

# Check if the process is still running. If not, it likely failed to start.
if ! ps -p "$PIPELINE_PID" > /dev/null; then
    echo "❌ Gunicorn failed to start. Review '$LOG_FILE' for errors."
    exit 1
fi

echo "✅ Gunicorn is starting up (PID: $PIPELINE_PID)..."
echo -n "   Waiting for server to become available on port $PORT"

# Robustly wait for the port to be open
while ! nc -z localhost "$PORT"; do
  sleep 0.1
  echo -n "."
done

echo "" # Newline after the dots
echo "🌍 Server is ready! Launching browser at http://localhost:$PORT"

# --- MODIFIED: Cross-platform browser opening ---
if command -v open &> /dev/null; then
  open "http://localhost:$PORT" # macOS
elif command -v xdg-open &> /dev/null; then
  xdg-open "http://localhost:$PORT" # Linux
fi

echo ""
echo "✨ Server is running. Press Ctrl+C in this terminal to shut down."

# The 'wait' command is crucial. It pauses the script here and waits for the
# background pipeline to finish. This keeps the script alive so it can catch
# the Ctrl+C signal.
wait "$PIPELINE_PID"