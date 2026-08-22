#!/usr/bin/env bash
# Build the WASM package into engine/pkg/ for the web UI to import.
set -euo pipefail
cd "$(dirname "$0")"
exec wasm-pack build --target web --release --out-dir pkg
