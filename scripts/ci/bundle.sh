#!/usr/bin/env bash
# Builds what the installer bundles besides COre's own files (CI, Windows runner):
#   vendor/cortex   Cortex.exe (the knowledge engine, built from its own PyInstaller recipe)
#   vendor/models   the local AI models (speech recognition, voice, memory embeddings)
# CORTEX_REF picks the Cortex branch/tag (default main); the commit is recorded.
set -euo pipefail
src="${RUNNER_TEMP:-/tmp}/cortex-src"
rm -rf "$src" vendor/cortex vendor/models
git clone --depth 1 --branch "${CORTEX_REF:-main}" https://github.com/rawsushies/cortex-ai-brain "$src"
# Package index hiccups on CI runners happen ("from versions: none"): retry with backoff.
for i in 1 2 3 4; do python -m pip install -q --retries 5 --timeout 60 pyinstaller && break; [ "$i" = 4 ] && exit 1; sleep $((i * 15)); done
(cd "$src" && python -m PyInstaller --noconfirm --distpath dist packaging/cortex.spec)
mkdir -p vendor
cp -r "$src/dist/Cortex" vendor/cortex
echo "rawsushies/cortex-ai-brain $(git -C "$src" rev-parse HEAD)" > vendor/cortex/SOURCE.txt
test -f vendor/cortex/Cortex.exe || test -f vendor/cortex/Cortex
for i in 1 2 3; do node scripts/prefetch-models.mjs vendor/models && break; [ "$i" = 3 ] && exit 1; sleep $((i * 20)); done
du -sh vendor/cortex vendor/models
