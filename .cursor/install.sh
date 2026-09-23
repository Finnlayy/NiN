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

echo "==> Ensuring kraken-cli is installed (market data + paper trading only)"
# The web app's backend/kraken.ts shells out to the native `kraken` binary for
# public market data (ticker/orderbook) and simulated paper trading. No API
# credentials are used and no live orders are placed by this connection.
# Idempotent: only install when the binary is missing.
if ! command -v kraken >/dev/null 2>&1 && [ ! -x /usr/local/cargo/bin/kraken ]; then
  # kraken-cli is not published on crates.io, so install the prebuilt release binary.
  KRAKEN_CLI_VERSION="v0.4.1"
  KRAKEN_CLI_ASSET="kraken-cli-x86_64-unknown-linux-gnu.tar.gz"
  KRAKEN_CLI_URL="https://github.com/krakenfx/kraken-cli/releases/download/${KRAKEN_CLI_VERSION}/${KRAKEN_CLI_ASSET}"
  tmp_dir="$(mktemp -d)"
  curl -sSL -o "${tmp_dir}/kraken-cli.tar.gz" "${KRAKEN_CLI_URL}"
  tar -xzf "${tmp_dir}/kraken-cli.tar.gz" -C "${tmp_dir}"
  kraken_bin="$(find "${tmp_dir}" -type f -name kraken | head -n1)"
  install -m 0755 "${kraken_bin}" /usr/local/cargo/bin/kraken
  rm -rf "${tmp_dir}"
fi
kraken --version || /usr/local/cargo/bin/kraken --version

echo "==> Building the production web bundle (frontend assets + server.cjs)"
npm run build

echo "==> Install complete."
