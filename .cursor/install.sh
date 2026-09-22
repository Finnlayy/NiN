#!/usr/bin/env bash
# Cloud Agent bootstrap for this repository.
#
# The repo hosts two applications that share one tree:
#   1. A TypeScript web app  -> React frontend (Vite) + Node HTTP backend (backend/server.ts)
#   2. A Python orchestrator -> the stdlib-only "neu" CLI (core/orchestrator/limbs)
#
# This script is idempotent: it can run repeatedly against cached state.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Installing Node dependencies (frontend + backend)"
npm install

echo "==> Ensuring python venv support is available"
# The default image ships Python 3.12 but not the venv/ensurepip bootstrap wheels.
if ! python3 -c "import ensurepip" >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install -y python3.12-venv
fi

echo "==> Creating Python virtualenv for the orchestrator + dev tooling"
if [ ! -x .venv/bin/python ]; then
  python3 -m venv .venv
fi
.venv/bin/pip install --upgrade pip
# Runtime is stdlib-only; these are dev/test tools:
#   - editable install exposes the "neu" console script + ruff/mypy (pyproject [dev])
#   - pytest + pyyaml run the orchestrator suite and the eval harness
.venv/bin/pip install -e ".[dev]" pytest pyyaml

echo "==> Building the production web bundle (frontend assets + server.cjs)"
npm run build

echo "==> Install complete."
