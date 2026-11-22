#!/usr/bin/env bash
# Cloudflare Pages build step.
# Publishes only the static page and the advanced-mode worker, so
# schema.sql is never served from the site.
set -euo pipefail

cd "$(dirname "$0")"

rm -rf dist
mkdir -p dist
cp src/index.html src/_worker.js src/_routes.json dist/

echo "build: dist/ ready"
ls -l dist
