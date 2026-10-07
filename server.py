#!/usr/bin/env python3
"""Serve the visualizer and convert dropped files the browser cannot decode.

Browsers decode MP4/H.264 and WebM, but not a generic Matroska container, so
.mkv files dropped on the page are streamed here, remuxed (no re-encode when the
codec is already H.264), cached, and handed back as a playable URL.

Usage: ./server.py [port]
"""

import hashlib
import http.server
import json
import os
import re
import shutil
import socketserver
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / ".cache"
MAX_UPLOAD = 8 << 30  # 8 GiB
FFMPEG = shutil.which("ffmpeg")


def convert(src: Path, out: Path) -> bool:
    """Remux to MP4, falling back to an H.264 encode when the codec is unusable."""
    common = ["-y", "-v", "error", "-i", str(src), "-map", "0:v:0", "-movflags", "+faststart"]
    attempts = [
        [*common, "-c", "copy", str(out)],
        [*common, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
         "-pix_fmt", "yuv420p", str(out)],
    ]
    for args in attempts:
        if subprocess.run([FFMPEG, *args], capture_output=True).returncode == 0:
            return True
        out.unlink(missing_ok=True)
    return False


class Handler(http.server.SimpleHTTPRequestHandler):
    # Keep-alive matters when a dozen video elements stream concurrently.
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt, *args):
        if "/api/" in fmt % args:
            super().log_message(fmt, *args)

    def _json(self, payload, status=200):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/health":
            self._json({"ffmpeg": bool(FFMPEG)})
            return

        path = Path(self.translate_path(self.path))
        if path.is_dir():
            path = path / "index.html"
        if not path.is_file():
            self.send_error(404, "File not found")
            return
        self.serve_file(path)

    def do_HEAD(self):
        self.do_GET()

    def serve_file(self, path: Path):
        """Send a file, honouring Range. Without 206 support a browser cannot
        stream or seek a large video and playback stalls to a fraction of
        real time."""
        size = path.stat().st_size
        start, end = 0, size - 1
        partial = False

        match = re.fullmatch(r"bytes=(\d*)-(\d*)", (self.headers.get("Range") or "").strip())
        if match:
            first, last = match.groups()
            if first:
                start = int(first)
                end = min(int(last), size - 1) if last else size - 1
            elif last:
                start = max(0, size - int(last))
            if start > end or start >= size:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            partial = True

        length = end - start + 1
        self.send_response(206 if partial else 200)
        self.send_header("Content-Type", self.guess_type(str(path)))
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        if partial:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()

        if self.command == "HEAD":
            return
        with path.open("rb") as handle:
            handle.seek(start)
            remaining = length
            while remaining > 0:
                chunk = handle.read(min(1 << 20, remaining))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    return  # the player closed the stream, e.g. after a seek
                remaining -= len(chunk)

    def do_POST(self):
        if self.path != "/api/convert":
            self.send_error(404)
            return
        if not FFMPEG:
            self._json({"error": "ffmpeg not installed on the server"}, 503)
            return

        length = int(self.headers.get("Content-Length") or 0)
        if not 0 < length <= MAX_UPLOAD:
            self._json({"error": "missing or oversized body"}, 413)
            return

        # Only the extension of the client-supplied name is trusted; the output
        # name comes from the content hash, which also makes repeat drops free.
        suffix = Path(unquote(self.headers.get("X-Filename", ""))).suffix.lower()
        suffix = suffix if suffix.isprintable() and len(suffix) <= 8 else ".bin"

        digest = hashlib.sha256()
        with tempfile.NamedTemporaryFile(dir=CACHE, suffix=suffix, delete=False) as tmp:
            remaining = length
            while remaining > 0:
                chunk = self.rfile.read(min(1 << 20, remaining))
                if not chunk:
                    break
                digest.update(chunk)
                tmp.write(chunk)
                remaining -= len(chunk)
            src = Path(tmp.name)

        out = CACHE / f"{digest.hexdigest()[:16]}.mp4"
        try:
            if out.exists() or convert(src, out):
                self._json({"url": f"/.cache/{out.name}"})
            else:
                self._json({"error": "ffmpeg could not convert this file"}, 422)
        finally:
            src.unlink(missing_ok=True)


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    CACHE.mkdir(exist_ok=True)
    if not FFMPEG:
        print("warning: ffmpeg not found, .mkv conversion will be unavailable")
    with Server(("127.0.0.1", port), Handler) as httpd:
        print(f"Visualizer ready at http://127.0.0.1:{port}/index.html  (ctrl-c to stop)")
        httpd.serve_forever()
