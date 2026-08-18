#!/usr/bin/env bash
# Idempotent Cloud Agent bootstrap for Chorus (Bun + OpenCode + build).
set -euo pipefail
export PATH="${HOME}/.bun/bin:${HOME}/.opencode/bin:${HOME}/.cargo/bin:/usr/local/cargo/bin:${PATH}"

if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
  export PATH="${HOME}/.bun/bin:${PATH}"
fi

if ! command -v opencode >/dev/null 2>&1; then
  curl -fsSL https://opencode.ai/install | bash
  export PATH="${HOME}/.opencode/bin:${PATH}"
fi

bun install
bun run build
