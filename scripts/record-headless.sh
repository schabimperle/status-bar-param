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
# to also copy them into images/, overwriting the README assets.
#
# Requires: code-server, playwright, ffmpeg, gifsicle, and a CDP browser reachable
# at $CDP_URL (falling back to $CDP_ENDPOINT, then to a local browser).
#
# The CDP browser need not run on this host, so it may not be able to reach a
# loopback code-server. BASE_URL must therefore be an address of this host that is
# routable from the browser — this host's LAN IP, auto-detected below. code-server
# consequently listens on the LAN with --auth none for the life of the recording:
# fine on a trusted network, and the throwaway profile holds nothing.
#
# It must also be a PLAIN Chrome. Automation browsers that inject fingerprint-
# spoofing scripts browser-wide patch `window.Worker` and thereby kill VS Code's
# web extension host. The symptom is oddly specific: everything records fine except
# anything touching tasks — the Run Task picker never opens and task enumeration
# hangs forever.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

# --- config (override via env) ----------------------------------------------
PORT="${PORT:-8741}"
CDP_URL="${CDP_URL:-${CDP_ENDPOINT:-http://127.0.0.1:9222}}"
# Only needed to build a default BASE_URL: this host's LAN IP, i.e. how a browser
# elsewhere on the network must address code-server. An explicit BASE_URL wins.
if [ -z "${BASE_URL:-}" ]; then
    HOST_ADDR="${HOST_ADDR:-$(ip route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}')}"
    if [ -z "$HOST_ADDR" ]; then
        echo "!! could not determine this host's LAN IP; set HOST_ADDR or BASE_URL" >&2
        exit 1
    fi
    BASE_URL="http://$HOST_ADDR:$PORT"
fi
# 15 matches the screencast capture rate; make-gif.sh's mpdecimate drops the
# redundant frames, so a higher fps here only bloats the GIF without adding motion
# 860 wide ~= the GitHub README content column, so it renders crisp there at about
# half the bytes of the 1280 capture (downscaled with lanczos, still sharp). Bump to
# 1280 only if you need pixel-for-pixel on very wide displays (roughly doubles size).
GIF_WIDTH="${GIF_WIDTH:-860}"
GIF_FPS="${GIF_FPS:-15}"
GIF_LOSSY="${GIF_LOSSY:-30}"            # gifsicle --lossy; trims size with no visible text loss at this width
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
    # README assets: the short hero clip is usage_demo.gif, the guided walkthrough is
    # full_demo.gif; every other single flow stays demo_<flow>.gif (repo-only, not shipped)
    if [ "$flow" = "full" ]; then name="full_demo"
    elif [ "$flow" = "usage" ]; then name="usage_demo"
    else name="demo_$flow"; fi
    LOSSY="$GIF_LOSSY" bash "$ROOT/scripts/make-gif.sh" "$mp4" "$OUT_DIR/$name.gif" "$GIF_WIDTH" "$GIF_FPS" >/dev/null
    echo "   $OUT_DIR/$name.gif ($(du -h "$OUT_DIR/$name.gif" | cut -f1))"
    if [ "$INSTALL" = "1" ]; then
        cp "$OUT_DIR/$name.gif" "$ROOT/images/$name.gif"
        echo "     -> installed to images/$name.gif"
    fi
done

echo ">> done. Review GIFs in $OUT_DIR$([ "$INSTALL" = 1 ] && echo ' (and images/)')"
