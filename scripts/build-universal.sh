#!/bin/sh
# Builds a universal (arm64 + x86_64) propvim.app and .dmg.
# Uses the project-local toolchain in .toolchain/ when present (see README);
# otherwise the rustup toolchain on PATH, which needs both targets:
#   rustup target add aarch64-apple-darwin x86_64-apple-darwin
set -eu
cd "$(dirname "$0")/.."
if [ -d .toolchain/rustup ]; then
  export RUSTUP_HOME="$PWD/.toolchain/rustup" CARGO_HOME="$PWD/.toolchain/cargo"
  export PATH="$CARGO_HOME/bin:$(dirname "$(RUSTUP_HOME=$RUSTUP_HOME ~/.cargo/bin/rustup which rustc)"):$PATH"
fi
npx tauri build --target universal-apple-darwin "$@"
