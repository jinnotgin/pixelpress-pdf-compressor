#!/bin/bash
#
# setup.sh (Simplified Version): Installs Python dependencies globally.
# This script does NOT use a virtual environment.

# Stop the script if any command fails
set -e

# --- Configuration ---
REQUIREMENTS_FILE="requirements.txt"
PYTHON_CMD="python3"

# --- Main Script ---
echo "🚀 Starting simplified project setup..."
echo "⚠️  NOTE: This script will install packages globally using pip3."
echo "    For better dependency management, using a virtual environment is recommended."
echo ""

# 1. Check if Python 3 is installed
echo "--> Checking for Python 3..."
if ! command -v $PYTHON_CMD &> /dev/null; then
    echo "❌ Error: Python 3 ('$PYTHON_CMD') is not installed or not in your PATH."
    echo "   Please install Python 3 to continue."
    exit 1
fi
echo "✅ Python 3 found."

# 2. Check if requirements.txt exists
echo "--> Checking for $REQUIREMENTS_FILE..."
if [ ! -f "$REQUIREMENTS_FILE" ]; then
    echo "❌ Error: The '$REQUIREMENTS_FILE' file was not found."
    echo "   Please create it and list your project's dependencies."
    exit 1
fi
echo "✅ $REQUIREMENTS_FILE found."

# 3. Install/update dependencies using the system's pip3
echo "--> Installing/updating dependencies from $REQUIREMENTS_FILE..."
# Ensure pip is up-to-date
"$PYTHON_CMD" -m pip install --upgrade pip

# Install the packages
"$PYTHON_CMD" -m pip install -r "$REQUIREMENTS_FILE"
echo "✅ Dependencies installed successfully."

# 4. Provide next steps
echo ""
echo "🎉 Setup complete! 🎉"
echo ""
echo "You can now start the server directly by running:"
echo "   ./run.sh"
echo ""