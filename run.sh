#!/bin/bash
#
# run.sh: Starts the Gunicorn server, automatically using the
# virtual environment created by the setup script.

# --- Configuration ---
PORT=7001
HOST="0.0.0.0"
APP_MODULE="app:app"
TIMEOUT=1200
LOG_FILE="gunicorn.log"

# --- Virtual Environment Configuration ---
# Determine the virtual environment name from the current directory name.
VENV_NAME=$(basename "$PWD")
# Path to virtualenvs managed by pyenv-virtualenv
VENV_PATH="$HOME/.pyenv/versions/$VENV_NAME"
# Define the full path to the gunicorn command inside the virtual environment.
GUNICORN_CMD="$VENV_PATH/bin/gunicorn"

# ... (The rest of the script is unchanged and will work perfectly)
PIPELINE_PID=""

shutdown_server() {
    # ...
    echo ""
    echo "🛑 Initiating shutdown..."
    if [ -n "$PIPELINE_PID" ] && ps -p "$PIPELINE_PID" > /dev/null; then
        echo "   Killing process group (PID: $PIPELINE_PID)..."
        kill "$PIPELINE_PID"
        wait "$PIPELINE_PID" 2>/dev/null
        echo "✅ Server stopped."
    else
        echo "   Server process not found. Was it already stopped?"
    fi
    exit 0
}

trap 'shutdown_server' SIGINT SIGTERM

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

echo "📝 Clearing previous log file: $LOG_FILE"
> "$LOG_FILE"

echo "🚀 Starting Gunicorn server..."
echo "   Logs will be streamed here and also saved to '$LOG_FILE'."

"$GUNICORN_CMD" --timeout "$TIMEOUT" --bind "$HOST:$PORT" "$APP_MODULE" 2>&1 | tee "$LOG_FILE" &

PIPELINE_PID=$!

sleep 1

if ! ps -p "$PIPELINE_PID" > /dev/null; then
    echo "❌ Gunicorn failed to start. Review '$LOG_FILE' for errors."
    exit 1
fi

echo "✅ Gunicorn is starting up (PID: $PIPELINE_PID)..."
echo -n "   Waiting for server to become available on port $PORT"

while ! nc -z localhost "$PORT"; do
  sleep 0.1
  echo -n "."
done

echo ""
echo "🌍 Server is ready! Launching browser at http://localhost:$PORT"

open "http://localhost:$PORT"

echo ""
echo "✨ Server is running. Press Ctrl+C in this terminal to shut down."

wait "$PIPELINE_PID"