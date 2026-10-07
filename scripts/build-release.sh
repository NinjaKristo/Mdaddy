#!/usr/bin/env bash
# Full release build: frontend (assets + tsc + vite) THEN the Rust exe (which embeds dist/),
# then copies the exe to release/Mdaddy.exe. Never build the exe without the frontend first.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"
npm run build
(cd src-tauri && cargo build --release --bins --features tauri/custom-protocol)
mkdir -p release
cp src-tauri/target/release/mdaddy.exe release/Mdaddy.exe
md5sum src-tauri/target/release/mdaddy.exe release/Mdaddy.exe
