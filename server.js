import express from 'express';
import cors from 'cors';
import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { jsonToPDF } from '@polotno/pdf-export';
import { exec } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { PDFDocument, PDFName, PDFArray, PDFNumber, rgb } from 'pdf-lib';

const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.API_SECRET || 'V9rQm7L2xAPz8K4nW6bY3cJ5';
// -----------------------------------------------------------------------------
// Simple capacity management + status dashboard
// -----------------------------------------------------------------------------
// Docker/Coolify won't automatically protect you from overload. These settings
// provide backpressure (queue + concurrency limits) and basic runtime telemetry.
//
// Tune via env vars:
//  - MAX_CONCURRENT_JOBS (default: 1)      number of concurrent heavy jobs
//  - MAX_JOB_QUEUE       (default: 20)     max queued requests before 503
//  - JOB_TIMEOUT_MS      (default: 180000) soft timeout for job wrapper
//  - MAX_RSS_MB          (default: 0)      if >0, exit when RSS exceeds threshold (lets platform restart)
//  - ADMIN_SECRET        (default: API_SECRET) key for /admin and /admin/status
// -----------------------------------------------------------------------------
const MAX_CONCURRENT_JOBS = Number.parseInt(process.env.MAX_CONCURRENT_JOBS || '1', 10);
const MAX_JOB_QUEUE = Number.parseInt(process.env.MAX_JOB_QUEUE || '20', 10);
const JOB_TIMEOUT_MS = Number.parseInt(process.env.JOB_TIMEOUT_MS || '180000', 10);
const MAX_RSS_MB = Number.parseInt(process.env.MAX_RSS_MB || '0', 10);
const ADMIN_SECRET = process.env.ADMIN_SECRET || API_SECRET;

class OverloadedError extends Error {
  constructor(message = 'Server is busy') {
    super(message);
    this.name = 'OverloadedError';
    this.statusCode = 503;
  }
}

const jobState = {
  active: 0,
  queued: 0,
  queue: [],
  recent: [], // { id, name, ms, ok, at, error? }
};

function nowIso() {
  return new Date().toISOString();
}

function recordRecent(entry) {
  jobState.recent.unshift(entry);
  if (jobState.recent.length > 50) jobState.recent.length = 50;
}

function withTimeout(promise, ms) {
  if (!ms || ms <= 0) return promise;
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`Job timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise.finally(() => clearTimeout(t)), timeout]);
}

async function runWithCapacity(name, fn) {
  const startedAt = Date.now();
  const id = uuidv4();

  // Backpressure: queue if we're at capacity, reject if queue too long.
  if (jobState.active >= MAX_CONCURRENT_JOBS) {
    if (jobState.queue.length >= MAX_JOB_QUEUE) {
      recordRecent({ id, name, ms: 0, ok: false, at: nowIso(), error: 'Overloaded (queue full)' });
      throw new OverloadedError('All workers are busy. Please retry shortly.');
    }
    jobState.queued++;
    await new Promise((resolve) => jobState.queue.push(resolve));
    jobState.queued--;
  }

  jobState.active++;
  try {
    await withTimeout(Promise.resolve().then(fn), JOB_TIMEOUT_MS);
    recordRecent({ id, name, ms: Date.now() - startedAt, ok: true, at: nowIso() });
  } catch (e) {
    recordRecent({ id, name, ms: Date.now() - startedAt, ok: false, at: nowIso(), error: e?.message || String(e) });
    throw e;
  } finally {
    jobState.active--;
    const next = jobState.queue.shift();
    if (next) next();
  }
}

const withCapacity = (name, handler) => async (req, res) => {
  try {
    await runWithCapacity(name, () => handler(req, res));
  } catch (e) {
    if (e?.name === 'OverloadedError') {
      return res.status(503).json({
        error: 'overloaded',
        message: e.message,
        active: jobState.active,
        queued: jobState.queue.length,
      });
    }
    // Let the route's own error handling run if it already wrote a response.
    // Otherwise respond here.
    if (!res.headersSent) {
      return res.status(500).json({ error: 'internal_error', message: e?.message || String(e) });
    }
  }
};

// Admin auth: use header x-admin-key or query ?key=
function authenticateAdmin(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (!key || key !== ADMIN_SECRET) {
    return res.status(401).send('Unauthorized');
  }
  next();
}

// Basic watchdog: if RSS exceeds threshold, exit so platform restarts container.
if (MAX_RSS_MB > 0) {
  setInterval(() => {
    const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
    if (rssMb > MAX_RSS_MB) {
      console.error(`[watchdog] RSS ${rssMb}MB exceeded MAX_RSS_MB=${MAX_RSS_MB}. Exiting for restart.`);
      process.exit(1);
    }
  }, 5000).unref();
}


// Increase payload limit for large scenes
app.use(express.json({ limit: '100mb' }));
app.use(cors());

// Temp directory for PDF processing
const TEMP_DIR = '/tmp/pdf-export';

// Ensure temp directory exists
async function ensureTempDir() {
  try {
    await fs.mkdir(TEMP_DIR, { recursive: true });
  } catch (e) {
    console.error('Failed to create temp directory:', e);
  }
}
ensureTempDir();

// API key authentication middleware
function authenticate(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// =============================================================================
// GHOSTSCRIPT VECTOR-SAFE CMYK CONVERSION
//
// Converts RGB PDF to CMYK using specific flags that preserve vectors.
// CRITICAL: Do NOT use -dPDFSETTINGS=/prepress — it causes transparency
// flattening which rasterizes all vector content.
// =============================================================================
async function convertToCmykSafe(inputPath, outputPath, iccProfile) {
  const profilePath = iccProfile === 'fogra39'
    ? path.join(__dirname, 'profiles', 'ISOcoated_v2_eci.icc')
    : path.join(__dirname, 'profiles', 'GRACoL2013_CRPC6.icc');

  // Check if ICC profile exists, fall back to default conversion without profile
  let useProfile = true;
  try {
    await fs.access(profilePath);
  } catch (_) {
    console.warn(`[cmyk] ICC profile not found at ${profilePath}, converting without profile`);
    useProfile = false;
  }

  const gsArgs = [
    'gs',
    '-dBATCH', '-dNOPAUSE', '-dQUIET',
    '-sDEVICE=pdfwrite',
    '-dColorConversionStrategy=/CMYK',
    '-dProcessColorModel=/DeviceCMYK',
    '-dPreserveHalftoneInfo=true',
    '-dPreserveOverprintSettings=true',
    // CRITICAL: No -dPDFSETTINGS=/prepress — causes transparency flattening
  ];

  if (useProfile) {
    gsArgs.push(`-sOutputICCProfile=${profilePath}`);
  }

  gsArgs.push(`-sOutputFile=${outputPath}`);
  gsArgs.push(inputPath);

  console.log(`[cmyk] Converting to CMYK with vector-safe flags (profile: ${useProfile ? iccProfile : 'none'})`);

  try {
    const { stderr } = await execAsync(gsArgs.join(' '), { timeout: 120000 });
    if (stderr) {
      console.warn(`[cmyk] Ghostscript warnings: ${stderr.slice(0, 300)}`);
    }

    // Verify output was created
    const stats = await fs.stat(outputPath);
    console.log(`[cmyk] CMYK conversion complete: ${stats.size} bytes`);
  } catch (err) {
    console.error(`[cmyk] Ghostscript conversion failed:`, err.message);
    throw new Error(`CMYK conversion failed: ${err.message}`);
  }
}

// =============================================================================
// PDF-LIB CROP MARKS + BOXES — Adobe Illustrator-style extended canvas
//
// Enlarges each page by 10mm on all sides beyond the trim to create dedicated
// space for crop marks (matching professional prepress tools like Illustrator).
//
// Geometry (e.g. A4 Landscape, 3mm bleed):
//   Trim:     297 × 210mm
//   Bleed:    303 × 216mm  (trim + 3mm each side)
//   Canvas:   317 × 230mm  (trim + 10mm each side)
//
// Crop marks: 8mm long, starting 2mm from trim edge
// Marks drawn in RGB; Ghostscript CMYK pass converts to registration black.
// =============================================================================
async function addCropMarksAndBoxes(inputPath, bleedMm, outputPath) {
  const srcBytes = await fs.readFile(inputPath);
  const srcDoc = await PDFDocument.load(srcBytes);
  const outDoc = await PDFDocument.create();

  const mmToPt = 72 / 25.4;
  const bleedPt = bleedMm * mmToPt;
  const marksExtensionPt = 10 * mmToPt;       // 10mm total from trim edge
  const extraMarginPt = marksExtensionPt - bleedPt; // extra space beyond bleed
  const markLength = 8 * mmToPt;               // 8mm crop mark lines
  const markOffset = 2 * mmToPt;               // 2mm gap from trim edge
  const markThickness = 0.5;                   // hairline

  const srcPages = srcDoc.getPages();

  for (let i = 0; i < srcPages.length; i++) {
    const srcPage = srcPages[i];
    const { width: srcW, height: srcH } = srcPage.getSize();

    // Source page = trim + bleed (what Polotno exported)
    const trimW = srcW - bleedPt * 2;
    const trimH = srcH - bleedPt * 2;

    // New enlarged canvas = trim + 10mm on each side
    const fullW = trimW + marksExtensionPt * 2;
    const fullH = trimH + marksExtensionPt * 2;

    // Create new page at enlarged size
    const newPage = outDoc.addPage([fullW, fullH]);

    // Embed original page onto the new canvas
    // The original content is offset so trim aligns at marksExtensionPt inset
    const [embedded] = await outDoc.embedPdf(srcDoc, [i]);
    newPage.drawPage(embedded, {
      x: extraMarginPt,  // offset = 10mm - bleed (positions bleed edge correctly)
      y: extraMarginPt,
      width: srcW,
      height: srcH,
    });

    // ── Trim coordinates on the new enlarged canvas ──
    const trimX = marksExtensionPt;                    // left edge of trim
    const trimY = marksExtensionPt;                    // bottom edge of trim (PDF coords)
    const trimRight = marksExtensionPt + trimW;        // right edge of trim
    const trimTop = marksExtensionPt + trimH;          // top edge of trim

    // ── Draw crop marks (8 lines: 2 per corner) ──
    const black = rgb(0, 0, 0);

    const marks = [
      // Top-left corner
      { start: { x: trimX - markOffset - markLength, y: trimTop }, end: { x: trimX - markOffset, y: trimTop } },   // horizontal
      { start: { x: trimX, y: trimTop + markOffset }, end: { x: trimX, y: trimTop + markOffset + markLength } },     // vertical
      // Top-right corner
      { start: { x: trimRight + markOffset, y: trimTop }, end: { x: trimRight + markOffset + markLength, y: trimTop } },
      { start: { x: trimRight, y: trimTop + markOffset }, end: { x: trimRight, y: trimTop + markOffset + markLength } },
      // Bottom-left corner
      { start: { x: trimX - markOffset - markLength, y: trimY }, end: { x: trimX - markOffset, y: trimY } },
      { start: { x: trimX, y: trimY - markOffset - markLength }, end: { x: trimX, y: trimY - markOffset } },
      // Bottom-right corner
      { start: { x: trimRight + markOffset, y: trimY }, end: { x: trimRight + markOffset + markLength, y: trimY } },
      { start: { x: trimRight, y: trimY - markOffset - markLength }, end: { x: trimRight, y: trimY - markOffset } },
    ];

    for (const mark of marks) {
      newPage.drawLine({ start: mark.start, end: mark.end, color: black, thickness: markThickness });
    }

    // ── Set TrimBox (the finished cut size) ──
    const trimBox = PDFArray.withContext(outDoc.context);
    trimBox.push(PDFNumber.of(trimX));
    trimBox.push(PDFNumber.of(trimY));
    trimBox.push(PDFNumber.of(trimRight));
    trimBox.push(PDFNumber.of(trimTop));
    newPage.node.set(PDFName.of('TrimBox'), trimBox);

    // ── Set BleedBox (trim + bleed area) ──
    const bleedBox = PDFArray.withContext(outDoc.context);
    bleedBox.push(PDFNumber.of(extraMarginPt));          // inset from canvas edge by (10mm - bleed)
    bleedBox.push(PDFNumber.of(extraMarginPt));
    bleedBox.push(PDFNumber.of(fullW - extraMarginPt));
    bleedBox.push(PDFNumber.of(fullH - extraMarginPt));
    newPage.node.set(PDFName.of('BleedBox'), bleedBox);

    // MediaBox is automatically [0, 0, fullW, fullH] — the entire enlarged canvas
  }

  const outBytes = await outDoc.save();
  await fs.writeFile(outputPath, outBytes);

  const trimWmm = ((srcPages[0]?.getSize().width || 0) - bleedPt * 2) / mmToPt;
  const trimHmm = ((srcPages[0]?.getSize().height || 0) - bleedPt * 2) / mmToPt;
  const fullWmm = trimWmm + 20;
  const fullHmm = trimHmm + 20;
  console.log(`[crop-marks] Extended canvas: ${trimWmm.toFixed(0)}×${trimHmm.toFixed(0)}mm trim → ${fullWmm.toFixed(0)}×${fullHmm.toFixed(0)}mm canvas (10mm margins, 8mm marks, 2mm offset)`);
}

// =============================================================================
// LABEL IMPOSITION — pdf-lib embedPage() for vector-safe tiling
//
// Takes a multi-page PDF (one label per page) and tiles them onto sheets
// at positions defined by the layout grid. embedPage() preserves original
// content streams (vectors stay vectors, images stay images).
// =============================================================================
async function imposeLabels(labelsPath, layout, outputPath, jobId) {
  const pdfBytes = await fs.readFile(labelsPath);
  const labelDoc = await PDFDocument.load(pdfBytes);
  const labelPages = labelDoc.getPages();

  if (labelPages.length === 0) {
    throw new Error('No label pages to impose');
  }

  // Layout config (all values in mm, convert to points)
  const mmToPt = 72 / 25.4;
  const sheetW = (layout.sheetWidthMm || 215.9) * mmToPt;  // Default Letter width
  const sheetH = (layout.sheetHeightMm || 279.4) * mmToPt;  // Default Letter height
  const cols = layout.columns || 3;
  const rows = layout.rows || 10;
  const marginLeft = (layout.marginLeftMm || 4.78) * mmToPt;
  const marginTop = (layout.marginTopMm || 12.7) * mmToPt;
  const labelW = (layout.labelWidthMm || 66.68) * mmToPt;
  const labelH = (layout.labelHeightMm || 25.4) * mmToPt;
  const gapX = (layout.spacingXMm || 3.18) * mmToPt;
  const gapY = (layout.spacingYMm || 0) * mmToPt;
  const labelsPerSheet = cols * rows;

  console.log(`[${jobId}] Imposing ${labelPages.length} labels onto ${cols}×${rows} sheets (${labelsPerSheet}/sheet)`);

  const outputDoc = await PDFDocument.create();
  let labelIndex = 0;

  while (labelIndex < labelPages.length) {
    // Create a new sheet page
    const sheetPage = outputDoc.addPage([sheetW, sheetH]);

    for (let row = 0; row < rows && labelIndex < labelPages.length; row++) {
      for (let col = 0; col < cols && labelIndex < labelPages.length; col++) {
        // Calculate position (PDF coordinates: origin bottom-left, Y goes up)
        const x = marginLeft + col * (labelW + gapX);
        const y = sheetH - marginTop - (row + 1) * labelH - row * gapY;

        // Embed the label page from source document
        const [embeddedPage] = await outputDoc.embedPdf(labelDoc, [labelIndex]);

        // Draw the embedded page at the calculated position, scaled to fit
        sheetPage.drawPage(embeddedPage, {
          x,
          y,
          width: labelW,
          height: labelH,
        });

        labelIndex++;
      }
    }
  }

  const sheetsCreated = Math.ceil(labelPages.length / labelsPerSheet);
  console.log(`[${jobId}] Imposition complete: ${labelPages.length} labels on ${sheetsCreated} sheets`);

  const outputBytes = await outputDoc.save();
  await fs.writeFile(outputPath, outputBytes);
  return Buffer.from(outputBytes);
}

// =============================================================================
// HEALTH CHECK
// =============================================================================
app.get('/health', async (req, res) => {
  try {
    let gsVersion = 'not installed';
    let gsAvailable = false;
    try {
      const { stdout } = await execAsync('gs --version');
      gsVersion = stdout.trim();
      gsAvailable = true;
    } catch (_) {}

    let qpdfVersion = 'not installed';
    try {
      const { stdout } = await execAsync('qpdf --version');
      qpdfVersion = stdout.trim().split('\n')[0];
    } catch (_) {}

    // Check ICC profiles
    let iccStatus = {};
    for (const [name, path_] of [
      ['GRACoL2013', path.join(__dirname, 'profiles', 'GRACoL2013_CRPC6.icc')],
      ['Fogra39', path.join(__dirname, 'profiles', 'ISOcoated_v2_eci.icc')],
    ]) {
      try {
        await fs.access(path_);
        iccStatus[name] = 'available';
      } catch (_) {
        iccStatus[name] = 'missing';
      }
    }

    res.json({
      status: 'ok',
      pipeline: 'Polotno (vector RGB) → pdf-lib (crop marks + boxes) → Ghostscript (CMYK)',
      ghostscript: gsAvailable ? `${gsVersion} (used for vector-safe CMYK conversion)` : 'NOT INSTALLED — CMYK will fail',
      qpdf: qpdfVersion,
      iccProfiles: iccStatus,
      polotno: '@polotno/pdf-export (bleed only, NO native cropMarkSize)',
      endpoints: ['/health', '/render-vector', '/batch-render-vector', '/export-multipage', '/export-labels', '/compose-pdfs', '/verify-pdf'],
    });
  } catch (e) {
    res.status(500).json({ status: 'error', error: e.message });
  }
});


// -----------------------------------------------------------------------------
// Simple monitoring page (HTML) + JSON status
// -----------------------------------------------------------------------------
app.get('/admin', authenticateAdmin, (req, res) => {
  const key = req.query.key || '';
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>PDF Export Service • Status</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; margin: 0; background: #0b1220; color: #e5e7eb; }
    header { padding: 18px 20px; border-bottom: 1px solid rgba(148,163,184,.25); background: rgba(255,255,255,.03); position: sticky; top: 0; backdrop-filter: blur(10px); }
    h1 { font-size: 16px; margin: 0; font-weight: 700; letter-spacing: .02em; }
    .sub { color: #94a3b8; font-size: 12px; margin-top: 6px; }
    main { padding: 20px; max-width: 1100px; margin: 0 auto; }
    .grid { display: grid; gap: 14px; grid-template-columns: repeat(12, 1fr); }
    .card { grid-column: span 12; background: rgba(255,255,255,.04); border: 1px solid rgba(148,163,184,.18); border-radius: 16px; padding: 14px 14px; }
    @media (min-width: 900px) { .card.span6 { grid-column: span 6; } }
    .k { color: #94a3b8; font-size: 12px; }
    .v { font-size: 18px; font-weight: 700; margin-top: 4px; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { text-align: left; padding: 8px 8px; border-bottom: 1px solid rgba(148,163,184,.14); vertical-align: top; }
    th { color: #94a3b8; font-weight: 700; }
    .ok { color: #34d399; font-weight: 700; }
    .bad { color: #fb7185; font-weight: 700; }
    .pill { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; background: rgba(14,165,233,.12); border: 1px solid rgba(14,165,233,.25); font-size: 12px; color: #7dd3fc; }
    .warn { background: rgba(251,146,60,.12); border-color: rgba(251,146,60,.25); color: #fdba74; }
    .muted { color: #94a3b8; }
    .row { display: flex; gap: 14px; flex-wrap: wrap; }
    code { color: #a7f3d0; }
  </style>
</head>
<body>
  <header>
    <h1>PDF Export Service — Status</h1>
    <div class="sub">Refreshes every 2s • Protect this URL (requires key)</div>
  </header>
  <main>
    <div class="row">
      <span id="healthPill" class="pill">● Loading…</span>
      <span class="pill">Active jobs: <b id="active">0</b></span>
      <span class="pill">Queued: <b id="queued">0</b></span>
      <span class="pill warn">RSS: <b id="rss">0</b> MB</span>
    </div>

    <div class="grid" style="margin-top:14px;">
      <div class="card span6">
        <div class="k">Uptime</div>
        <div class="v" id="uptime">—</div>
        <div class="k" style="margin-top:10px;">Node</div>
        <div class="v"><span id="node">—</span></div>
        <div class="k" style="margin-top:10px;">Load avg</div>
        <div class="v"><span id="load">—</span></div>
      </div>

      <div class="card span6">
        <div class="k">Limits</div>
        <div class="v"><span class="muted">MAX_CONCURRENT_JOBS</span> <code id="maxConc">—</code></div>
        <div class="v"><span class="muted">MAX_JOB_QUEUE</span> <code id="maxQueue">—</code></div>
        <div class="v"><span class="muted">JOB_TIMEOUT_MS</span> <code id="timeout">—</code></div>
        <div class="v"><span class="muted">MAX_RSS_MB</span> <code id="maxRss">—</code></div>
      </div>

      <div class="card" style="grid-column: span 12;">
        <div class="k">Recent jobs (newest first)</div>
        <div style="margin-top:10px; overflow:auto;">
          <table>
            <thead><tr><th>At</th><th>Route</th><th>Duration</th><th>Result</th><th>Error</th></tr></thead>
            <tbody id="recent"></tbody>
          </table>
        </div>
      </div>
    </div>
  </main>

<script>
const KEY = ${JSON.stringify(key)};
async function tick(){
  try {
    const r = await fetch('/admin/status?key=' + encodeURIComponent(KEY));
    const j = await r.json();
    document.getElementById('active').textContent = j.jobs.active;
    document.getElementById('queued').textContent = j.jobs.queued;
    document.getElementById('rss').textContent = j.process.memory.rssMb;
    document.getElementById('uptime').textContent = j.process.uptimeHuman;
    document.getElementById('node').textContent = j.process.node;
    document.getElementById('load').textContent = j.process.loadavg.join(', ');
    document.getElementById('maxConc').textContent = j.limits.maxConcurrentJobs;
    document.getElementById('maxQueue').textContent = j.limits.maxJobQueue;
    document.getElementById('timeout').textContent = j.limits.jobTimeoutMs;
    document.getElementById('maxRss').textContent = j.limits.maxRssMb;

    const pill = document.getElementById('healthPill');
    if (j.ok) { pill.textContent = '● Healthy'; pill.className = 'pill'; }
    else { pill.textContent = '● Degraded'; pill.className = 'pill warn'; }

    const rows = (j.jobs.recent || []).map(x => {
      const ok = x.ok ? '<span class="ok">OK</span>' : '<span class="bad">FAIL</span>';
      const err = x.error ? String(x.error).slice(0,160) : '';
      return '<tr>'
        + '<td>' + x.at + '</td>'
        + '<td><code>' + x.name + '</code></td>'
        + '<td>' + x.ms + 'ms</td>'
        + '<td>' + ok + '</td>'
        + '<td class="muted">' + err + '</td>'
        + '</tr>';
    }).join('');
    document.getElementById('recent').innerHTML = rows;
  } catch (e) {
    const pill = document.getElementById('healthPill');
    pill.textContent = '● Error loading status';
    pill.className = 'pill warn';
  }
}
tick();
setInterval(tick, 2000);
</script>
</body>
</html>`);
});

app.get('/admin/status', authenticateAdmin, (req, res) => {
  const mem = process.memoryUsage();
  const rssMb = Math.round(mem.rss / 1024 / 1024);
  const heapUsedMb = Math.round(mem.heapUsed / 1024 / 1024);
  const heapTotalMb = Math.round(mem.heapTotal / 1024 / 1024);

  const upSec = Math.floor(process.uptime());
  const h = Math.floor(upSec / 3600);
  const m = Math.floor((upSec % 3600) / 60);
  const s = upSec % 60;

  res.json({
    ok: true,
    at: nowIso(),
    limits: {
      maxConcurrentJobs: MAX_CONCURRENT_JOBS,
      maxJobQueue: MAX_JOB_QUEUE,
      jobTimeoutMs: JOB_TIMEOUT_MS,
      maxRssMb: MAX_RSS_MB,
    },
    jobs: {
      active: jobState.active,
      queued: jobState.queue.length,
      recent: jobState.recent,
    },
    process: {
      pid: process.pid,
      node: process.version,
      uptimeSec: upSec,
      uptimeHuman: `${h}h ${m}m ${s}s`,
      loadavg: os.loadavg().map(n => Number(n.toFixed(2))),
      memory: { rssMb, heapUsedMb, heapTotalMb },
    },
  });
});

// =============================================================================
// VERIFY PDF — Diagnostic endpoint using Ghostscript to inspect PDF properties
// =============================================================================
app.post('/verify-pdf', authenticate, withCapacity('verify-pdf', async (req, res) => {
  const jobId = uuidv4();
  const inputPath = path.join(TEMP_DIR, `${jobId}-verify.pdf`);

  try {
    // Accept either base64 PDF in JSON body or raw PDF bytes
    let pdfBuffer;
    const contentType = req.headers['content-type'] || '';

    if (contentType.includes('application/pdf')) {
      const chunks = [];
      for await (const chunk of req) { chunks.push(chunk); }
      pdfBuffer = Buffer.concat(chunks);
    } else {
      const { pdf } = req.body;
      if (!pdf) return res.status(400).json({ error: 'Provide base64 PDF in { pdf: "..." } or raw PDF bytes' });
      pdfBuffer = Buffer.from(pdf, 'base64');
    }

    await fs.writeFile(inputPath, pdfBuffer);

    // 1. Use pdf-lib to read page boxes and basic structure
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const pages = pdfDoc.getPages();

    const pageDetails = pages.map((page, i) => {
      const { width, height } = page.getSize();
      const trimBox = page.node.lookup(PDFName.of('TrimBox'));
      const bleedBox = page.node.lookup(PDFName.of('BleedBox'));

      const parseBox = (box) => {
        if (!box) return null;
        try {
          const arr = box;
          return {
            x1: arr.lookup(0)?.value() ?? arr.get(0)?.value(),
            y1: arr.lookup(1)?.value() ?? arr.get(1)?.value(),
            x2: arr.lookup(2)?.value() ?? arr.get(2)?.value(),
            y2: arr.lookup(3)?.value() ?? arr.get(3)?.value(),
          };
        } catch { return 'present (unable to parse)'; }
      };

      return {
        page: i + 1,
        mediaBox: { width: Math.round(width * 100) / 100, height: Math.round(height * 100) / 100 },
        mediaBoxMm: {
          width: Math.round(width / 72 * 25.4 * 10) / 10,
          height: Math.round(height / 72 * 25.4 * 10) / 10,
        },
        trimBox: parseBox(trimBox),
        bleedBox: parseBox(bleedBox),
      };
    });

    // 2. Use Ghostscript to detect color spaces
    let colorSpaces = [];
    try {
      // Ghostscript's pdfinfo device reports color usage
      const gsInfoCmd = `gs -dBATCH -dNOPAUSE -dQUIET -sDEVICE=inkcov -o - "${inputPath}" 2>&1`;
      const { stdout } = await execAsync(gsInfoCmd, { timeout: 30000 });

      // inkcov outputs lines like: 0.10000  0.20000  0.30000  0.40000 CMYK OK
      const lines = stdout.trim().split('\n').filter(l => l.includes('CMYK OK') || l.includes('OK'));
      let hasCmyk = false;
      let hasRgb = false;

      for (const line of lines) {
        const match = line.match(/([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
        if (match) {
          const [_, c, m, y, k] = match.map(Number);
          // If any CMY channels have coverage, it's using CMYK
          if (c > 0 || m > 0 || y > 0 || k > 0) {
            hasCmyk = true;
          }
        }
      }

      colorSpaces = hasCmyk ? ['DeviceCMYK'] : ['DeviceRGB'];
    } catch (e) {
      colorSpaces = [`detection failed: ${e.message}`];
    }

    // 3. Check for vector vs raster content using Ghostscript text extraction
    let contentAnalysis = {};
    try {
      // Try to extract text — if text is extractable, it's vector (not rasterized)
      const txtPath = path.join(TEMP_DIR, `${jobId}-text.txt`);
      await execAsync(`gs -dBATCH -dNOPAUSE -dQUIET -sDEVICE=txtwrite -sOutputFile="${txtPath}" "${inputPath}"`, { timeout: 30000 });
      const text = await fs.readFile(txtPath, 'utf-8');
      await fs.unlink(txtPath).catch(() => {});

      const hasText = text.trim().length > 0;
      contentAnalysis = {
        extractableText: hasText,
        textSample: hasText ? text.trim().slice(0, 200) : '(no extractable text — may be outlined/rasterized)',
        note: hasText
          ? 'Text is vector (selectable/extractable). Good for editing, outlined for print.'
          : 'Text is either outlined (vector outlines) or rasterized. Check visually in Acrobat.',
      };
    } catch (e) {
      contentAnalysis = { error: e.message };
    }

    res.json({
      fileSize: pdfBuffer.length,
      pageCount: pages.length,
      pages: pageDetails,
      colorSpaces,
      contentAnalysis,
      verifiedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error(`[${jobId}] Verify error:`, e);
    res.status(500).json({ error: e.message });
  } finally {
    fs.unlink(inputPath).catch(() => {});
  }
}));

// =============================================================================
// EXPORT MULTI-PAGE PDF — PDF-LIB CROP MARKS PIPELINE
//
// Pass 1: Polotno renders VECTOR RGB PDF (bleed only, NO crop marks)
// Pass 2: pdf-lib draws crop marks in RGB + sets TrimBox/BleedBox
// Pass 3: Ghostscript converts to CMYK (if requested)
// =============================================================================
app.post('/export-multipage', authenticate, withCapacity('export-multipage', async (req, res) => {
  const startTime = Date.now();
  const jobId = uuidv4();
  const vectorPath = path.join(TEMP_DIR, `${jobId}-vector.pdf`);
  const boxedPath = path.join(TEMP_DIR, `${jobId}-boxed.pdf`);
  const cmykPath = path.join(TEMP_DIR, `${jobId}-cmyk.pdf`);

  try {
    const { scene, options = {} } = req.body;

    if (!scene || !scene.pages) {
      return res.status(400).json({ error: 'Scene with pages is required' });
    }

    const wantCmyk = options.cmyk === true;
    const bleedMm = Number.isFinite(options.bleed) ? options.bleed : 0;
    const wantCropMarks = options.cropMarks === true;
    const iccProfile = options.iccProfile || 'gracol';

    const dpi = scene.dpi || 300;
    const bleedPx = Math.round(bleedMm * (dpi / 25.4));

    console.log(`[${jobId}] Export multi-page: ${scene.pages.length} pages`);
    console.log(`[${jobId}]   CMYK: ${wantCmyk}, Bleed: ${bleedMm}mm (${bleedPx}px), CropMarks: ${wantCropMarks}, ICC: ${iccProfile}`);

    // Set bleed on each page so Polotno knows the bleed size
    if (bleedPx > 0) {
      for (const page of scene.pages) {
        page.bleed = bleedPx;
      }
    }

    // ── PASS 1: Polotno VECTOR RGB PDF (bleed only, no crop marks) ──
    console.log(`[${jobId}] Pass 1: Polotno vector RGB PDF (includeBleed: ${bleedPx > 0})`);
    await jsonToPDF(scene, vectorPath, {
      title: options.title || 'MergeKit Export',
      includeBleed: bleedPx > 0,
    });

    const vectorSize = (await fs.stat(vectorPath)).size;
    console.log(`[${jobId}] Pass 1 complete: ${vectorSize} bytes (vector RGB)`);

    // ── PASS 2: pdf-lib draws crop marks + sets TrimBox/BleedBox ──
    let currentPath = vectorPath;
    if (bleedMm > 0 || wantCropMarks) {
      console.log(`[${jobId}] Pass 2: pdf-lib crop marks + TrimBox/BleedBox (bleed: ${bleedMm}mm)`);
      await addCropMarksAndBoxes(currentPath, bleedMm, boxedPath);
      currentPath = boxedPath;
    }

    // ── PASS 3: Ghostscript CMYK conversion (if requested) ──
    let finalPath = currentPath;
    if (wantCmyk) {
      console.log(`[${jobId}] Pass 3: Ghostscript vector-safe CMYK conversion (profile: ${iccProfile})`);
      await convertToCmykSafe(currentPath, cmykPath, iccProfile);
      finalPath = cmykPath;
    }

    const finalBuffer = await fs.readFile(finalPath);

    console.log(`[${jobId}] Export complete: ${finalBuffer.length} bytes, ${scene.pages.length} pages in ${Date.now() - startTime}ms`);

    res.set('Content-Type', 'application/pdf');
    res.set('X-Render-Time-Ms', String(Date.now() - startTime));
    res.set('X-Page-Count', String(scene.pages.length));
    res.set('X-Color-Mode', wantCmyk ? 'cmyk' : 'rgb');
    res.set('X-Crop-Marks', wantCropMarks ? 'pdf-lib-drawn' : 'none');
    res.set('X-Pipeline', 'pdf-lib-crop-marks');
    res.send(finalBuffer);
  } catch (e) {
    console.error(`[${jobId}] Multi-page export error:`, e);
    res.status(500).json({ error: e.message, details: e.stack?.slice(0, 500) });
  } finally {
    fs.unlink(vectorPath).catch(() => {});
    fs.unlink(boxedPath).catch(() => {});
    fs.unlink(cmykPath).catch(() => {});
  }
}));

// =============================================================================
// RENDER SINGLE VECTOR PDF — PDF-LIB CROP MARKS PIPELINE
// =============================================================================
app.post('/render-vector', authenticate, withCapacity('render-vector', async (req, res) => {
  const startTime = Date.now();
  const jobId = uuidv4();
  const vectorPath = path.join(TEMP_DIR, `${jobId}-vector.pdf`);
  const boxedPath = path.join(TEMP_DIR, `${jobId}-boxed.pdf`);
  const cmykPath = path.join(TEMP_DIR, `${jobId}-cmyk.pdf`);

  try {
    const { scene, options = {} } = req.body;

    if (!scene) {
      return res.status(400).json({ error: 'Scene is required' });
    }

    const wantCmyk = options.cmyk === true;
    const bleedMm = Number.isFinite(options.bleed) ? options.bleed : 0;
    const wantCropMarks = options.cropMarks === true;
    const iccProfile = options.iccProfile || 'gracol';
    const dpi = scene.dpi || 300;
    const bleedPx = Math.round(bleedMm * (dpi / 25.4));

    console.log(`[${jobId}] Rendering vector PDF (CMYK: ${wantCmyk}, Bleed: ${bleedMm}mm, CropMarks: ${wantCropMarks})`);

    if (bleedPx > 0 && scene.pages) {
      for (const page of scene.pages) {
        page.bleed = bleedPx;
      }
    }

    // Pass 1: Polotno vector RGB (no crop marks)
    await jsonToPDF(scene, vectorPath, {
      title: options.title || 'Export',
      includeBleed: bleedPx > 0,
    });

    // Pass 2: pdf-lib crop marks + TrimBox/BleedBox
    let currentPath = vectorPath;
    if (bleedMm > 0 || wantCropMarks) {
      await addCropMarksAndBoxes(currentPath, bleedMm, boxedPath);
      currentPath = boxedPath;
    }

    // Pass 3: Optional CMYK conversion
    let finalPath = currentPath;
    if (wantCmyk) {
      await convertToCmykSafe(currentPath, cmykPath, iccProfile);
      finalPath = cmykPath;
    }

    const pdfBuffer = await fs.readFile(finalPath);

    console.log(`[${jobId}] Complete: ${pdfBuffer.length} bytes in ${Date.now() - startTime}ms`);

    res.set('Content-Type', 'application/pdf');
    res.set('X-Render-Time-Ms', String(Date.now() - startTime));
    res.set('X-Color-Mode', wantCmyk ? 'cmyk' : 'rgb');
    res.set('X-Pipeline', 'pdf-lib-crop-marks');
    res.send(pdfBuffer);
  } catch (e) {
    console.error(`[${jobId}] Error:`, e);
    res.status(500).json({ error: e.message });
  } finally {
    fs.unlink(vectorPath).catch(() => {});
    fs.unlink(boxedPath).catch(() => {});
    fs.unlink(cmykPath).catch(() => {});
  }
}));

// =============================================================================
// BATCH RENDER VECTOR PDFs (returns base64) — PDF-LIB CROP MARKS PIPELINE
// =============================================================================
app.post('/batch-render-vector', authenticate, withCapacity('batch-render-vector', async (req, res) => {
  const startTime = Date.now();
  const { scenes, options = {} } = req.body;

  if (!Array.isArray(scenes) || scenes.length === 0) {
    return res.status(400).json({ error: 'Scenes array is required' });
  }

  const wantCmyk = options.cmyk === true;
  const bleedMm = Number.isFinite(options.bleed) ? options.bleed : 0;
  const wantCropMarks = options.cropMarks === true;
  const iccProfile = options.iccProfile || 'gracol';

  console.log(`[batch] Rendering ${scenes.length} scenes (CMYK: ${wantCmyk}, CropMarks: ${wantCropMarks})`);

  const results = [];
  let successful = 0;

  for (let i = 0; i < scenes.length; i++) {
    const jobId = uuidv4();
    const vectorPath = path.join(TEMP_DIR, `${jobId}-vector.pdf`);
    const boxedPath = path.join(TEMP_DIR, `${jobId}-boxed.pdf`);
    const cmykPath = path.join(TEMP_DIR, `${jobId}-cmyk.pdf`);

    try {
      const dpi = scenes[i].dpi || 300;
      const bleedPx = Math.round(bleedMm * (dpi / 25.4));

      if (bleedPx > 0 && scenes[i].pages) {
        for (const page of scenes[i].pages) {
          page.bleed = bleedPx;
        }
      }

      // Pass 1: Vector RGB (no crop marks)
      await jsonToPDF(scenes[i], vectorPath, {
        title: options.title || 'Export',
        includeBleed: bleedPx > 0,
      });

      // Pass 2: pdf-lib crop marks + TrimBox/BleedBox
      let currentPath = vectorPath;
      if (bleedMm > 0 || wantCropMarks) {
        await addCropMarksAndBoxes(currentPath, bleedMm, boxedPath);
        currentPath = boxedPath;
      }

      // Pass 3: Optional CMYK
      let finalPath = currentPath;
      if (wantCmyk) {
        await convertToCmykSafe(currentPath, cmykPath, iccProfile);
        finalPath = cmykPath;
      }

      const pdfBuffer = await fs.readFile(finalPath);
      const base64 = pdfBuffer.toString('base64');

      results.push({ index: i, success: true, pdf: base64 });
      successful++;
    } catch (e) {
      console.error(`[batch] Scene ${i} failed:`, e.message);
      results.push({ index: i, success: false, error: e.message });
    } finally {
      fs.unlink(vectorPath).catch(() => {});
      fs.unlink(boxedPath).catch(() => {});
      fs.unlink(cmykPath).catch(() => {});
    }
  }

  console.log(`[batch] Complete: ${successful}/${scenes.length} in ${Date.now() - startTime}ms`);

  res.json({ total: scenes.length, successful, results });
}));

// =============================================================================
// EXPORT LABELS WITH IMPOSITION — PDF-LIB CROP MARKS + TILING
// =============================================================================
app.post('/export-labels', authenticate, withCapacity('export-labels', async (req, res) => {
  const startTime = Date.now();
  const jobId = uuidv4();
  const vectorPath = path.join(TEMP_DIR, `${jobId}-vector.pdf`);
  const boxedPath = path.join(TEMP_DIR, `${jobId}-boxed.pdf`);
  const cmykPath = path.join(TEMP_DIR, `${jobId}-cmyk.pdf`);
  const imposedPath = path.join(TEMP_DIR, `${jobId}-imposed.pdf`);

  try {
    const { scene, layout, options = {} } = req.body;

    if (!scene || !scene.pages) {
      return res.status(400).json({ error: 'Scene with pages is required' });
    }

    if (!layout) {
      return res.status(400).json({ error: 'Layout configuration is required' });
    }

    const labelCount = scene.pages.length;
    const wantCmyk = options.cmyk === true;
    const bleedMm = Number.isFinite(options.bleed) ? options.bleed : 0;
    const wantCropMarks = options.cropMarks === true;
    const iccProfile = options.iccProfile || 'gracol';
    const dpi = scene.dpi || 300;
    const bleedPx = Math.round(bleedMm * (dpi / 25.4));

    console.log(`[${jobId}] Exporting ${labelCount} labels (CMYK: ${wantCmyk}, bleed: ${bleedMm}mm, cropMarks: ${wantCropMarks})`);

    // Set bleed on each page
    if (bleedPx > 0) {
      for (const page of scene.pages) {
        page.bleed = bleedPx;
      }
    }

    // Pass 1: Vector RGB (no crop marks)
    await jsonToPDF(scene, vectorPath, {
      title: options.title || 'Labels Export',
      includeBleed: bleedPx > 0,
    });

    // Pass 2: Skip crop marks for labels with imposition — marks on individual
    // labels would be destroyed when tiled onto sheets. The pipeline becomes:
    // Polotno (with bleed) → Impose onto sheets → Optional CMYK.
    let currentPath = vectorPath;

    // Step 3: Impose labels onto sheets
    console.log(`[${jobId}] Imposing labels onto sheets`);
    await imposeLabels(currentPath, layout, imposedPath, jobId);
    currentPath = imposedPath;

    // Step 4: Optional CMYK conversion
    let finalPath = currentPath;
    if (wantCmyk) {
      await convertToCmykSafe(currentPath, cmykPath, iccProfile);
      finalPath = cmykPath;
    }

    const finalBuffer = await fs.readFile(finalPath);

    console.log(`[${jobId}] Labels exported + imposed: ${finalBuffer.length} bytes in ${Date.now() - startTime}ms`);

    res.set('Content-Type', 'application/pdf');
    res.set('X-Render-Time-Ms', String(Date.now() - startTime));
    res.set('X-Label-Count', String(labelCount));
    res.set('X-Color-Mode', wantCmyk ? 'cmyk' : 'rgb');
    res.set('X-Pipeline', 'pdf-lib-crop-marks');
    res.send(finalBuffer);
  } catch (e) {
    console.error(`[${jobId}] Label export error:`, e);
    res.status(500).json({ error: e.message });
  } finally {
    fs.unlink(vectorPath).catch(() => {});
    fs.unlink(boxedPath).catch(() => {});
    fs.unlink(cmykPath).catch(() => {});
    fs.unlink(imposedPath).catch(() => {});
  }
}));

// =============================================================================
// COMPOSE PDFs (merge multiple PDFs preserving vectors)
// =============================================================================
app.post('/compose-pdfs', authenticate, withCapacity('compose-pdfs', async (req, res) => {
  const startTime = Date.now();
  const jobId = uuidv4();
  const outputPath = path.join(TEMP_DIR, `${jobId}-composed.pdf`);
  const inputPaths = [];

  try {
    const { pdfs, options = {} } = req.body;

    if (!Array.isArray(pdfs) || pdfs.length === 0) {
      return res.status(400).json({ error: 'PDFs array (base64) is required' });
    }

    console.log(`[${jobId}] Composing ${pdfs.length} PDFs`);

    for (let i = 0; i < pdfs.length; i++) {
      const pdfPath = path.join(TEMP_DIR, `${jobId}-input-${i}.pdf`);
      const buffer = Buffer.from(pdfs[i], 'base64');
      await fs.writeFile(pdfPath, buffer);
      inputPaths.push(pdfPath);
    }

    const inputArgs = inputPaths.map(p => `"${p}"`).join(' ');
    await execAsync(`qpdf --empty --pages ${inputArgs} -- "${outputPath}"`);

    const outputBuffer = await fs.readFile(outputPath);

    console.log(`[${jobId}] Composition complete: ${outputBuffer.length} bytes in ${Date.now() - startTime}ms`);

    res.set('Content-Type', 'application/pdf');
    res.set('X-Compose-Time-Ms', String(Date.now() - startTime));
    res.set('X-Page-Count', String(pdfs.length));
    res.send(outputBuffer);
  } catch (e) {
    console.error(`[${jobId}] Composition error:`, e);
    res.status(500).json({ error: e.message });
  } finally {
    for (const p of inputPaths) {
      fs.unlink(p).catch(() => {});
    }
    fs.unlink(outputPath).catch(() => {});
  }
}));

// =============================================================================
// LEGACY ENDPOINTS (kept for backward compatibility)
// =============================================================================
app.post('/render', authenticate, withCapacity('render', async (req, res) => {
  req.url = '/render-vector';
  return app._router.handle(req, res);
}));

app.post('/batch-render', authenticate, withCapacity('batch-render', async (req, res) => {
  req.url = '/batch-render-vector';
  return app._router.handle(req, res);
}));

// =============================================================================
// START SERVER
// =============================================================================
app.listen(PORT, () => {
  console.log(`PDF Export Service running on port ${PORT}`);
  console.log(`Pipeline: Polotno (vector RGB) → pdf-lib (crop marks + boxes) → Ghostscript (CMYK)`);
  console.log(`Endpoints: /health, /render-vector, /batch-render-vector, /export-multipage, /export-labels, /compose-pdfs, /verify-pdf`);
});
