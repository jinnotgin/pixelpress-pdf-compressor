#!/bin/bash
#
# setup.sh (Fully Automated & Robust Version): Installs Homebrew, Python build
# dependencies, pyenv, and the pyenv-virtualenv plugin.
# This version works correctly when run from the command line OR by double-clicking.

# Stop the script if any command fails
set -e

# --- Configuration ---
# Get the absolute path of the directory where this script is located. This makes
# the script robust and runnable from anywhere, including by double-clicking.
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"

# Set the desired Python major/minor version. The script will find the latest patch.
PYTHON_VERSION="3.12"
# Name the virtual environment after the script's parent directory.
VENV_NAME=$(basename "$SCRIPT_DIR")
# Use the full path for the requirements file for robustness.
REQUIREMENTS_FILE="$SCRIPT_DIR/requirements.txt"
PYENV_ROOT="$HOME/.pyenv"

# This variable will be updated with the full version string (e.g., 3.11.7)
LATEST_PYTHON_VERSION=""

# --- Helper Functions ---
# Detects the user's shell profile file (.zshrc, .bash_profile, etc.)
get_shell_profile() {
    if [ -n "$ZSH_VERSION" ] || [ -n "$BASH" ] && [ "$(ps -p $$ -o comm=)" = "zsh" ]; then
        echo "$HOME/.zshrc"
    elif [ -n "$BASH_VERSION" ]; then
        if [ -f "$HOME/.bash_profile" ]; then
            echo "$HOME/.bash_profile"
        else
            echo "$HOME/.bashrc"
        fi
    else
        echo "$HOME/.profile"
    fi
}

# --- Main Script ---
echo "🚀 Starting fully automated project setup using pyenv-virtualenv..."
echo "Project Directory: '$SCRIPT_DIR'"
echo "Virtual environment will be named: '$VENV_NAME'"
echo ""

# 1. Check for and install Homebrew if on macOS
if [[ "$(uname)" == "Darwin" ]]; then
    echo "--> Checking for Homebrew..."
    if ! command -v brew &> /dev/null; then
        echo "⚠️  Homebrew is not installed, but it is required to continue."
        read -p "Press ENTER to install Homebrew automatically, or Ctrl+C to exit."
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
        
        echo "--> Adding Homebrew to your PATH for the current session..."
        if [ -x "/opt/homebrew/bin/brew" ]; then eval "$(/opt/homebrew/bin/brew shellenv)"; fi
        if [ -x "/usr/local/bin/brew" ]; then eval "$(/usr/local/bin/brew shellenv)"; fi
        
        echo "✅ Homebrew installed and configured."
    else
        echo "✅ Homebrew found."
    fi
fi

# 2. Check for pyenv and install if missing
echo "--> Checking for pyenv..."
if ! command -v pyenv &> /dev/null; then
    brew install pyenv
    echo "✅ pyenv installed."
else
    echo "✅ pyenv found."
fi

# 3. Ensure Python build dependencies are installed (macOS only)
if [[ "$(uname)" == "Darwin" ]]; then
    echo "--> Ensuring Python build dependencies are installed..."
    brew install openssl readline sqlite3 xz zlib tcl-tk@8 libb2
    echo "✅ Build dependencies are up to date."
fi

# Initialize pyenv for the current session to make its sub-commands available
export PATH="$PYENV_ROOT/bin:$PATH"
eval "$(pyenv init --path)"

# 4. Check for pyenv-virtualenv plugin
echo "--> Checking for pyenv-virtualenv plugin..."
if ! pyenv help virtualenv &> /dev/null; then
    echo "pyenv-virtualenv plugin not found. Installing with Homebrew..."
    brew install pyenv-virtualenv
    echo "✅ pyenv-virtualenv installed."
else
    echo "✅ pyenv-virtualenv plugin found."
fi

# 5. Configure Shell for pyenv and pyenv-virtualenv
PROFILE_FILE=$(get_shell_profile)
echo "--> Checking shell configuration in $PROFILE_FILE..."
if ! grep -q 'pyenv virtualenv-init' "$PROFILE_FILE"; then
    echo "⚠️  Adding pyenv and pyenv-virtualenv config to your shell profile ($PROFILE_FILE)."
    echo '' >> "$PROFILE_FILE"
    echo '# --- pyenv & pyenv-virtualenv configuration ---' >> "$PROFILE_FILE"
    echo 'export PYENV_ROOT="$HOME/.pyenv"' >> "$PROFILE_FILE"
    echo 'export PATH="$PYENV_ROOT/bin:$PATH"' >> "$PROFILE_FILE"
    echo 'eval "$(pyenv init --path)"' >> "$PROFILE_FILE"
    echo 'eval "$(pyenv init -)"' >> "$PROFILE_FILE"
    echo 'eval "$(pyenv virtualenv-init -)"' >> "$PROFILE_FILE"
    echo ""
    echo "‼️  IMPORTANT: Your shell profile has been updated. Please restart your terminal after this script finishes."
    echo ""
fi
echo "✅ Shell is configured."

# Initialize the full environment for the *current* script session
eval "$(pyenv init -)"
eval "$(pyenv virtualenv-init -)"

# 6. Find and install the required Python version
echo "--> Checking for a Python $PYTHON_VERSION.x version..."
LATEST_PYTHON_VERSION=$(pyenv install --list | grep -E "^\s*$PYTHON_VERSION\.[0-9]+$" | tail -n 1 | tr -d '[:space:]')

if [ -z "$LATEST_PYTHON_VERSION" ]; then
    echo "❌ Error: No installable version found for Python $PYTHON_VERSION."
    exit 1
fi

if ! pyenv versions --bare | grep -q "^$LATEST_PYTHON_VERSION$"; then
    echo "Installing latest available version: Python $LATEST_PYTHON_VERSION (this may take a few minutes)..."
    pyenv install "$LATEST_PYTHON_VERSION"
fi
echo "✅ Python $LATEST_PYTHON_VERSION is available."

# 7. Create the virtual environment
echo "--> Checking for virtual environment '$VENV_NAME'..."
if [ ! -d "$PYENV_ROOT/versions/$VENV_NAME" ]; then
    echo "Creating virtual environment '$VENV_NAME' with Python $LATEST_PYTHON_VERSION..."
    pyenv virtualenv "$LATEST_PYTHON_VERSION" "$VENV_NAME"
    echo "✅ Virtual environment created."
else
    echo "✅ Virtual environment '$VENV_NAME' already exists."
fi

# 8. Set the local environment for auto-activation
echo "--> Setting project to use '$VENV_NAME' automatically..."
pyenv local "$VENV_NAME"
echo "✅ Done. This directory will now auto-activate the '$VENV_NAME' environment."

# 9. Install/update dependencies into the virtual environment
echo "--> Checking for $REQUIREMENTS_FILE..."
if [ ! -f "$REQUIREMENTS_FILE" ]; then
    echo "❌ Error: '$REQUIREMENTS_FILE' not found."
    exit 1
fi
echo "✅ $REQUIREMENTS_FILE found."

echo "--> Installing dependencies into '$VENV_NAME'..."
VENV_PYTHON="$PYENV_ROOT/versions/$VENV_NAME/bin/python"
"$VENV_PYTHON" -m pip install --upgrade pip
"$VENV_PYTHON" -m pip install -r "$REQUIREMENTS_FILE"
echo "✅ Dependencies installed successfully."

# 10. Provide next steps
echo ""
echo "🎉 Setup complete! 🎉"
echo ""
echo "Thanks to pyenv-virtualenv, the '$VENV_NAME' environment will activate"
echo "automatically whenever you enter this directory in a new terminal."
echo ""
echo "You can now run the application directly:"
echo "   ./run.sh"
echo ""