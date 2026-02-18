# FFmpeg Video Processing Service

Lightweight microservice for automated video post-processing. Designed to run alongside n8n on Railway and handle video concatenation, crossfade transitions, overlays, and audio mixing via simple HTTP API.

Built for the Nyaderm automated video pipeline (Seedance AI → FFmpeg → Google Drive).

## Stack

- Node.js 20 + Express
- FFmpeg (Alpine)
- Docker on Railway

## Endpoints

### `GET /health`

Returns FFmpeg version and service status.

### `POST /process`

Main endpoint. Downloads clips, normalizes resolution, concatenates with crossfade, adds logo/text overlays respecting Meta 9:16 safe zones, mixes audio, applies fade in/out. Returns MP4.

**Request body:**

```json
{
  "clips": [
    { "url": "https://example.com/clip1.mp4" },
    { "url": "https://example.com/clip2.mp4" }
  ],
  "crossfade": 0.4,
  "output": { "width": 1080, "height": 1920, "fps": 30 },
  "overlay": {
    "logo_url": "https://example.com/logo.png",
    "logo_position": "top_center",
    "logo_size": 120,
    "text": "Your CTA text here",
    "text_position": "safe_center",
    "font_size": 42,
    "font_color": "white",
    "text_bg": "black@0.5"
  },
  "audio_url": "https://example.com/music.mp3",
  "fade_in": 0.5,
  "fade_out": 0.5
}
```

All fields except `clips` are optional with sensible defaults.

**Logo positions:** `top_center`, `top_left`, `top_right`, `center`, `bottom_center`

**Text positions:** `safe_top`, `safe_center`, `safe_bottom`

**Response:** Binary MP4 file with `X-Video-Duration` header.

### `POST /probe`

Returns video metadata (duration, resolution, codec).

```json
{ "url": "https://example.com/video.mp4" }
```

## Meta 9:16 Safe Zones (1080×1920)

```
┌──────────────────────┐
│   TOP UNSAFE (14%)   │  0–269px — username, icons
│                      │
├──────────────────────┤
│                      │
│                      │
│     SAFE AREA        │  269–1248px
│     (51%)            │
│                      │
│                      │
├──────────────────────┤
│                      │
│  BOTTOM UNSAFE (35%) │  1248–1920px — CTA, captions,
│                      │  engagement buttons
└──────────────────────┘
  6% side margins (65px each)
```

All overlay positions automatically respect these zones.

## Deploy on Railway

1. Add this repo as a new service in your Railway project
2. Railway auto-detects the Dockerfile
3. No public networking needed — call internally from n8n:

```
http://ffmpeg-service.railway.internal:3000
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT`   | `3000`  | Server port |

## Local Development

```bash
npm install
node server.js
# or with Docker:
docker build -t ffmpeg-service .
docker run -p 3000:3000 ffmpeg-service
```
