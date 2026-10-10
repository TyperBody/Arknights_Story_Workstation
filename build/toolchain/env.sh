# Local, project-scoped build environment (nothing installed system-wide).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export CARGO_HOME="$ROOT/build/toolchain/cargo"
export RUSTUP_HOME="$ROOT/build/toolchain/rustup"
export PATH="$CARGO_HOME/bin:$PATH"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR_OVERRIDE:-$ROOT/build/toolchain/target}"
