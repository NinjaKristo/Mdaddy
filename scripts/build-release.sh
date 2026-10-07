#!/usr/bin/env bash
# Full release build: frontend (assets + tsc + vite) THEN the Rust exe (which embeds dist/),
# then copies the exe to release/Mdaddy.exe. Never build the exe without the frontend first.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -d "$HOME/.cargo/bin" ]; then export PATH="$HOME/.cargo/bin:$PATH"; fi
CARGO_BIN="$(command -v cargo || command -v cargo.exe || true)"
if [ -z "$CARGO_BIN" ]; then
  echo "Cargo was not found on PATH." >&2
  exit 1
fi
npx tauri icon Assets/MdaddyIcon-App.svg --output src-tauri/icons
npm run build
(cd src-tauri && "$CARGO_BIN" build --release --bins --features tauri/custom-protocol)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/copy-release.ps1 \
  -Source src-tauri/target/release/mdaddy.exe \
  -Target release/Mdaddy.exe
if ! cmp -s src-tauri/target/release/mdaddy.exe release/Mdaddy.exe; then
  echo "Release executable does not match the build output." >&2
  exit 1
fi
echo "Release executable matches the build output."

# Acceptance gate: run the actual release artifact in an isolated profile.
# The CDP harness exits early with a clear message if another Mdaddy instance is open.
python tests/e2e/smoke.py
python tests/e2e/ui_controls.py
