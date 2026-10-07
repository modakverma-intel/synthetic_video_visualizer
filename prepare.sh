#!/usr/bin/env bash
# Convert videos into a form browsers can actually decode (H.264 in MP4).
# .mkv is remuxed without re-encoding when it already holds H.264.
#
# Usage: ./prepare.sh [source_dir] [output_dir]

set -euo pipefail

src_dir=${1:-.}
out_dir=${2:-./browser-ready}

command -v ffmpeg >/dev/null || { echo "ffmpeg is required"; exit 1; }
command -v ffprobe >/dev/null || { echo "ffprobe is required"; exit 1; }

mkdir -p "$out_dir"
shopt -s nullglob nocaseglob

converted=0
for src in "$src_dir"/*.{mkv,avi,mov,ts,m4v,webm,mp4}; do
    name=$(basename "${src%.*}")
    out="$out_dir/$name.mp4"
    [[ "$(readlink -f "$src")" == "$(readlink -f "$out")" ]] && continue

    codec=$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 "$src")

    if [[ "$codec" == "h264" ]]; then
        echo "remux   $(basename "$src")  (h264, no re-encode)"
        ffmpeg -y -loglevel error -i "$src" -map 0:v:0 -c copy -movflags +faststart "$out"
    else
        echo "encode  $(basename "$src")  ($codec -> h264)"
        ffmpeg -y -loglevel error -i "$src" -map 0:v:0 \
            -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p \
            -movflags +faststart "$out"
    fi
    converted=$((converted + 1))
done

echo
echo "$converted file(s) written to $out_dir"
echo "Load that folder in the visualizer with \"Add folder\"."
