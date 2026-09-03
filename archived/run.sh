#!/bin/bash
#
# run.sh: Starts the Gunicorn server for the PDF processing app.
# - Uses a gunicorn.conf.py for all configuration.
# - Works when run from terminal or double-clicked.

# --- Configuration & Environment Setup ---
# Get the absolute path of the directory where this script is located.
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
PORT=7001

# Adjust VENV_PATH if you use a different venv manager (e.g., a local 'venv' folder).
VENV_NAME=$(basename "$SCRIPT_DIR")
VENV_PATH="$HOME/.pyenv/versions/$VENV_NAME"
GUNICORN_CMD="$VENV_PATH/bin/gunicorn"

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
echo "   All configuration is loaded from 'gunicorn.conf.py'."
echo "   Logs will be streamed here and also saved to '$LOG_FILE'."

# The command is now much simpler. Gunicorn will automatically find and use gunicorn.conf.py
# when it's in the same directory (or specified with -c).
"$GUNICORN_CMD" --config gunicorn.conf.py app:app 2>&1 | tee "$LOG_FILE" &

PIPELINE_PID=$!
sleep 1

if ! ps -p "$PIPELINE_PID" > /dev/null; then
    echo "❌ Gunicorn failed to start. Review '$LOG_FILE' for errors."
    exit 1
fi

echo "✅ Gunicorn is starting up (PID: $PIPELINE_PID)..."
echo -n "   Waiting for server to become available on port $PORT"

# Wait for the port to be open before proceeding
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