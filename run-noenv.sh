#!/bin/bash

# --- Configuration ---
PORT=7001
HOST="0.0.0.0"
APP_MODULE="app:app"
TIMEOUT=1200
LOG_FILE="gunicorn.log"

# This will hold the Process ID (PID) of the background pipeline.
# Note: In a pipeline, $! gives the PID of the *last* command (tee).
# Killing tee will cause gunicorn to terminate gracefully.
PIPELINE_PID=""

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

# Clear the log file from the previous run.
# Use 'tee -a' below if you want to append to logs instead of overwriting.
echo "📝 Clearing previous log file: $LOG_FILE"
> "$LOG_FILE"

echo "🚀 Starting Gunicorn server..."
echo "   Logs will be streamed here and also saved to '$LOG_FILE'."

# Start Gunicorn, redirect its stderr to stdout, and pipe everything to 'tee'.
# 'tee' will print to the console AND write to the log file.
# The '&' runs the entire pipeline in the background.
gunicorn --timeout "$TIMEOUT" --bind "$HOST:$PORT" "$APP_MODULE" 2>&1 | tee "$LOG_FILE" &

# Capture the PID of the last command in the pipeline (tee)
PIPELINE_PID=$!

# Give Gunicorn a moment to start or fail
sleep 1

# Check if the process is still running. If not, it likely failed to start.
if ! ps -p "$PIPELINE_PID" > /dev/null; then
    echo "❌ Gunicorn failed to start. Review the output above for details."
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

# Open the URL in the default browser on macOS
open "http://localhost:$PORT"

echo ""
echo "✨ Server is running. Press Ctrl+C in this terminal to shut down."

# The 'wait' command is crucial. It pauses the script here and waits for the
# background pipeline to finish. This keeps the script alive so it can catch
# the Ctrl+C signal.
wait "$PIPELINE_PID"