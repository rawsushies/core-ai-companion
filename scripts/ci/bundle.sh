#!/usr/bin/env bash
# Builds what the installer bundles besides COre's own files (CI, Windows runner):
#   vendor/cortex   Cortex.exe (the knowledge engine, built from its own PyInstaller recipe)
#   vendor/models   the local AI models (speech recognition, voice, memory embeddings)
# The Cortex commit is pinned (CORTEX_REF overrides it) and PyInstaller's version is pinned in
# bundle-requirements.txt, so the same commit always builds the same Cortex.exe.
set -euo pipefail
CORTEX_REF="${CORTEX_REF:-6b2abcd98cb9f731e0ee40e8d8dfa50c8608dfd4}" # rawsushies/cortex-ai-brain cortex-2: memory gateway, structured results, review (M1-M3); CI tests run against this same commit
src="${RUNNER_TEMP:-/tmp}/cortex-src"
rm -rf "$src" vendor/cortex vendor/models
mkdir -p "$src"
git -C "$src" init -q
git -C "$src" remote add origin https://github.com/rawsushies/cortex-ai-brain
for i in 1 2 3; do git -C "$src" fetch -q --depth 1 origin "$CORTEX_REF" && break; [ "$i" = 3 ] && exit 1; sleep $((i * 10)); done
git -C "$src" checkout -q FETCH_HEAD
# Package index hiccups on CI runners happen ("from versions: none"): retry with backoff.
for i in 1 2 3 4; do python -m pip install -q --retries 5 --timeout 60 -r scripts/ci/bundle-requirements.txt && break; [ "$i" = 4 ] && exit 1; sleep $((i * 15)); done
(cd "$src" && python -m PyInstaller --noconfirm --distpath dist packaging/cortex.spec)
mkdir -p vendor
cp -r "$src/dist/Cortex" vendor/cortex
echo "rawsushies/cortex-ai-brain $(git -C "$src" rev-parse HEAD)" > vendor/cortex/SOURCE.txt
test -f vendor/cortex/Cortex.exe || test -f vendor/cortex/Cortex
for i in 1 2 3; do node scripts/prefetch-models.mjs vendor/models && break; [ "$i" = 3 ] && exit 1; sleep $((i * 20)); done
du -sh vendor/cortex vendor/models
