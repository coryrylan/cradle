#!/bin/bash
set -euo pipefail

BASE_URL="${CRADLE_BASE_URL:-https://coryrylan.github.io/cradle/bin}"
INSTALL_DIR="$HOME/.local/bin"
BIN_NAME="cradle"
ASSET_NAME="cradle"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Detect OS and architecture
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin)
    case "$ARCH" in
      arm64) TARGET="$ASSET_NAME-macos-arm64" ;;
      x86_64) TARGET="$ASSET_NAME-macos-x64" ;;
      *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
    esac
    ;;
  Linux)
    case "$ARCH" in
      x86_64) TARGET="$ASSET_NAME-linux-x64" ;;
      aarch64) TARGET="$ASSET_NAME-linux-arm64" ;;
      *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
    esac
    ;;
  *)
    echo "Unsupported OS: $OS"
    echo "For Windows, download the binary manually from:"
    echo "  $BASE_URL/$ASSET_NAME-windows-x64.exe"
    exit 1
    ;;
esac

echo "Detected $OS ($ARCH)"

# Use local binary if available (in dist/ relative to script), otherwise download
if [ -f "$SCRIPT_DIR/dist/$TARGET" ]; then
  echo "Installing from local build..."
  SOURCE="$SCRIPT_DIR/dist/$TARGET"
else
  echo "Downloading $TARGET..."
  SOURCE="$(mktemp)"
  curl -fsSL "$BASE_URL/$TARGET" -o "$SOURCE"
fi

chmod +x "$SOURCE"

DEST="$INSTALL_DIR/$BIN_NAME"

# A fresh machine has no ~/.local/bin; [ -w ] is false for a missing dir, which
# would wrongly escalate to sudo and then fail cp into a nonexistent directory.
mkdir -p "$INSTALL_DIR"

if [ -w "$INSTALL_DIR" ]; then
  cp "$SOURCE" "$DEST"
else
  echo "Installing to $INSTALL_DIR (requires sudo)..."
  sudo cp "$SOURCE" "$DEST"
fi

# macOS requires ad-hoc code signature for binaries to execute
if [ "$OS" = "Darwin" ] && command -v codesign >/dev/null 2>&1; then
  codesign --sign - --force "$DEST" 2>/dev/null || echo "Ad-hoc code signing failed — binary may not run."
fi

echo "Installed $BIN_NAME to $DEST"
echo ""
echo "Run '$BIN_NAME --help' to get started."
