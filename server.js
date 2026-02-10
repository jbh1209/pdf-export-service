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
// CROP MARKS + PDF BOXES — pdf-lib post-processor (additive only, vector-safe)
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
    // Marks are drawn OUTSIDE the bleed area (offset from trim edge outward)

    const corners = [
      // [trim corner X, trim corner Y, horizontal direction, vertical direction]
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
    // Check if qpdf is available
    let qpdfVersion = 'not installed';
    try {
      const { stdout } = await execAsync('qpdf --version');
      qpdfVersion = stdout.trim().split('\n')[0];
    } catch (_) {}

    // Check if ghostscript is available (kept for info, no longer used for CMYK)
    let gsVersion = 'not installed';
    try {
      const { stdout } = await execAsync('gs --version');
      gsVersion = stdout.trim();
    } catch (_) {}

    res.json({
      status: 'ok',
      ghostscript: gsVersion + ' (not used — Polotno handles CMYK natively)',
      qpdf: qpdfVersion,
      polotno: '@polotno/pdf-export available',
      pipeline: 'two-pass (Polotno pdfx1a CMYK+bleed → pdf-lib crop marks)',
    });
  } catch (e) {
    res.status(500).json({ status: 'error', error: e.message });
  }
});

// =============================================================================
// EXPORT MULTI-PAGE PDF — TWO-PASS PIPELINE
//
// Pass 1: Polotno renders vector CMYK PDF with native bleed (pdfx1a: true)
// Pass 2: pdf-lib adds crop marks + sets TrimBox/BleedBox (additive only)
// =============================================================================
app.post('/export-multipage', authenticate, async (req, res) => {
  const startTime = Date.now();
  const jobId = uuidv4();
  const vectorPath = path.join(TEMP_DIR, `${jobId}-vector.pdf`);
  const markedPath = path.join(TEMP_DIR, `${jobId}-marked.pdf`);

  try {
    const { scene, options = {} } = req.body;

    if (!scene || !scene.pages) {
      return res.status(400).json({ error: 'Scene with pages is required' });
    }

    const wantCmyk = options.cmyk === true;
    const bleedMm = Number.isFinite(options.bleed) ? options.bleed : 0;
    const wantCropMarks = options.cropMarks === true;

    // Convert bleed mm to pixels (scene DPI, default 300)
    const dpi = scene.dpi || 300;
    const bleedPx = Math.round(bleedMm * (dpi / 25.4));

    console.log(`[${jobId}] Export multi-page: ${scene.pages.length} pages`);
    console.log(`[${jobId}]   CMYK: ${wantCmyk}, Bleed: ${bleedMm}mm (${bleedPx}px), CropMarks: ${wantCropMarks}`);

    // Set bleed on each page so Polotno knows the bleed size
    if (bleedPx > 0) {
      for (const page of scene.pages) {
        page.bleed = bleedPx;
      }
    }

    // ── PASS 1: Polotno native vector PDF with bleed + optional CMYK ──
    console.log(`[${jobId}] Pass 1: Polotno vector PDF (includeBleed: ${bleedPx > 0}, pdfx1a: ${wantCmyk})`);

    await jsonToPDF(scene, vectorPath, {
      title: options.title || 'MergeKit Export',
      includeBleed: bleedPx > 0,
      pdfx1a: wantCmyk, // Native CMYK — sanitizer prevents NaN crashes
    });

    const vectorBuffer = await fs.readFile(vectorPath);
    console.log(`[${jobId}] Pass 1 complete: ${vectorBuffer.length} bytes (${wantCmyk ? 'CMYK' : 'RGB'} vector)`);

    // ── PASS 2: Add crop marks + TrimBox/BleedBox via pdf-lib (if requested) ──
    let finalPath = vectorPath;

    if (wantCropMarks && bleedMm > 0) {
      console.log(`[${jobId}] Pass 2: Adding crop marks + PDF boxes (bleed: ${bleedMm}mm)`);
      await addCropMarksAndBoxes(vectorPath, bleedMm, markedPath);
      finalPath = markedPath;
    }

    const finalBuffer = await fs.readFile(finalPath);

    console.log(`[${jobId}] Export complete: ${finalBuffer.length} bytes, ${scene.pages.length} pages in ${Date.now() - startTime}ms`);

    res.set('Content-Type', 'application/pdf');
    res.set('X-Render-Time-Ms', String(Date.now() - startTime));
    res.set('X-Page-Count', String(scene.pages.length));
    res.set('X-Color-Mode', wantCmyk ? 'cmyk' : 'rgb');
    res.set('X-Crop-Marks', finalPath === markedPath ? 'true' : 'false');
    res.send(finalBuffer);
  } catch (e) {
    console.error(`[${jobId}] Multi-page export error:`, e);
    res.status(500).json({ error: e.message, details: e.stack?.slice(0, 500) });
  } finally {
    fs.unlink(vectorPath).catch(() => {});
    fs.unlink(markedPath).catch(() => {});
  }
});

// =============================================================================
// RENDER SINGLE VECTOR PDF
// =============================================================================
app.post('/render-vector', authenticate, async (req, res) => {
  const startTime = Date.now();
  const jobId = uuidv4();
  const vectorPath = path.join(TEMP_DIR, `${jobId}-vector.pdf`);
  const markedPath = path.join(TEMP_DIR, `${jobId}-marked.pdf`);

  try {
    const { scene, options = {} } = req.body;

    if (!scene) {
      return res.status(400).json({ error: 'Scene is required' });
    }

    const wantCmyk = options.cmyk === true;
    const bleedMm = Number.isFinite(options.bleed) ? options.bleed : 0;
    const wantCropMarks = options.cropMarks === true;
    const dpi = scene.dpi || 300;
    const bleedPx = Math.round(bleedMm * (dpi / 25.4));

    console.log(`[${jobId}] Rendering vector PDF (CMYK: ${wantCmyk}, Bleed: ${bleedMm}mm, CropMarks: ${wantCropMarks})`);

    if (bleedPx > 0 && scene.pages) {
      for (const page of scene.pages) {
        page.bleed = bleedPx;
      }
    }

    // Pass 1: Polotno vector PDF with native CMYK
    await jsonToPDF(scene, vectorPath, {
      title: options.title || 'Export',
      includeBleed: bleedPx > 0,
      pdfx1a: wantCmyk,
    });

    // Pass 2: Optional crop marks
    let finalPath = vectorPath;
    if (wantCropMarks && bleedMm > 0) {
      await addCropMarksAndBoxes(vectorPath, bleedMm, markedPath);
      finalPath = markedPath;
    }

    const pdfBuffer = await fs.readFile(finalPath);

    console.log(`[${jobId}] Complete: ${pdfBuffer.length} bytes in ${Date.now() - startTime}ms`);

    res.set('Content-Type', 'application/pdf');
    res.set('X-Render-Time-Ms', String(Date.now() - startTime));
    res.set('X-Color-Mode', wantCmyk ? 'cmyk' : 'rgb');
    res.send(pdfBuffer);
  } catch (e) {
    console.error(`[${jobId}] Error:`, e);
    res.status(500).json({ error: e.message });
  } finally {
    fs.unlink(vectorPath).catch(() => {});
    fs.unlink(markedPath).catch(() => {});
  }
});

// =============================================================================
// BATCH RENDER VECTOR PDFs (returns base64)
// =============================================================================
app.post('/batch-render-vector', authenticate, async (req, res) => {
  const startTime = Date.now();
  const { scenes, options = {} } = req.body;

  if (!Array.isArray(scenes) || scenes.length === 0) {
    return res.status(400).json({ error: 'Scenes array is required' });
  }

  const wantCmyk = options.cmyk === true;

  console.log(`[batch] Rendering ${scenes.length} scenes (CMYK: ${wantCmyk})`);

  const results = [];
  let successful = 0;

  for (let i = 0; i < scenes.length; i++) {
    const jobId = uuidv4();
    const outputPath = path.join(TEMP_DIR, `${jobId}.pdf`);

    try {
      await jsonToPDF(scenes[i], outputPath, {
        title: options.title || 'Export',
        pdfx1a: wantCmyk,
      });

      const pdfBuffer = await fs.readFile(outputPath);
      const base64 = pdfBuffer.toString('base64');

      results.push({ index: i, success: true, pdf: base64 });
      successful++;
    } catch (e) {
      console.error(`[batch] Scene ${i} failed:`, e.message);
      results.push({ index: i, success: false, error: e.message });
    } finally {
      fs.unlink(outputPath).catch(() => {});
    }
  }

  console.log(`[batch] Complete: ${successful}/${scenes.length} in ${Date.now() - startTime}ms`);

  res.json({ total: scenes.length, successful, results });
});

// =============================================================================
// EXPORT LABELS WITH IMPOSITION
// =============================================================================
app.post('/export-labels', authenticate, async (req, res) => {
  const startTime = Date.now();
  const jobId = uuidv4();
  const labelsPath = path.join(TEMP_DIR, `${jobId}-labels.pdf`);
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
    const dpi = scene.dpi || 300;
    const bleedPx = Math.round(bleedMm * (dpi / 25.4));

    console.log(`[${jobId}] Exporting ${labelCount} labels (CMYK: ${wantCmyk}, bleed: ${bleedMm}mm, cropMarks: ${wantCropMarks})`);

    // Set bleed on each page
    if (bleedPx > 0) {
      for (const page of scene.pages) {
        page.bleed = bleedPx;
      }
    }

    // Step 1: Export all labels as a multi-page PDF with native CMYK + bleed
    await jsonToPDF(scene, labelsPath, {
      title: options.title || 'Labels Export',
      includeBleed: bleedPx > 0,
      pdfx1a: wantCmyk,
    });

    // Step 2: Add crop marks if requested
    let pdfForImposition = labelsPath;
    if (wantCropMarks && bleedMm > 0) {
      await addCropMarksAndBoxes(labelsPath, bleedMm, markedPath);
      pdfForImposition = markedPath;
    }

    // Step 3: Impose labels onto sheets using qpdf
    const imposedBuffer = await imposeLabelsWithQpdf(pdfForImposition, layout, outputPath, jobId);

    const labelsBuffer = await fs.readFile(pdfForImposition);
    console.log(`[${jobId}] Labels exported: ${labelsBuffer.length} bytes`);
    console.log(`[${jobId}] Imposition complete: ${imposedBuffer.length} bytes in ${Date.now() - startTime}ms`);

    res.set('Content-Type', 'application/pdf');
    res.set('X-Render-Time-Ms', String(Date.now() - startTime));
    res.set('X-Label-Count', String(labelCount));
    res.set('X-Color-Mode', wantCmyk ? 'cmyk' : 'rgb');
    res.send(imposedBuffer);
  } catch (e) {
    console.error(`[${jobId}] Label export error:`, e);
    res.status(500).json({ error: e.message });
  } finally {
    fs.unlink(labelsPath).catch(() => {});
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
  console.log(`Pipeline: Two-pass (Polotno pdfx1a CMYK+bleed → pdf-lib crop marks)`);
  console.log(`Endpoints: /health, /render-vector, /batch-render-vector, /export-multipage, /export-labels, /compose-pdfs`);
});
