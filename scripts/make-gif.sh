#!/usr/bin/env bash
#
# Convert a recorded screen video into an optimized README GIF.
#
# Usage:
#   scripts/make-gif.sh INPUT.mp4 OUTPUT.gif [WIDTH] [FPS]
#
# Defaults: WIDTH=900  FPS=15
#
# Tuned for flat editor UI (the worst case for the naive fps+dither recipe):
#   * mpdecimate drops near-duplicate frames and emits variable per-frame delays,
#     so long static moments cost one frame, not dozens (cut the old 950-frame
#     capture to ~475 without dropping any visible motion).
#   * a stable 128-colour palette (stats_mode=full) with NO dithering — dithering
#     adds per-pixel noise that both looks like artifacts on text and defeats GIF
#     inter-frame compression; flat UI needs neither.
#   * gifsicle -O3 for inter-frame optimization, plus an optional lossy pass.
#
# Env knobs: COLORS (default 128), LOSSY (gifsicle --lossy, default 0 = lossless;
# set e.g. LOSSY=30 to trade some edge sharpness for a smaller file).
#
# Encoder: the tuned ffmpeg pipeline by default, because it preserves the recorder's
# VARIABLE per-frame delays (a long pause stays a long frame) — the demo's pacing
# depends on that. gifski compresses ~2x better but replays the decimated frames at a
# UNIFORM fps, which flattens every pause (a 70s demo collapses to ~30s of constant
# motion). So gifski is opt-in only, via USE_GIFSKI=1, and intended for clips without
# deliberate holds. Don't enable it for the guided full demo.
#
# Install helpers:
#   sudo apt install ffmpeg gifsicle
#   npm i -g gifski   # or: cargo install gifski / brew install gifski (only for USE_GIFSKI=1)
set -euo pipefail

IN="${1:?usage: make-gif.sh INPUT.mp4 OUTPUT.gif [WIDTH] [FPS]}"
OUT="${2:?usage: make-gif.sh INPUT.mp4 OUTPUT.gif [WIDTH] [FPS]}"
WIDTH="${3:-900}"
FPS="${4:-15}"
COLORS="${COLORS:-128}"
LOSSY="${LOSSY:-0}"

# drop frames that barely differ from the previous one (tuned for slow UI motion)
DECIMATE="mpdecimate=hi=64*8:lo=64*4:frac=0.1"

[ -f "$IN" ] || { echo "input not found: $IN" >&2; exit 1; }
command -v ffmpeg >/dev/null || { echo "ffmpeg is required" >&2; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

if [ "${USE_GIFSKI:-0}" = 1 ] && command -v gifski >/dev/null; then
    echo ">> WARNING: USE_GIFSKI=1 — replays at a uniform ${FPS}fps, FLATTENING the recorded pauses." >&2
    echo ">> extracting frames (fps=$FPS, width=$WIDTH) ..."
    ffmpeg -hide_banner -loglevel error -i "$IN" \
        -vf "fps=$FPS,$DECIMATE,scale=$WIDTH:-1:flags=lanczos" -fps_mode vfr "$tmp/frame_%05d.png"
    echo ">> encoding GIF with gifski ..."
    gifski -o "$OUT" --fps "$FPS" --quality 90 "$tmp"/frame_*.png
else
    echo ">> ffmpeg pipeline (decimate + ${COLORS}-colour palette, no dither) ..."
    # per-clip palette over the decimated stream; no dithering for crisp flat UI
    ffmpeg -y -hide_banner -loglevel error -i "$IN" \
        -vf "fps=$FPS,$DECIMATE,scale=$WIDTH:-1:flags=lanczos,palettegen=max_colors=$COLORS:stats_mode=full" "$tmp/palette.png"
    ffmpeg -y -hide_banner -loglevel error -i "$IN" -i "$tmp/palette.png" \
        -lavfi "fps=$FPS,$DECIMATE,scale=$WIDTH:-1:flags=lanczos [x]; [x][1:v] paletteuse=dither=none:diff_mode=rectangle" \
        -fps_mode vfr "$OUT"
fi

if command -v gifsicle >/dev/null; then
    if [ "$LOSSY" -gt 0 ]; then
        echo ">> optimizing with gifsicle (-O3, lossy=$LOSSY) ..."
        gifsicle -O3 --lossy="$LOSSY" "$OUT" -o "$OUT"
    else
        echo ">> optimizing with gifsicle (-O3) ..."
        gifsicle -O3 "$OUT" -o "$OUT"
    fi
fi

echo ">> done: $OUT ($(du -h "$OUT" | cut -f1))"
