#!/usr/bin/env bash
# Copy the LIVE PeptideOS web build (login version) into the Capacitor bundle
# and inject the native shim. The live app is a single self-contained
# index.html (all CSS/JS inline) that makes relative /api/* fetch calls with a
# Bearer token; the shim repoints those at https://peptideos.cwenterprises.net.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
WWW="$HERE/www"
rm -rf "$WWW"; mkdir -p "$WWW"

# Live login web assets (served by the peptideos worker from repo root).
cp "$REPO/index.html" "$WWW/index.html"
[ -f "$REPO/manifest.json" ] && cp "$REPO/manifest.json" "$WWW/manifest.json" || true
[ -f "$REPO/service-worker.js" ] && cp "$REPO/service-worker.js" "$WWW/service-worker.js" || true
cp "$HERE/src/peptide-native.js" "$WWW/peptide-native.js"

# Inject the shim as the FIRST script in <head> so its fetch/WS patch is live
# before any app code runs (so the very first /api call is already repointed).
python3 - "$WWW/index.html" <<'PY'
import sys, re
p = sys.argv[1]; s = open(p).read()
tag = '<script src="/peptide-native.js"></script>\n'
if '/peptide-native.js' not in s:
    s = re.sub(r'(<head[^>]*>)', r'\1\n' + tag, s, count=1)
open(p, 'w').write(s)
print('injected peptide-native.js into', p)
PY
echo "sync-web done -> $WWW"
