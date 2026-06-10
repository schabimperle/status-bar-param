#!/usr/bin/env bash
#
# One-command headless demo-GIF pipeline for the Status Bar Parameter extension.
#
#   scripts/record-headless.sh [--install] [flow,flow,...]
#
# Steps: build VSIX -> launch a clean code-server (only this extension) over a
# throwaway copy of demo-workspace -> drive it in the remote CDP browser with a
# visible cursor, recording each flow via screencast -> convert to optimized GIFs.
#
# Output GIFs land in $OUT_DIR (default /tmp/sbp-demo) for review. Pass --install
# to also copy them into images/ (demo_<flow>.gif), overwriting the README assets.
#
# Requires (already set up on this host): code-server, playwright, ffmpeg,
# gifsicle, and a reachable CDP browser. The browser loads code-server via the
# hermes-backend gateway, so BASE_URL uses 192.168.48.1 by default.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

# --- config (override via env) ----------------------------------------------
PORT="${PORT:-8741}"
CDP_URL="${CDP_URL:-http://192.168.48.10:9222}"
GATEWAY="${GATEWAY:-192.168.48.1}"          # host IP as seen from the CDP browser
BASE_URL="${BASE_URL:-http://$GATEWAY:$PORT}"
# 15 matches the screencast capture rate; make-gif.sh's mpdecimate drops the
# redundant frames, so a higher fps here only bloats the GIF without adding motion
GIF_WIDTH="${GIF_WIDTH:-1280}"          # native capture width -> no upscaling, crisp text
GIF_FPS="${GIF_FPS:-15}"
GIF_LOSSY="${GIF_LOSSY:-10}"            # gifsicle --lossy; trims size at higher resolution
OUT_DIR="${OUT_DIR:-/tmp/sbp-demo}"

INSTALL=0
FLOWS_ARG=""
for a in "$@"; do
    case "$a" in
        --install) INSTALL=1 ;;
        *) FLOWS_ARG="$a" ;;
    esac
done
FLOWS="${FLOWS_ARG:-full}"

# --- scratch dirs + cleanup --------------------------------------------------
CS_DATA="$(mktemp -d /tmp/cs-data.XXXX)"
CS_EXT="$(mktemp -d /tmp/cs-ext.XXXX)"
WORKROOT="$(mktemp -d /tmp/sbp-work.XXXX)"
WORK="$WORKROOT/demo-workspace"           # basename must stay 'demo-workspace'
CS_PID=""
cleanup() {
    [ -n "$CS_PID" ] && kill "$CS_PID" 2>/dev/null || true
    rm -rf "$CS_DATA" "$CS_EXT" "$WORKROOT"
}
trap cleanup EXIT

echo ">> building VSIX"
npm run package >/dev/null 2>&1
VSIX="$(ls -t "$ROOT"/*.vsix | head -1)"
echo "   $VSIX"

echo ">> installing extension into clean code-server profile"
code-server --install-extension "$VSIX" --extensions-dir "$CS_EXT" --user-data-dir "$CS_DATA" >/dev/null 2>&1

echo ">> staging throwaway workspace copy"
cp -r "$ROOT/demo-workspace" "$WORK"

echo ">> launching code-server on :$PORT"
code-server --bind-addr "0.0.0.0:$PORT" --auth none \
    --disable-telemetry --disable-update-check --disable-workspace-trust \
    --user-data-dir "$CS_DATA" --extensions-dir "$CS_EXT" "$WORK" \
    >/tmp/codeserver.log 2>&1 &
CS_PID=$!

ready=
for i in $(seq 1 30); do
    if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/healthz")" = "200" ]; then
        ready=1
        break
    fi
    sleep 1
done
if [ -z "$ready" ]; then
    echo "   !! code-server did not become healthy on :$PORT within 30s; see /tmp/codeserver.log" >&2
    exit 1
fi
echo "   code-server ready (pid $CS_PID)"

echo ">> recording flows: $FLOWS"
mkdir -p "$OUT_DIR"
CDP_URL="$CDP_URL" BASE_URL="$BASE_URL" FOLDER="$WORK" OUT_DIR="$OUT_DIR" FLOWS="$FLOWS" \
    node "$ROOT/scripts/record-demo.mjs"

echo ">> converting to GIF"
IFS=',' read -ra LIST <<< "$FLOWS"
for flow in "${LIST[@]}"; do
    mp4="$OUT_DIR/$flow.mp4"
    [ -f "$mp4" ] || { echo "   !! missing $mp4"; continue; }
    # the merged guided demo ships as full_demo.gif; single flows as demo_<flow>.gif
    if [ "$flow" = "full" ]; then name="full_demo"; else name="demo_$flow"; fi
    LOSSY="$GIF_LOSSY" bash "$ROOT/scripts/make-gif.sh" "$mp4" "$OUT_DIR/$name.gif" "$GIF_WIDTH" "$GIF_FPS" >/dev/null
    echo "   $OUT_DIR/$name.gif ($(du -h "$OUT_DIR/$name.gif" | cut -f1))"
    if [ "$INSTALL" = "1" ]; then
        cp "$OUT_DIR/$name.gif" "$ROOT/images/$name.gif"
        echo "     -> installed to images/$name.gif"
    fi
done

echo ">> done. Review GIFs in $OUT_DIR$([ "$INSTALL" = 1 ] && echo ' (and images/)')"
