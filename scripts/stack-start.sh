#!/usr/bin/env bash
# Install missing NiN dependencies, then start the web stack and Architect GUI.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=stack-lib.sh
source "$SCRIPT_DIR/stack-lib.sh"

prepend_toolchain_path
ensure_state_dir
trap pause_if_tty EXIT

python_imports_ok() {
  "$ROOT/.venv/bin/python" -c "import pytest,yaml,numpy,torch,fastapi,PyQt6,pyqtgraph,onnx,qdrant_client,ccxt,sklearn,hdbscan,vectorbt" >/dev/null 2>&1
}

deps_are_stale() {
  local stamp="$1"
  local dep
  [[ -f "$stamp" ]] || return 0
  for dep in "$ROOT/pyproject.toml" "$ROOT/Architect/requirements.txt" "$ROOT/package-lock.json"; do
    if [[ -f "$dep" && "$dep" -nt "$stamp" ]]; then
      return 0
    fi
  done
  return 1
}

system_lib_present() {
  local lib="$1"
  [[ -e "/usr/lib/x86_64-linux-gnu/$lib" ]] || ldconfig -p 2>/dev/null | grep -q "$lib"
}

ensure_gui_libs() {
  local lib missing=0
  for lib in libEGL.so.1 libxcb-cursor.so.0 libglib-2.0.so.0 libxkbcommon.so.0 libxkbcommon-x11.so.0; do
    system_lib_present "$lib" || missing=1
  done
  if [[ "$missing" -eq 0 ]]; then
    return 0
  fi
  echo "Installing GUI system libraries required by the Architect terminal..."
  if sudo -n true 2>/dev/null; then
    sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
      libegl1 libgl1 libglib2.0-0 libxkbcommon0 libxkbcommon-x11-0 libdbus-1-3 libfontconfig1 \
      libxcb-cursor0 libx11-xcb1 libxcb-xinerama0 libxcb-icccm4 libxcb-image0 \
      libxcb-keysyms1 libxcb-randr0 libxcb-render-util0 libxcb-shape0
  else
    echo "GUI libraries are missing and sudo is unavailable. The Architect window may not open."
  fi
}

ensure_node() {
  local tsx="$ROOT/node_modules/.bin/tsx"
  if [[ -x "$tsx" && ! "$ROOT/package-lock.json" -nt "$tsx" ]]; then
    echo "Node dependencies are already installed."
    return 0
  fi
  if ! command -v npm >/dev/null 2>&1; then
    echo "npm was not found. Install Node.js 22, then try again." >&2
    return 1
  fi
  echo "Installing Node dependencies (npm ci)..."
  (cd "$ROOT" && npm ci)
}

ensure_python() {
  local py="$ROOT/.venv/bin/python"
  local stamp="$ROOT/.venv/.nin-deps-stamp"
  if [[ ! -x "$py" ]]; then
    echo "Creating the Python virtualenv at .venv..."
    python3 -m venv "$ROOT/.venv"
  fi
  if python_imports_ok && { [[ ! -f "$stamp" ]] || ! deps_are_stale "$stamp"; }; then
    touch "$stamp"
    echo "Python dependencies are already installed."
    return 0
  fi
  echo "Installing Python dependencies (orchestrator, tests, and Architect)..."
  "$ROOT/.venv/bin/pip" install --upgrade pip
  "$ROOT/.venv/bin/pip" install -e "${ROOT}[dev]" pytest pyyaml
  "$ROOT/.venv/bin/pip" install -r "$ROOT/Architect/requirements.txt"
  if ! python_imports_ok; then
    echo "Python dependencies installed, but imports still fail." >&2
    return 1
  fi
  touch "$stamp"
}

web_is_running() {
  local pid listener
  pid="$(read_pid "$WEB_PID_FILE")"
  if pid_alive "$pid" && is_stack_process "$pid"; then
    return 0
  fi
  while read -r listener; do
    [[ -z "$listener" ]] && continue
    if is_stack_process "$listener"; then
      printf '%s\n' "$listener" > "$WEB_PID_FILE"
      return 0
    fi
  done < <(listeners_on_web_port)
  return 1
}

start_web() {
  echo "Starting the web stack on http://127.0.0.1:${WEB_PORT}"
  setsid bash -c 'cd "$1" && exec npm run dev' bash "$ROOT" >"$WEB_LOG" 2>&1 </dev/null &
  echo $! > "$WEB_PID_FILE"
}

wait_for_health() {
  local pid="$1"
  local i
  for i in $(seq 1 90); do
    if curl -sf "http://127.0.0.1:${WEB_PORT}/api/health" >/dev/null; then
      echo "Web stack is ready."
      return 0
    fi
    if ! pid_alive "$pid"; then
      echo "The web stack exited. Last log lines:" >&2
      tail -n 50 "$WEB_LOG" >&2 || true
      return 1
    fi
    sleep 1
  done
  echo "The web stack did not become ready. Last log lines:" >&2
  tail -n 50 "$WEB_LOG" >&2 || true
  return 1
}

gui_is_running() {
  local pid cmd
  pid="$(read_pid "$GUI_PID_FILE")"
  if pid_alive "$pid"; then
    cmd="$(cmdline_of "$pid")"
    case "$cmd" in
      *gui/app.py*) return 0 ;;
    esac
  fi
  while read -r pid; do
    [[ -z "$pid" ]] && continue
    cmd="$(cmdline_of "$pid")"
    case "$cmd" in
      *gui/app.py*)
        if [[ "$(cwd_of "$pid")" == "$ROOT/Architect" ]]; then
          printf '%s\n' "$pid" > "$GUI_PID_FILE"
          return 0
        fi
        ;;
    esac
  done < <(stack_pids)
  return 1
}

start_gui() {
  if [[ -z "${DISPLAY:-}" ]]; then
    echo "DISPLAY is not set, so the Architect window was not opened."
    return 0
  fi
  if gui_is_running; then
    echo "Architect terminal is already running."
    return 0
  fi
  echo "Starting the Architect terminal."
  setsid bash -c 'cd "$1" && export PYTHONPATH="$1${PYTHONPATH:+:$PYTHONPATH}" && export QT_QPA_PLATFORM="${QT_QPA_PLATFORM:-xcb}" && exec "$2" gui/app.py' \
    bash "$ROOT/Architect" "$ROOT/.venv/bin/python" >"$GUI_LOG" 2>&1 </dev/null &
  echo $! > "$GUI_PID_FILE"
  sleep 2
  local pid
  pid="$(read_pid "$GUI_PID_FILE")"
  if ! pid_alive "$pid"; then
    echo "The Architect terminal exited. Last log lines:" >&2
    tail -n 40 "$GUI_LOG" >&2 || true
    return 1
  fi
  echo "Architect terminal is running."
}

main() {
  local started_web=0
  local web_pid foreign

  echo "NiN stack start"
  echo "Repository: $ROOT"
  ensure_gui_libs
  ensure_node
  ensure_python

  if web_is_running; then
    echo "Web stack is already running on http://127.0.0.1:${WEB_PORT}"
  else
    foreign="$(listeners_on_web_port | tr '\n' ' ')"
    if [[ -n "${foreign// /}" ]]; then
      echo "Port ${WEB_PORT} is already used by another program (pid ${foreign})." >&2
      return 1
    fi
    start_web
    web_pid="$(read_pid "$WEB_PID_FILE")"
    wait_for_health "$web_pid"
    started_web=1
  fi

  start_gui

  if [[ "$started_web" -eq 1 && -n "${DISPLAY:-}" && "${NIN_OPEN_BROWSER:-1}" == "1" ]] && command -v xdg-open >/dev/null 2>&1; then
    xdg-open "http://127.0.0.1:${WEB_PORT}" >/dev/null 2>&1 || true
  fi

  echo
  echo "Stack is up."
  echo "  Web UI:  http://127.0.0.1:${WEB_PORT}"
  echo "  Web log: $WEB_LOG"
  echo "  GUI log: $GUI_LOG"
}

main "$@"
