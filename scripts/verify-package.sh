#!/usr/bin/env bash
# Verify the npm package contents before publishing.
# Run manually: bash scripts/verify-package.sh
# Not intended for CI — CI uses the prepublishOnly gate.

set -euo pipefail

echo "=== PureContext MCP — package verification ==="
echo ""

# ---- 1. Check dist/ exists and is non-empty -------------------------
if [ ! -d "dist" ] || [ -z "$(ls -A dist 2>/dev/null)" ]; then
  echo "ERROR: dist/ is missing or empty. Run: npm run build"
  exit 1
fi
echo "OK  dist/ exists and is non-empty"

# ---- 2. Check grammars are present ----------------------------------
WASM_COUNT=$(find grammars -name "*.wasm" 2>/dev/null | wc -l)
if [ "$WASM_COUNT" -eq 0 ]; then
  echo "ERROR: no .wasm files found in grammars/"
  exit 1
fi
echo "OK  grammars/ contains $WASM_COUNT .wasm file(s)"

# ---- 3. Dry-run pack and inspect the file list ----------------------
echo ""
echo "--- npm pack --dry-run output ---"
PACK_OUTPUT=$(npm pack --dry-run 2>&1)
echo "$PACK_OUTPUT" | head -60

# ---- 4. Assert required files are present ---------------------------
echo ""
echo "--- Checking required files ---"
REQUIRED=(
  "package/dist/index.js"
  "package/scripts/check-sqlite.js"
)

for FILE in "${REQUIRED[@]}"; do
  if echo "$PACK_OUTPUT" | grep -q "$FILE"; then
    echo "OK  $FILE"
  else
    echo "MISSING  $FILE"
    FAILED=1
  fi
done

# ---- 5. Assert excluded paths are absent ----------------------------
echo ""
echo "--- Checking excluded paths ---"
EXCLUDED=(
  "test/"
  "benchmarks/"
  "src/core/"
  "src/handlers/"
  ".ts"
)

for PATTERN in "${EXCLUDED[@]}"; do
  if echo "$PACK_OUTPUT" | grep -q "$PATTERN"; then
    echo "FOUND (should be excluded)  $PATTERN"
    FAILED=1
  else
    echo "OK  $PATTERN is excluded"
  fi
done

# ---- 6. Report -------------------------------------------------------
echo ""
if [ "${FAILED:-0}" -eq 1 ]; then
  echo "FAIL — one or more checks failed. Fix before publishing."
  exit 1
else
  echo "PASS — package looks good. Safe to publish."
fi
