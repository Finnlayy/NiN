#!/usr/bin/env bash
# Stop the NiN web stack and the Architect terminal.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=stack-lib.sh
source "$SCRIPT_DIR/stack-lib.sh"

ensure_state_dir
trap pause_if_tty EXIT

main() {
  local -a pids=()
  local -A seen=()
  local -a unique=()
  local pid file

  echo "NiN stack stop"
  echo "Repository: $ROOT"

  while read -r pid; do
    [[ -z "$pid" ]] && continue
    pids+=("$pid")
  done < <(stack_pids)

  for file in "$WEB_PID_FILE" "$GUI_PID_FILE"; do
    pid="$(read_pid "$file")"
    if pid_alive "$pid"; then
      pids+=("$pid")
    fi
  done

  while read -r pid; do
    [[ -z "$pid" ]] && continue
    if is_stack_process "$pid"; then
      pids+=("$pid")
    fi
  done < <(listeners_on_web_port)

  if [[ ${#pids[@]} -eq 0 ]]; then
    rm -f "$WEB_PID_FILE" "$GUI_PID_FILE"
    echo "Stack is already stopped."
    return 0
  fi

  for pid in "${pids[@]}"; do
    if [[ -z "${seen[$pid]:-}" ]]; then
      seen[$pid]=1
      unique+=("$pid")
    fi
  done

  echo "Stopping ${#unique[@]} process(es)..."
  for pid in "${unique[@]}"; do
    echo "  pid ${pid}  $(cmdline_of "$pid")"
  done
  for pid in "${unique[@]}"; do
    kill_group "$pid"
  done

  sleep 0.5
  while read -r pid; do
    [[ -z "$pid" ]] && continue
    echo "  still running pid ${pid}, stopping again"
    kill_group "$pid"
  done < <(stack_pids)

  rm -f "$WEB_PID_FILE" "$GUI_PID_FILE"
  echo "Stack is stopped."
}

main "$@"
