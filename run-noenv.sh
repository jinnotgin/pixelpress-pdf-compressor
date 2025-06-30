#!/bin/bash
#
# run-noenv.sh: Starts the Gunicorn server for the PDF processing app.
# - Assumes 'python3' and 'gunicorn' are in the system PATH.
# - Uses gunicorn.conf.py for all configuration, including the worker monitor.
# - Works when run from terminal or double-clicked.

# --- Configuration & Environment Setup ---
# Get the absolute path of the directory where this script is located.
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
PORT=7001
LOG_FILE="$SCRIPT_DIR/gunicorn.log"
PIPELINE_PID=""


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
    echo "❌ Error: 'python3' is not in your PATH. It is required for the application."
    exit 1
fi
if ! command -v gunicorn &> /dev/null; then
    echo "❌ Error: 'gunicorn' is not in your PATH."
    echo "   Please install it first (e.g., 'pip install gunicorn')."
    exit 1
fi
if [ ! -f "$SCRIPT_DIR/gunicorn.conf.py" ]; then
    echo "❌ Error: Configuration file 'gunicorn.conf.py' not found in script directory."
    exit 1
fi
echo "✅ Environment checks passed."
echo ""

# --- Execution ---
echo "📝 Clearing previous log file: $LOG_FILE"
> "$LOG_FILE"

echo "🚀 Starting Gunicorn server from directory: $SCRIPT_DIR"
echo "   All configuration is loaded from 'gunicorn.conf.py'."
echo "   Logs will be streamed here and also saved to '$LOG_FILE'."

# The command is now simpler and more robust, delegating configuration to the .py file.
# Using 'gunicorn' directly, assuming it's in the system PATH.
gunicorn --config gunicorn.conf.py app:app 2>&1 | tee "$LOG_FILE" &

PIPELINE_PID=$!
sleep 1

if ! ps -p "$PIPELINE_PID" > /dev/null; then
    echo "❌ Gunicorn failed to start. Review '$LOG_FILE' for errors."
    exit 1
fi

echo "✅ Gunicorn is starting up (PID: $PIPELINE_PID)..."
echo -n "   Waiting for server to become available on port $PORT"

# Robustly wait for the port to be open
while ! nc -z localhost "$PORT" 2>/dev/null; do
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