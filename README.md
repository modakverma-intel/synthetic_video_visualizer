# Synthetic Videos Visualizer

Play many videos at once in a grid, locked to the same timestamp, and see the
frame rate each one actually achieves.

Useful for comparing camera feeds frame by frame, and for finding how many
streams a machine can sustain.

## Requirements

- Python 3
- ffmpeg

Nothing to build, no packages to install.

```bash
# Ubuntu / Debian
sudo apt install python3 ffmpeg

# Windows (PowerShell), then reopen the terminal
winget install -e --id Python.Python.3.12
winget install -e --id Gyan.FFmpeg
```

## Run

```bash
# Linux / macOS
./server.py

# Windows
py server.py
```

Open the address it prints:

```
Visualizer ready at http://127.0.0.1:8765/index.html
```

Use a Chromium browser (Chrome or Edge). Firefox lacks the API used for
frame-accurate measurement and falls back to rough numbers.

To use a different port: `./server.py 9000`.

## Add videos

Drag files onto the page, or use **Add videos** / **Add folder**.

`.mkv` files are converted automatically. Browsers cannot decode Matroska, so
the server remuxes them to MP4 — the video data is copied as-is, so it is fast
and lossless. The result is cached, so adding the same file again is instant.

Playback starts only after every stream has buffered, so they begin together.
Adding more files restarts the whole set from the beginning.

## Controls

| Control | Does |
| --- | --- |
| **Columns** | Videos per row (1-5). The rest wrap to the next row. |
| **Fit all** | Shrink tiles so every video fits on screen without scrolling. |
| **Rate** | Change speed of all videos at once (0.25x-4x). |
| **Sync lock** | Keep every stream on the same timestamp. On by default. |
| **Replicas** | Open several copies of each file, to stress-test stream density. |
| **Timeline** | Drag to seek every stream together. |
| **Export CSV** | Save the per-stream statistics table. |

Drag a tile to move it anywhere in the grid. Hover a tile and click **x** to
remove it.

| Key | Does |
| --- | --- |
| `Space` | Play / pause all |
| `←` `→` | Step one frame on every stream (`Shift` for 10) |
| `R` | Restart from the beginning |

## Reading the numbers

| Metric | Meaning |
| --- | --- |
| **Min FPS** | Frame rate of the slowest stream right now. |
| **Min FPS (session)** | Worst value seen since playback started. |
| **Avg FPS** | Mean across all streams. |
| **Skipped** | Frames that were decoded but never shown. |
| **Throughput** | Total megapixels per second being rendered. |
| **Sync drift** | How far the worst stream is from the others, in milliseconds. |

Each tile also shows its own live frame rate. The table at the bottom lists
resolution, source frame rate, render frame rate, and real-time percentage per
stream.

**Real-time below 100% means the machine cannot keep up.** Use more columns
(smaller tiles are cheaper to render) or fewer streams.

## If something is wrong

**A tile says "Source/codec not supported"**
The converter is not running. Open the page from `http://127.0.0.1:8765`, not
by double-clicking `index.html`. Check `http://127.0.0.1:8765/api/health`
returns `"ffmpeg": true`; if not, restart the server in a terminal where
`ffmpeg -version` works.

**Some tiles buffer forever**
A browser allows only ~6 connections per port. The server uses 5 ports to raise
this, but a port-forward or container may expose only the first. Publish ports
8765-8769, or convert the folder up front and load the results as local files:

```bash
./prepare.sh /path/to/videos
```

**Frame rate is below the source rate**
The machine is at its decode limit, roughly 500 megapixels/sec. 8 streams at
1080p is near that ceiling; 12 is beyond it. Use more columns, fewer streams, or
downscale the sources to 720p.

## Layout

```
index.html     page
styles.css     styling
app.js         playback, sync, metrics, grid
server.py      file server + .mkv conversion
prepare.sh     convert a folder up front
docs/          how it works
```

See [docs/architecture.md](docs/architecture.md).
