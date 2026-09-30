#!/usr/bin/env bash
# Shared paths and process helpers for the NiN desktop stack.

if [[ -z "${BASH_VERSION:-}" ]]; then
  echo "These scripts need bash." >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${XDG_RUNTIME_DIR:-/tmp}/nin-stack"
WEB_PID_FILE="$STATE_DIR/web.pid"
GUI_PID_FILE="$STATE_DIR/gui.pid"
OLLAMA_PID_FILE="$STATE_DIR/ollama.pid"
WEB_LOG="$STATE_DIR/web.log"
GUI_LOG="$STATE_DIR/gui.log"
OLLAMA_LOG="$STATE_DIR/ollama.log"
WEB_PORT=3000
OLLAMA_PORT=11434

prepend_toolchain_path() {
  local nvm_root="$HOME/.nvm/versions/node"
  local version="" bin=""
  if [[ -d "$nvm_root" ]]; then
    version="$(find "$nvm_root" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null | sort -V | tail -1 || true)"
    bin="$nvm_root/${version}/bin"
    if [[ -n "$version" && -x "$bin/node" ]]; then
      export PATH="$bin:$PATH"
    fi
  fi
  export PATH="/usr/local/bin:/usr/bin:/bin:${PATH:-}"
  hash -r
}

ensure_state_dir() {
  mkdir -p "$STATE_DIR"
}

pid_alive() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

read_pid() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  tr -d '[:space:]' < "$file"
}

cmdline_of() {
  local pid="$1"
  [[ -r "/proc/${pid}/cmdline" ]] || return 0
  tr '\0' ' ' < "/proc/${pid}/cmdline" 2>/dev/null || true
}

cwd_of() {
  readlink -f "/proc/${1}/cwd" 2>/dev/null || true
}

is_stack_process() {
  local pid="$1"
  local cwd path
  [[ "$pid" == "$$" || "$pid" == "${PPID:-}" ]] && return 1
  cwd="$(cwd_of "$pid")"
  [[ "$cwd" == "$ROOT" || "$cwd" == "$ROOT/Architect" ]] || return 1
  path="/proc/${pid}/cmdline"
  [[ -r "$path" ]] || return 1
  if grep -a -z -q -e 'backend/server.ts' -e 'gui/app.py' "$path"; then
    return 0
  fi
  grep -a -z -q -x 'npm' "$path" && grep -a -z -q -x 'run' "$path" && grep -a -z -q -x 'dev' "$path"
}

# Print pids of the web server and Architect GUI, one per line.
stack_pids() {
  local pid nullglob_was=0
  shopt -q nullglob && nullglob_was=1
  shopt -s nullglob
  for pid in /proc/[0-9]*; do
    pid="${pid#/proc/}"
    if is_stack_process "$pid"; then
      printf '%s\n' "$pid"
    fi
  done
  [[ "$nullglob_was" -eq 1 ]] || shopt -u nullglob
}

listeners_on_port() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true
  fi
}

listeners_on_web_port() {
  listeners_on_port "$WEB_PORT"
}

is_ollama_process() {
  local pid="$1"
  local path="/proc/${pid}/cmdline"
  [[ "$pid" == "$$" || "$pid" == "${PPID:-}" ]] && return 1
  [[ -r "$path" ]] || return 1
  grep -a -z -q 'ollama' "$path" || return 1
  grep -a -z -q -x 'serve' "$path" && return 0
  grep -a -z -q -x 'runner' "$path"
}

# Print pids of ollama serve and its runner, one per line.
ollama_pids() {
  local pid nullglob_was=0
  shopt -q nullglob && nullglob_was=1
  shopt -s nullglob
  for pid in /proc/[0-9]*; do
    pid="${pid#/proc/}"
    if is_ollama_process "$pid"; then
      printf '%s\n' "$pid"
    fi
  done
  [[ "$nullglob_was" -eq 1 ]] || shopt -u nullglob
}

kill_group() {
  local pid="$1"
  local i
  pid_alive "$pid" || return 0
  kill -TERM -- "-${pid}" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  for i in 1 2 3 4 5 6 7 8; do
    pid_alive "$pid" || return 0
    sleep 0.25
  done
  kill -KILL -- "-${pid}" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
}

pause_if_tty() {
  if [[ -t 0 && "${NIN_NO_PAUSE:-}" != "1" ]]; then
    echo
    read -r -p "Press Enter to close..." _ || true
  fi
}
