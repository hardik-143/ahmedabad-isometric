#!/usr/bin/env bash
# Builds the Ahmedabad isometric city: downloads open data, processes it, writes dist/.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PY="$(command -v python3.12 || command -v python3)"
echo "Using $($PY --version)"
export AMD_DATA="$ROOT/.cache/data" AMD_OUT="$ROOT/.cache/build" AMD_SITE="$ROOT/public" AMD_FORMAT=bin
export PYTHONPATH="$ROOT/.pydeps" PYTHONUNBUFFERED=1
mkdir -p "$AMD_DATA" "$AMD_OUT" "$AMD_SITE/data"
echo "== installing python deps"
$PY -m pip install --quiet --disable-pip-version-check --target "$ROOT/.pydeps" \
  "numpy>=1.26" "pyarrow>=15" "shapely>=2.1" "mapbox_earcut>=1.0" "py7zr>=0.20"
echo "== downloading open data"
$PY tools/fetch.py
cd tools
echo "== ground";     $PY p_ground.py
echo "== buildings";  $PY p_buildings.py
echo "== trees";      $PY p_trees.py
echo "== pack";       $PY pack.py
cd "$ROOT"
echo "data written to $AMD_SITE/data"
du -sh "$AMD_SITE" && ls -la "$AMD_SITE/data"
