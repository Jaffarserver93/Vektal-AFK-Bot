#!/usr/bin/env bash
# ─── LinkPays Runner — Ubuntu start script ────────────────────────────────────
# Usage:
#   1. Copy .env.example → .env and fill in your values
#   2. chmod +x start.sh && ./start.sh
#
# One-time Ubuntu setup (run once as root/sudo):
#   sudo apt-get update && sudo apt-get install -y \
#     chromium-browser xvfb fonts-liberation xauth \
#     libasound2 libatk-bridge2.0-0 libatk1.0-0 libcairo2 libcups2 \
#     libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 \
#     libpango-1.0-0 libpangocairo-1.0-0 libx11-6 libx11-xcb1 libxcb1 \
#     libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 \
#     libxkbcommon0 libxrandr2 libxrender1 libxss1 libxtst6 ca-certificates
#   npm install -g corepack && corepack enable && corepack prepare pnpm@10.26.1 --activate
#   pnpm install

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Load .env ─────────────────────────────────────────────────────────────────
if [ -f .env ]; then
  echo "[start.sh] Loading .env…"
  set -o allexport
  # shellcheck disable=SC1091
  source .env
  set +o allexport
else
  echo "[start.sh] ERROR: .env not found. Copy .env.example → .env and fill in your credentials."
  exit 1
fi

# ── Validate required variables ───────────────────────────────────────────────
missing=()
[ -z "${VEKTAL_EMAIL:-}"    ] && missing+=("VEKTAL_EMAIL")
[ -z "${VEKTAL_PASSWORD:-}" ] && missing+=("VEKTAL_PASSWORD")
if [ ${#missing[@]} -gt 0 ]; then
  echo "[start.sh] ERROR: missing required env vars: ${missing[*]}"
  echo "           Set them in .env and try again."
  exit 1
fi

# ── Detect Chromium path ──────────────────────────────────────────────────────
if [ -z "${CHROMIUM_PATH:-}" ]; then
  for candidate in \
    /usr/bin/chromium \
    /usr/bin/chromium-browser \
    /usr/bin/google-chrome \
    /usr/bin/google-chrome-stable; do
    if [ -x "$candidate" ]; then
      export CHROMIUM_PATH="$candidate"
      break
    fi
  done
fi
if [ -z "${CHROMIUM_PATH:-}" ]; then
  echo "[start.sh] ERROR: Chromium not found. Install it:"
  echo "           sudo apt-get install -y chromium-browser"
  exit 1
fi
echo "[start.sh] Chromium: $CHROMIUM_PATH"

# ── Detect snap Chromium (cannot use --no-sandbox with snap) ──────────────────
IS_SNAP_CHROMIUM=false
if [ -e /snap/bin/chromium ] || readlink -f "$CHROMIUM_PATH" 2>/dev/null | grep -q snap; then
  IS_SNAP_CHROMIUM=true
fi
export IS_SNAP_CHROMIUM
echo "[start.sh] Snap Chromium: $IS_SNAP_CHROMIUM"

# ── Detect Xvfb ───────────────────────────────────────────────────────────────
XVFB_RUN_CMD=""
if command -v xvfb-run &>/dev/null; then
  XVFB_RUN_CMD="xvfb-run"
fi

if [ -z "${XVFB_PATH:-}" ]; then
  for candidate in /usr/bin/Xvfb /usr/local/bin/Xvfb; do
    if [ -x "$candidate" ]; then
      export XVFB_PATH="$candidate"
      break
    fi
  done
fi
if [ -z "${XVFB_PATH:-}" ] && [ -z "$XVFB_RUN_CMD" ]; then
  echo "[start.sh] ERROR: Xvfb not found. Install it:"
  echo "           sudo apt-get install -y xvfb"
  exit 1
fi
echo "[start.sh] Xvfb:     ${XVFB_PATH:-via xvfb-run}"

# ── Port ─────────────────────────────────────────────────────────────────────
export PORT="${PORT:-10000}"
echo "[start.sh] Health-check port: $PORT"

# ── Skip Puppeteer bundled-Chromium download ──────────────────────────────────
export PUPPETEER_SKIP_DOWNLOAD=true
export PUPPETEER_EXECUTABLE_PATH="$CHROMIUM_PATH"
export NODE_ENV="${NODE_ENV:-production}"

# ── Kill any stale Xvfb on display :94 ────────────────────────────────────────
pkill -f "Xvfb :94" 2>/dev/null || true
sleep 0.5

# ── Run via xvfb-run (most reliable on Ubuntu) ────────────────────────────────
echo "[start.sh] Starting runner…"

if [ -n "$XVFB_RUN_CMD" ]; then
  # xvfb-run sets DISPLAY automatically and manages Xvfb lifecycle
  exec xvfb-run \
    --server-num=94 \
    --server-args="-screen 0 1280x900x24 -ac +extension GLX +render -noreset" \
    pnpm --filter @workspace/scripts run linkpays-runner
else
  # Fallback: let the runner manage Xvfb itself
  exec pnpm --filter @workspace/scripts run linkpays-runner
fi
