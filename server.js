import express from 'express';
import cors from 'cors';
import path from 'path';
import { promises as fs } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { jsonToPDF } from '@polotno/pdf-export';
import { exec } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { PDFDocument, rgb, PDFName, PDFArray, PDFNumber } from 'pdf-lib';

const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.API_SECRET || 'V9rQm7L2xAPz8K4nW6bY3cJ5';

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
// GHOSTSCRIPT VECTOR-SAFE CMYK CONVERSION (Pass 2)
//
// Converts RGB PDF to CMYK using specific flags that preserve vectors.
// CRITICAL: Do NOT use -dPDFSETTINGS=/prepress — it causes transparency
// flattening which rasterizes all vector content.
// =============================================================================
async function convertToCmykSafe(inputPath, outputPath, iccProfile) {
  const profilePath = iccProfile === 'fogra39'
    ? '/app/icc/ISOcoated_v2_eci.icc'
    : '/app/icc/GRACoL2013_CRPC6.icc';

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
// CROP MARKS + PDF BOXES — pdf-lib post-processor (Pass 3, additive only)
// =============================================================================
async function addCropMarksAndBoxes(inputPath, bleedMm, outputPath) {
  const pdfBytes = await fs.readFile(inputPath);
  const pdfDoc = await PDFDocument.load(pdfBytes);

  const bleedPt = bleedMm * (72 / 25.4); // mm to PDF points
  const markLength = 14;    // ~5mm in points
  const markOffset = 8.5;   // ~3mm gap between bleed edge and mark start
  const strokeWidth = 0.25;
  const markColor = rgb(0, 0, 0); // Registration black

  for (const page of pdfDoc.getPages()) {
    const { width, height } = page.getSize();

    // MediaBox = full page including bleed (what Polotno exported)
    // TrimBox = inset by bleedPt on all sides (where the cut happens)
    const trimX = bleedPt;
    const trimY = bleedPt;
    const trimW = width - bleedPt * 2;
    const trimH = height - bleedPt * 2;

    // ── Set TrimBox and BleedBox ──
    const trimBox = PDFArray.withContext(pdfDoc.context);
    trimBox.push(PDFNumber.of(trimX));
    trimBox.push(PDFNumber.of(trimY));
    trimBox.push(PDFNumber.of(trimX + trimW));
    trimBox.push(PDFNumber.of(trimY + trimH));
    page.node.set(PDFName.of('TrimBox'), trimBox);

    const bleedBox = PDFArray.withContext(pdfDoc.context);
    bleedBox.push(PDFNumber.of(0));
    bleedBox.push(PDFNumber.of(0));
    bleedBox.push(PDFNumber.of(width));
    bleedBox.push(PDFNumber.of(height));
    page.node.set(PDFName.of('BleedBox'), bleedBox);

    // ── Draw crop marks — 4 corners × 2 lines each = 8 lines ──
    const corners = [
      [trimX, trimY + trimH, -1,  1], // Top-left
      [trimX + trimW, trimY + trimH,  1,  1], // Top-right
      [trimX, trimY, -1, -1], // Bottom-left
      [trimX + trimW, trimY, 1, -1], // Bottom-right
    ];

    for (const [cx, cy, dx, dy] of corners) {
      // Horizontal mark
      const hStartX = cx + dx * markOffset;
      const hEndX = cx + dx * (markOffset + markLength);
      page.drawLine({
        start: { x: hStartX, y: cy },
        end: { x: hEndX, y: cy },
        thickness: strokeWidth,
        color: markColor,
      });

      // Vertical mark
      const vStartY = cy + dy * markOffset;
      const vEndY = cy + dy * (markOffset + markLength);
      page.drawLine({
        start: { x: cx, y: vStartY },
        end: { x: cx, y: vEndY },
        thickness: strokeWidth,
        color: markColor,
      });
    }
  }

  const modifiedBytes = await pdfDoc.save();
  await fs.writeFile(outputPath, modifiedBytes);
  console.log(`[crop-marks] Added crop marks + TrimBox/BleedBox (bleed: ${bleedMm}mm = ${bleedPt.toFixed(1)}pt)`);
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
      ['GRACoL2013', '/app/icc/GRACoL2013_CRPC6.icc'],
      ['Fogra39', '/app/icc/ISOcoated_v2_eci.icc'],
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
      pipeline: 'three-pass (Vector RGB → GS CMYK → pdf-lib crop marks)',
      ghostscript: gsAvailable ? `${gsVersion} (used for vector-safe CMYK conversion)` : 'NOT INSTALLED — CMYK will fail',
      qpdf: qpdfVersion,
      iccProfiles: iccStatus,
      polotno: '@polotno/pdf-export available',
    });
  } catch (e) {
    res.status(500).json({ status: 'error', error: e.message });
  }
});

// =============================================================================
// EXPORT MULTI-PAGE PDF — THREE-PASS PIPELINE
//
// Pass 1: Polotno renders VECTOR RGB PDF (pdfx1a: false — preserves vectors)
// Pass 2: Ghostscript converts RGB→CMYK with vector-safe flags (if requested)
// Pass 3: pdf-lib adds crop marks + TrimBox/BleedBox (additive only)
// =============================================================================
app.post('/export-multipage', authenticate, async (req, res) => {
  const startTime = Date.now();
  const jobId = uuidv4();
  const vectorPath = path.join(TEMP_DIR, `${jobId}-vector.pdf`);
  const cmykPath = path.join(TEMP_DIR, `${jobId}-cmyk.pdf`);
  const markedPath = path.join(TEMP_DIR, `${jobId}-marked.pdf`);

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

    // ── PASS 1: Polotno VECTOR RGB PDF (NO pdfx1a — preserves vectors) ──
    console.log(`[${jobId}] Pass 1: Polotno vector RGB PDF (includeBleed: ${bleedPx > 0})`);
    await jsonToPDF(scene, vectorPath, {
      title: options.title || 'MergeKit Export',
      includeBleed: bleedPx > 0,
      // pdfx1a is intentionally NOT set — keeps true vectors
    });

    const vectorSize = (await fs.stat(vectorPath)).size;
    console.log(`[${jobId}] Pass 1 complete: ${vectorSize} bytes (vector RGB)`);

    // ── PASS 2: Ghostscript CMYK conversion (if requested) — vector-safe ──
    let currentPath = vectorPath;
    if (wantCmyk) {
      console.log(`[${jobId}] Pass 2: Ghostscript vector-safe CMYK conversion (profile: ${iccProfile})`);
      await convertToCmykSafe(vectorPath, cmykPath, iccProfile);
      currentPath = cmykPath;
    }

    // ── PASS 3: pdf-lib crop marks + TrimBox/BleedBox (if requested) ──
    let finalPath = currentPath;
    if (wantCropMarks && bleedMm > 0) {
      console.log(`[${jobId}] Pass 3: Adding crop marks + PDF boxes (bleed: ${bleedMm}mm)`);
      await addCropMarksAndBoxes(currentPath, bleedMm, markedPath);
      finalPath = markedPath;
    }

    const finalBuffer = await fs.readFile(finalPath);

    console.log(`[${jobId}] Export complete: ${finalBuffer.length} bytes, ${scene.pages.length} pages in ${Date.now() - startTime}ms`);

    res.set('Content-Type', 'application/pdf');
    res.set('X-Render-Time-Ms', String(Date.now() - startTime));
    res.set('X-Page-Count', String(scene.pages.length));
    res.set('X-Color-Mode', wantCmyk ? 'cmyk' : 'rgb');
    res.set('X-Crop-Marks', finalPath === markedPath ? 'true' : 'false');
    res.set('X-Pipeline', 'three-pass');
    res.send(finalBuffer);
  } catch (e) {
    console.error(`[${jobId}] Multi-page export error:`, e);
    res.status(500).json({ error: e.message, details: e.stack?.slice(0, 500) });
  } finally {
    fs.unlink(vectorPath).catch(() => {});
    fs.unlink(cmykPath).catch(() => {});
    fs.unlink(markedPath).catch(() => {});
  }
});

// =============================================================================
// RENDER SINGLE VECTOR PDF — THREE-PASS
// =============================================================================
app.post('/render-vector', authenticate, async (req, res) => {
  const startTime = Date.now();
  const jobId = uuidv4();
  const vectorPath = path.join(TEMP_DIR, `${jobId}-vector.pdf`);
  const cmykPath = path.join(TEMP_DIR, `${jobId}-cmyk.pdf`);
  const markedPath = path.join(TEMP_DIR, `${jobId}-marked.pdf`);

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

    // Pass 1: Polotno vector RGB (NO pdfx1a)
    await jsonToPDF(scene, vectorPath, {
      title: options.title || 'Export',
      includeBleed: bleedPx > 0,
    });

    // Pass 2: Optional CMYK conversion
    let currentPath = vectorPath;
    if (wantCmyk) {
      await convertToCmykSafe(vectorPath, cmykPath, iccProfile);
      currentPath = cmykPath;
    }

    // Pass 3: Optional crop marks
    let finalPath = currentPath;
    if (wantCropMarks && bleedMm > 0) {
      await addCropMarksAndBoxes(currentPath, bleedMm, markedPath);
      finalPath = markedPath;
    }

    const pdfBuffer = await fs.readFile(finalPath);

    console.log(`[${jobId}] Complete: ${pdfBuffer.length} bytes in ${Date.now() - startTime}ms`);

    res.set('Content-Type', 'application/pdf');
    res.set('X-Render-Time-Ms', String(Date.now() - startTime));
    res.set('X-Color-Mode', wantCmyk ? 'cmyk' : 'rgb');
    res.set('X-Pipeline', 'three-pass');
    res.send(pdfBuffer);
  } catch (e) {
    console.error(`[${jobId}] Error:`, e);
    res.status(500).json({ error: e.message });
  } finally {
    fs.unlink(vectorPath).catch(() => {});
    fs.unlink(cmykPath).catch(() => {});
    fs.unlink(markedPath).catch(() => {});
  }
});

// =============================================================================
// BATCH RENDER VECTOR PDFs (returns base64) — THREE-PASS
// =============================================================================
app.post('/batch-render-vector', authenticate, async (req, res) => {
  const startTime = Date.now();
  const { scenes, options = {} } = req.body;

  if (!Array.isArray(scenes) || scenes.length === 0) {
    return res.status(400).json({ error: 'Scenes array is required' });
  }

  const wantCmyk = options.cmyk === true;
  const iccProfile = options.iccProfile || 'gracol';

  console.log(`[batch] Rendering ${scenes.length} scenes (CMYK: ${wantCmyk})`);

  const results = [];
  let successful = 0;

  for (let i = 0; i < scenes.length; i++) {
    const jobId = uuidv4();
    const vectorPath = path.join(TEMP_DIR, `${jobId}-vector.pdf`);
    const cmykPath = path.join(TEMP_DIR, `${jobId}-cmyk.pdf`);

    try {
      // Pass 1: Vector RGB
      await jsonToPDF(scenes[i], vectorPath, {
        title: options.title || 'Export',
        // No pdfx1a — vector RGB
      });

      // Pass 2: Optional CMYK
      let finalPath = vectorPath;
      if (wantCmyk) {
        await convertToCmykSafe(vectorPath, cmykPath, iccProfile);
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
      fs.unlink(cmykPath).catch(() => {});
    }
  }

  console.log(`[batch] Complete: ${successful}/${scenes.length} in ${Date.now() - startTime}ms`);

  res.json({ total: scenes.length, successful, results });
});

// =============================================================================
// EXPORT LABELS WITH IMPOSITION — THREE-PASS
// =============================================================================
app.post('/export-labels', authenticate, async (req, res) => {
  const startTime = Date.now();
  const jobId = uuidv4();
  const vectorPath = path.join(TEMP_DIR, `${jobId}-vector.pdf`);
  const cmykPath = path.join(TEMP_DIR, `${jobId}-cmyk.pdf`);
  const markedPath = path.join(TEMP_DIR, `${jobId}-marked.pdf`);
  const outputPath = path.join(TEMP_DIR, `${jobId}-imposed.pdf`);

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

    // Pass 1: Vector RGB
    await jsonToPDF(scene, vectorPath, {
      title: options.title || 'Labels Export',
      includeBleed: bleedPx > 0,
      // No pdfx1a — vector RGB
    });

    // Pass 2: Optional CMYK
    let currentPath = vectorPath;
    if (wantCmyk) {
      await convertToCmykSafe(vectorPath, cmykPath, iccProfile);
      currentPath = cmykPath;
    }

    // Pass 3: Optional crop marks
    if (wantCropMarks && bleedMm > 0) {
      await addCropMarksAndBoxes(currentPath, bleedMm, markedPath);
      currentPath = markedPath;
    }

    // Step 4: Impose labels onto sheets using qpdf
    const imposedBuffer = await imposeLabelsWithQpdf(currentPath, layout, outputPath, jobId);

    console.log(`[${jobId}] Labels exported + imposed: ${imposedBuffer.length} bytes in ${Date.now() - startTime}ms`);

    res.set('Content-Type', 'application/pdf');
    res.set('X-Render-Time-Ms', String(Date.now() - startTime));
    res.set('X-Label-Count', String(labelCount));
    res.set('X-Color-Mode', wantCmyk ? 'cmyk' : 'rgb');
    res.set('X-Pipeline', 'three-pass');
    res.send(imposedBuffer);
  } catch (e) {
    console.error(`[${jobId}] Label export error:`, e);
    res.status(500).json({ error: e.message });
  } finally {
    fs.unlink(vectorPath).catch(() => {});
    fs.unlink(cmykPath).catch(() => {});
    fs.unlink(markedPath).catch(() => {});
    fs.unlink(outputPath).catch(() => {});
  }
});

// =============================================================================
// IMPOSITION HELPER
// =============================================================================
async function imposeLabelsWithQpdf(labelsPath, layout, outputPath, jobId) {
  // For now, return the labels PDF directly (full imposition TBD)
  const outputBuffer = await fs.readFile(labelsPath);
  await fs.writeFile(outputPath, outputBuffer);
  return outputBuffer;
}

// =============================================================================
// COMPOSE PDFs (merge multiple PDFs preserving vectors)
// =============================================================================
app.post('/compose-pdfs', authenticate, async (req, res) => {
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
});

// =============================================================================
// LEGACY ENDPOINTS (kept for backward compatibility)
// =============================================================================
app.post('/render', authenticate, async (req, res) => {
  req.url = '/render-vector';
  return app._router.handle(req, res);
});

app.post('/batch-render', authenticate, async (req, res) => {
  req.url = '/batch-render-vector';
  return app._router.handle(req, res);
});

// =============================================================================
// START SERVER
// =============================================================================
app.listen(PORT, () => {
  console.log(`PDF Export Service running on port ${PORT}`);
  console.log(`Pipeline: Three-pass (Vector RGB → GS CMYK → pdf-lib crop marks)`);
  console.log(`Endpoints: /health, /render-vector, /batch-render-vector, /export-multipage, /export-labels, /compose-pdfs`);
});
