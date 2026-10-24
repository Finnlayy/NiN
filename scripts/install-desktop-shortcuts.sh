#!/usr/bin/env bash
# Place Start NiN and Stop NiN icons on the desktop and in the application menu.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=stack-lib.sh
source "$SCRIPT_DIR/stack-lib.sh"

CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}"
APPS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
DESKTOP_DIR="${XDG_DESKTOP_DIR:-$HOME/Desktop}"

if [[ -f "$CONFIG_DIR/user-dirs.dirs" ]]; then
  # shellcheck disable=SC1091
  source "$CONFIG_DIR/user-dirs.dirs"
  DESKTOP_DIR="${XDG_DESKTOP_DIR:-$DESKTOP_DIR}"
fi

mkdir -p "$DESKTOP_DIR" "$APPS_DIR" "$CONFIG_DIR"

if [[ ! -f "$CONFIG_DIR/user-dirs.dirs" ]]; then
  cat > "$CONFIG_DIR/user-dirs.dirs" <<EOF
XDG_DESKTOP_DIR="\$HOME/Desktop"
XDG_DOWNLOAD_DIR="\$HOME/Downloads"
XDG_DOCUMENTS_DIR="\$HOME/Documents"
XDG_PICTURES_DIR="\$HOME/Pictures"
EOF
fi

write_desktop_file() {
  local template="$1"
  local dest="$2"
  python3 - "$template" "$dest" "$ROOT" <<'PY'
import pathlib
import sys

template, dest, root = sys.argv[1:]
text = pathlib.Path(template).read_text(encoding="utf-8")
pathlib.Path(dest).write_text(text.replace("@ROOT@", root), encoding="utf-8")
PY
  chmod 755 "$dest"
  if command -v gio >/dev/null 2>&1; then
    local sum
    sum="$(sha256sum "$dest" | awk '{print $1}')"
    gio set "$dest" metadata::xfce-exe-checksum "$sum" >/dev/null 2>&1 || true
  fi
  echo "Installed $dest"
}

write_desktop_file "$ROOT/desktop/nin-start.desktop.in" "$DESKTOP_DIR/Start NiN.desktop"
write_desktop_file "$ROOT/desktop/nin-stop.desktop.in" "$DESKTOP_DIR/Stop NiN.desktop"
write_desktop_file "$ROOT/desktop/nin-start.desktop.in" "$APPS_DIR/nin-start.desktop"
write_desktop_file "$ROOT/desktop/nin-stop.desktop.in" "$APPS_DIR/nin-stop.desktop"

if command -v xfconf-query >/dev/null 2>&1; then
  style="$(xfconf-query -c xfce4-desktop -p /desktop-icons/style 2>/dev/null || true)"
  if [[ -z "$style" || "$style" == "0" ]]; then
    xfconf-query -c xfce4-desktop -p /desktop-icons/style -n -t int -s 2 || true
    echo "Enabled desktop icons."
  fi
fi

if [[ -z "${DISPLAY:-}" && -S /tmp/.X11-unix/X1 ]]; then
  export DISPLAY=:1
fi
if command -v xfdesktop >/dev/null 2>&1 && [[ -n "${DISPLAY:-}" ]]; then
  xfdesktop --reload >/dev/null 2>&1 || true
fi

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true
fi

echo "Desktop shortcuts are ready in $DESKTOP_DIR"
