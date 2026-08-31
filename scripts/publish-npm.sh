#!/usr/bin/env bash
# Publish @chorus/shared, @chorus/client, and @chorus/plugin to npm in dependency order.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PACKAGES=("@chorus/shared" "@chorus/client" "@chorus/plugin")
PACKAGE_DIRS=(shared client plugin)

VERSION="$(node -p "require('./packages/plugin/package.json').version")"

echo "Publishing Chorus npm packages at version ${VERSION}"

for dir in "${PACKAGE_DIRS[@]}"; do
  pkg_version="$(node -p "require('./packages/${dir}/package.json').version")"
  if [ "$pkg_version" != "$VERSION" ]; then
    echo "Version mismatch: packages/${dir} is ${pkg_version}, expected ${VERSION}" >&2
    exit 1
  fi
done

if [ -n "${EXPECTED_VERSION:-}" ] && [ "$VERSION" != "$EXPECTED_VERSION" ]; then
  echo "Manifest version ${VERSION} does not match expected ${EXPECTED_VERSION}" >&2
  exit 1
fi

bun run build:shared
bun run build:client
bun run build:plugin

DRY_RUN="${DRY_RUN:-false}"
PROVENANCE="${PROVENANCE:-true}"

publish_one() {
  local workspace="$1"
  local flags=(--access public)

  if [ "$PROVENANCE" = "true" ]; then
    flags+=(--provenance)
  fi

  if [ "$DRY_RUN" = "true" ]; then
    echo "Dry run: npm publish -w ${workspace} ${flags[*]}"
    npm publish -w "$workspace" "${flags[@]}" --dry-run
    return 0
  fi

  if npm view "${workspace}@${VERSION}" version >/dev/null 2>&1; then
    echo "${workspace}@${VERSION} is already on npm; skipping"
    return 0
  fi

  echo "Publishing ${workspace}@${VERSION}"
  npm publish -w "$workspace" "${flags[@]}"
}

for workspace in "${PACKAGES[@]}"; do
  publish_one "$workspace"
done

echo "npm publish complete"
