const express = require('express');
const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '50mb' }));

const TMP_DIR = '/tmp/ffmpeg-jobs';
const FONT_CACHE = '/app/fonts';

if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
if (!fs.existsSync(FONT_CACHE)) fs.mkdirSync(FONT_CACHE, { recursive: true });

// ==================== HELPERS ====================

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        fs.unlinkSync(dest);
        return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

function runFFmpeg(cmd) {
  return new Promise((resolve, reject) => {
    console.log(`[ffmpeg] ${cmd.substring(0, 200)}...`);
    exec(cmd, { maxBuffer: 50 * 1024 * 1024, timeout: 300000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`FFmpeg error: ${stderr || err.message}`));
      else resolve(stdout);
    });
  });
}

function getVideoDuration(filePath) {
  const result = execSync(
    `ffprobe -v error -show_entries format=duration -of csv=p=0 "${filePath}"`
  ).toString().trim();
  return parseFloat(result);
}

function cleanup(jobDir) {
  setTimeout(() => {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }, 60000);
}

/**
 * Resolve font path for drawtext filter.
 * Priority:
 *   1. overlay.font_url  — download & cache (per-client branding)
 *   2. overlay.font_name — lookup in cache by partial name match
 *   3. DejaVu Sans Bold  — default fallback (supports Czech diacritics)
 */
async function resolveFont(overlay) {
  const DEFAULT_FONT = '/usr/share/fonts/ttf-dejavu/DejaVuSans-Bold.ttf';

  // 1. Font URL — download once, then serve from cache
  if (overlay.font_url) {
    try {
      const fontName = path.basename(new URL(overlay.font_url).pathname);
      const fontPath = path.join(FONT_CACHE, fontName);
      if (!fs.existsSync(fontPath)) {
        console.log(`[fonts] Downloading: ${fontName} from ${overlay.font_url}`);
        await downloadFile(overlay.font_url, fontPath);
        console.log(`[fonts] Cached: ${fontPath}`);
      } else {
        console.log(`[fonts] Using cached: ${fontPath}`);
      }
      return fontPath;
    } catch (err) {
      console.warn(`[fonts] Failed to download font: ${err.message}, using default`);
      return DEFAULT_FONT;
    }
  }

  // 2. Font name — match against cached files
  if (overlay.font_name) {
    try {
      const cached = fs.readdirSync(FONT_CACHE)
        .find(f => f.toLowerCase().includes(overlay.font_name.toLowerCase()));
      if (cached) {
        const fontPath = path.join(FONT_CACHE, cached);
        console.log(`[fonts] Matched by name "${overlay.font_name}": ${fontPath}`);
        return fontPath;
      }
      console.warn(`[fonts] Font "${overlay.font_name}" not found in cache, using default`);
    } catch (err) {
      console.warn(`[fonts] Cache lookup failed: ${err.message}`);
    }
  }

  // 3. Default
  return DEFAULT_FONT;
}

// ==================== ROUTES ====================

// Health check
app.get('/health', (req, res) => {
  try {
    const version = execSync('ffmpeg -version').toString().split('\n')[0];
    const cachedFonts = fs.readdirSync(FONT_CACHE);
    res.json({
      status: 'ok',
      ffmpeg: version,
      cached_fonts: cachedFonts
    });
  } catch (e) {
    res.status(500).json({ status: 'error', message: 'FFmpeg not found' });
  }
});

// List cached fonts
app.get('/fonts', (req, res) => {
  try {
    const fonts = fs.readdirSync(FONT_CACHE).map(f => ({
      name: f,
      path: path.join(FONT_CACHE, f),
      size_kb: Math.round(fs.statSync(path.join(FONT_CACHE, f)).size / 1024)
    }));
    res.json({ fonts, default: '/usr/share/fonts/ttf-dejavu/DejaVuSans-Bold.ttf' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== MAIN: /process ====================
//
// Request z n8n:
// POST /process
// {
//   "clips": [
//     { "url": "https://cdn.seedance.ai/clip1.mp4" },
//     { "url": "https://cdn.seedance.ai/clip2.mp4" }
//   ],
//   "crossfade": 0.4,
//   "output": { "width": 1080, "height": 1920, "fps": 30 },
//   "overlay": {
//     "logo_url": "https://example.com/logo.png",
//     "logo_position": "top_center",
//     "logo_size": 120,
//     "text": "CTA text here",
//     "text_position": "safe_center",
//     "font_size": 42,
//     "font_color": "white",
//     "text_bg": "black@0.5",
//     "font_url": "https://storage.example.com/fonts/Montserrat-Bold.ttf",
//     "font_name": "Montserrat"
//   },
//   "audio_url": "https://example.com/music.mp3",
//   "audio_data": "base64...",
//   "fade_in": 0.5,
//   "fade_out": 0.5
// }

app.post('/process', async (req, res) => {
  const jobId = crypto.randomBytes(8).toString('hex');
  const jobDir = path.join(TMP_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  try {
    const {
      clips = [],
      crossfade = 0.4,
      output = { width: 1080, height: 1920, fps: 30 },
      overlay = {},
      audio_url = null,
      audio_data = null,
      fade_in = 0.5,
      fade_out = 0.5
    } = req.body;

    if (!clips.length) {
      return res.status(400).json({ error: 'No clips provided' });
    }

    const W = output.width || 1080;
    const H = output.height || 1920;
    const FPS = output.fps || 30;

    // ---- STEP 1: Download all clips ----
    console.log(`[${jobId}] Downloading ${clips.length} clips...`);
    const clipPaths = [];
    for (let i = 0; i < clips.length; i++) {
      const clipPath = path.join(jobDir, `clip_${i}.mp4`);
      await downloadFile(clips[i].url, clipPath);
      clipPaths.push(clipPath);
      console.log(`[${jobId}] Downloaded clip ${i + 1}/${clips.length}`);
    }

    // ---- STEP 2: Normalize all clips (same resolution, fps) ----
    console.log(`[${jobId}] Normalizing clips to ${W}x${H} @ ${FPS}fps...`);
    const normalizedPaths = [];
    for (let i = 0; i < clipPaths.length; i++) {
      const normPath = path.join(jobDir, `norm_${i}.mp4`);
      await runFFmpeg(
        `ffmpeg -y -i "${clipPaths[i]}" ` +
        `-vf "scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
        `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,` +
        `fps=${FPS},setsar=1" ` +
        `-c:v libx264 -preset fast -crf 23 -an "${normPath}"`
      );
      normalizedPaths.push(normPath);
    }

    // ---- STEP 3: Concatenate with crossfade ----
    console.log(`[${jobId}] Concatenating ${normalizedPaths.length} clips with ${crossfade}s crossfade...`);
    let concatPath;

    if (normalizedPaths.length === 1) {
      concatPath = normalizedPaths[0];
    } else {
      concatPath = path.join(jobDir, 'concat.mp4');
      const inputs = normalizedPaths.map((p) => `-i "${p}"`).join(' ');

      // Get durations
      const durations = normalizedPaths.map(p => getVideoDuration(p));
      console.log(`[${jobId}] Clip durations:`, durations);

      // Build xfade filter chain
      let filterParts = [];
      let prevLabel = '0:v';
      let currentOffset = 0;

      for (let i = 1; i < normalizedPaths.length; i++) {
        currentOffset += durations[i - 1] - crossfade;
        const isLast = i === normalizedPaths.length - 1;
        const outLabel = isLast ? 'vout' : `v${i}`;
        filterParts.push(
          `[${prevLabel}][${i}:v]xfade=transition=fade:duration=${crossfade}:offset=${currentOffset.toFixed(3)}[${outLabel}]`
        );
        prevLabel = outLabel;
      }

      await runFFmpeg(
        `ffmpeg -y ${inputs} ` +
        `-filter_complex "${filterParts.join(';')}" ` +
        `-map "[vout]" -c:v libx264 -preset fast -crf 23 "${concatPath}"`
      );
    }

    // ---- STEP 4: Overlays (logo + text) with Meta safe zones ----
    //
    // 9:16 Meta Safe Zones (1080x1920):
    //   Top unsafe:    0 - 269px  (14%) — username, icons
    //   SAFE AREA:   269 - 1248px (51%)
    //   Bottom unsafe: 1248 - 1920px (35%) — CTA, description
    //
    const SAFE_TOP = Math.round(H * 0.14);
    const SAFE_BOTTOM = Math.round(H * 0.65);
    const SAFE_CENTER_Y = Math.round((SAFE_TOP + SAFE_BOTTOM) / 2);

    let currentPath = concatPath;

    if (overlay.logo_url || overlay.text) {
      console.log(`[${jobId}] Adding overlays...`);
      const overlayPath = path.join(jobDir, 'overlay.mp4');
      let filters = [];
      let extraInputs = '';
      let lastLabel = '0:v';

      // -- Logo --
      if (overlay.logo_url) {
        const logoPath = path.join(jobDir, 'logo.png');
        await downloadFile(overlay.logo_url, logoPath);

        const logoSize = overlay.logo_size || 120;
        extraInputs += ` -i "${logoPath}"`;

        let logoX, logoY;
        switch (overlay.logo_position || 'top_center') {
          case 'top_center':    logoX = '(W-w)/2'; logoY = `${SAFE_TOP + 20}`; break;
          case 'top_left':      logoX = '40';       logoY = `${SAFE_TOP + 20}`; break;
          case 'top_right':     logoX = 'W-w-40';   logoY = `${SAFE_TOP + 20}`; break;
          case 'center':        logoX = '(W-w)/2';  logoY = `${SAFE_CENTER_Y}-(h/2)`; break;
          case 'bottom_center': logoX = '(W-w)/2';  logoY = `${SAFE_BOTTOM - 20}-h`; break;
          default:              logoX = '(W-w)/2';  logoY = `${SAFE_TOP + 20}`;
        }

        filters.push(`[1:v]scale=${logoSize}:-1[logo]`);
        filters.push(`[${lastLabel}][logo]overlay=${logoX}:${logoY}[withlogo]`);
        lastLabel = 'withlogo';
      }

      // -- Text --
      if (overlay.text) {
        const fontPath = await resolveFont(overlay);
        const fontSize = overlay.font_size || 42;
        const fontColor = overlay.font_color || 'white';
        const textBg = overlay.text_bg || 'black@0.5';

        let textY;
        switch (overlay.text_position || 'safe_center') {
          case 'safe_top':    textY = `${SAFE_TOP + 40}`; break;
          case 'safe_center': textY = `${SAFE_CENTER_Y}-(th/2)`; break;
          case 'safe_bottom': textY = `${SAFE_BOTTOM - 40}-th`; break;
          default:            textY = `${SAFE_CENTER_Y}-(th/2)`;
        }

        // Escape special characters for FFmpeg drawtext
        const escapedText = overlay.text
          .replace(/\\/g, '\\\\\\\\')
          .replace(/'/g, "'\\\\\\''")
          .replace(/:/g, '\\\\:')
          .replace(/%/g, '%%');

        filters.push(
          `[${lastLabel}]drawtext=text='${escapedText}':` +
          `fontfile=${fontPath}:` +
          `fontsize=${fontSize}:fontcolor=${fontColor}:` +
          `x=(w-tw)/2:y=${textY}:` +
          `box=1:boxcolor=${textBg}:boxborderw=15[withtext]`
        );
        lastLabel = 'withtext';
      }

      await runFFmpeg(
        `ffmpeg -y -i "${currentPath}"${extraInputs} ` +
        `-filter_complex "${filters.join(';')}" ` +
        `-map "[${lastLabel}]" -c:v libx264 -preset fast -crf 23 "${overlayPath}"`
      );
      currentPath = overlayPath;
    }

    // ---- STEP 5: Audio track (supports URL or base64) ----
    const hasAudio = audio_url || audio_data;
    if (hasAudio) {
      console.log(`[${jobId}] Adding audio (${audio_data ? 'base64' : 'url'})...`);
      const audioPath = path.join(jobDir, 'audio.mp3');

      if (audio_data) {
        const buffer = Buffer.from(audio_data, 'base64');
        fs.writeFileSync(audioPath, buffer);
        console.log(`[${jobId}] Decoded base64 audio: ${(buffer.length / 1024).toFixed(0)}KB`);
      } else {
        await downloadFile(audio_url, audioPath);
      }

      const videoDur = getVideoDuration(currentPath);
      const withAudioPath = path.join(jobDir, 'with_audio.mp4');
      const fadeOutStart = (videoDur - fade_out).toFixed(2);

      await runFFmpeg(
        `ffmpeg -y -i "${currentPath}" -stream_loop -1 -i "${audioPath}" ` +
        `-filter_complex ` +
        `"[1:a]atrim=0:${videoDur.toFixed(2)},` +
        `afade=t=in:st=0:d=${fade_in},` +
        `afade=t=out:st=${fadeOutStart}:d=${fade_out}[aout]" ` +
        `-map 0:v -map "[aout]" -c:v copy -c:a aac -shortest "${withAudioPath}"`
      );
      currentPath = withAudioPath;
    }

    // ---- STEP 6: Final fade in/out on video ----
    console.log(`[${jobId}] Adding video fades...`);
    const finalPath = path.join(jobDir, `output_${jobId}.mp4`);
    const totalDuration = getVideoDuration(currentPath);
    const vfadeOutStart = (totalDuration - fade_out).toFixed(2);

    await runFFmpeg(
      `ffmpeg -y -i "${currentPath}" ` +
      `-vf "fade=t=in:st=0:d=${fade_in},fade=t=out:st=${vfadeOutStart}:d=${fade_out}" ` +
      `-c:v libx264 -preset fast -crf 23 ` +
      `${hasAudio ? '-c:a copy' : '-an'} "${finalPath}"`
    );

    // ---- STEP 7: Send result ----
    const finalDuration = getVideoDuration(finalPath);
    const stat = fs.statSync(finalPath);
    console.log(`[${jobId}] Done! Duration: ${finalDuration.toFixed(1)}s, Size: ${(stat.size / 1024 / 1024).toFixed(1)}MB`);

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition', `attachment; filename="output_${jobId}.mp4"`);
    res.setHeader('X-Video-Duration', finalDuration.toFixed(2));

    const stream = fs.createReadStream(finalPath);
    stream.pipe(res);
    stream.on('end', () => cleanup(jobDir));

  } catch (err) {
    console.error(`[${jobId}] Error:`, err.message);
    cleanup(jobDir);
    res.status(500).json({ error: err.message });
  }
});

// ==================== PROBE ====================

app.post('/probe', async (req, res) => {
  const jobId = crypto.randomBytes(8).toString('hex');
  const jobDir = path.join(TMP_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  try {
    const { url } = req.body;
    const filePath = path.join(jobDir, 'input.mp4');
    await downloadFile(url, filePath);

    const info = execSync(
      `ffprobe -v error -show_entries format=duration,size:stream=width,height,codec_name,r_frame_rate -of json "${filePath}"`
    ).toString();

    cleanup(jobDir);
    res.json(JSON.parse(info));
  } catch (err) {
    cleanup(jobDir);
    res.status(500).json({ error: err.message });
  }
});

// ==================== START ====================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FFmpeg service running on port ${PORT}`);
  console.log(`Endpoints: GET /health, GET /fonts, POST /process, POST /probe`);
});
