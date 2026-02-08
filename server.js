import express from 'express';
import cors from 'cors';
import path from 'path';
import { promises as fs } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { jsonToPDF } from '@polotno/pdf-export';
import { exec } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

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
// HEALTH CHECK
// =============================================================================
app.get('/health', async (req, res) => {
  try {
    // Check if qpdf is available
    const { stdout: qpdfVersion } = await execAsync('qpdf --version');
    
    // Check if ghostscript is available
    const { stdout: gsVersion } = await execAsync('gs --version');
    
    // Check ICC profiles
    const iccPath = path.join(__dirname, 'profiles');
    const gracol = await fs.access(path.join(iccPath, 'GRACoL2013_CRPC6.icc')).then(() => true).catch(() => false);
    const fogra = await fs.access(path.join(iccPath, 'ISOcoated_v2_eci.icc')).then(() => true).catch(() => false);

    res.json({
      status: 'ok',
      qpdf: qpdfVersion.trim().split('\n')[0],
      ghostscript: gsVersion.trim(),
      icc: { gracol, fogra },
      polotno: '@polotno/pdf-export available',
    });
  } catch (e) {
    res.status(500).json({ status: 'error', error: e.message });
  }
});

// =============================================================================
// RENDER SINGLE VECTOR PDF
// =============================================================================
app.post('/render-vector', authenticate, async (req, res) => {
  const startTime = Date.now();
  const jobId = uuidv4();
  const vectorPath = path.join(TEMP_DIR, `${jobId}-vector.pdf`);
  const cmykPath = path.join(TEMP_DIR, `${jobId}-cmyk.pdf`);

  try {
    const { scene, options = {} } = req.body;

    if (!scene) {
      return res.status(400).json({ error: 'Scene is required' });
    }

    const wantCmyk = options.cmyk === true;
    console.log(`[${jobId}] Rendering vector PDF (CMYK: ${wantCmyk})`);

    // Generate vector PDF with Polotno
    await jsonToPDF(scene, vectorPath, {
      title: options.title || 'Export',
    });

    let outputPath = vectorPath;

    // Convert to CMYK if requested
    if (wantCmyk) {
      const iccProfile = path.join(__dirname, 'profiles', 'GRACoL2013_CRPC6.icc');
      const gsCommand = [
        'gs', '-q', '-dNOPAUSE', '-dBATCH', '-dSAFER',
        '-sDEVICE=pdfwrite',
        '-dCompatibilityLevel=1.4',
        '-dColorConversionStrategy=/CMYK',
        '-dProcessColorModel=/DeviceCMYK',
        '-dConvertCMYKImagesToRGB=false',
        `-sOutputICCProfile="${iccProfile}"`,
        `-sOutputFile="${cmykPath}"`,
        `"${vectorPath}"`,
      ].join(' ');

      try {
        await execAsync(gsCommand);
        outputPath = cmykPath;
      } catch (gsError) {
        console.error(`[${jobId}] CMYK conversion failed:`, gsError.message);
      }
    }

    const pdfBuffer = await fs.readFile(outputPath);
    
    console.log(`[${jobId}] Complete: ${pdfBuffer.length} bytes in ${Date.now() - startTime}ms`);

    res.set('Content-Type', 'application/pdf');
    res.set('X-Render-Time-Ms', String(Date.now() - startTime));
    res.send(pdfBuffer);
  } catch (e) {
    console.error(`[${jobId}] Error:`, e);
    res.status(500).json({ error: e.message });
  } finally {
    fs.unlink(vectorPath).catch(() => {});
    fs.unlink(cmykPath).catch(() => {});
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

  console.log(`[batch] Rendering ${scenes.length} scenes (CMYK: ${options.cmyk})`);

  const results = [];
  let successful = 0;

  for (let i = 0; i < scenes.length; i++) {
    const jobId = uuidv4();
    const outputPath = path.join(TEMP_DIR, `${jobId}.pdf`);

    try {
      await jsonToPDF(scenes[i], outputPath, {
        title: options.title || 'Export',
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
// EXPORT MULTI-PAGE PDF (with bleed, crop marks, and optional CMYK)
// Two-pass: Polotno for vectors → Ghostscript for CMYK color conversion only
// =============================================================================
app.post('/export-multipage', authenticate, async (req, res) => {
  const startTime = Date.now();
  const jobId = uuidv4();
  const vectorPath = path.join(TEMP_DIR, `${jobId}-vector.pdf`);
  const cmykPath = path.join(TEMP_DIR, `${jobId}-cmyk.pdf`);

  try {
    const { scene, options = {} } = req.body;

    if (!scene || !scene.pages) {
      return res.status(400).json({ error: 'Scene with pages is required' });
    }

    const pageCount = scene.pages.length;
    const wantCmyk = options.cmyk === true;
    
    // Convert bleed from mm to pixels (assuming 300 DPI scene)
    // bleed in mm → pixels: bleed_mm * (300 / 25.4)
    const bleedMm = options.bleed || 0;
    const bleedPx = Math.round(bleedMm * (300 / 25.4));
    
    // Crop mark size in pixels (standard 10pt = ~42px at 300 DPI)
    const cropMarkPx = options.cropMarks ? 42 : 0;

    console.log(`[${jobId}] Exporting ${pageCount} pages (CMYK: ${wantCmyk}, bleed: ${bleedMm}mm/${bleedPx}px, cropMarks: ${options.cropMarks})`);

    // =========================================================================
    // PASS 1: Generate vector PDF with Polotno (with bleed/crop marks)
    // =========================================================================
    // Set bleed on each page if not already set
    const sceneWithBleed = {
      ...scene,
      pages: scene.pages.map(page => ({
        ...page,
        bleed: page.bleed || bleedPx,
      })),
    };

    // Polotno PDF export options
    const polotnoOptions = {
      title: options.title || 'MergeKit Export',
      includeBleed: bleedPx > 0,
      cropMarkSize: cropMarkPx,
    };

    console.log(`[${jobId}] Pass 1: Polotno vector PDF generation...`);
    await jsonToPDF(sceneWithBleed, vectorPath, polotnoOptions);

    const vectorStats = await fs.stat(vectorPath);
    console.log(`[${jobId}] Vector PDF generated: ${vectorStats.size} bytes`);

    // =========================================================================
    // PASS 2 (CMYK only): Convert colors without rasterizing
    // =========================================================================
    let outputPath = vectorPath;

    if (wantCmyk) {
      console.log(`[${jobId}] Pass 2: CMYK color conversion (preserving vectors)...`);
      
      const iccProfile = path.join(__dirname, 'profiles', 'GRACoL2013_CRPC6.icc');
      
      // Ghostscript command for CMYK conversion WITHOUT rasterization
      const gsCommand = [
        'gs',
        '-q',
        '-dNOPAUSE',
        '-dBATCH',
        '-dSAFER',
        '-sDEVICE=pdfwrite',
        '-dCompatibilityLevel=1.4',
        '-dColorConversionStrategy=/CMYK',
        '-dProcessColorModel=/DeviceCMYK',
        '-dConvertCMYKImagesToRGB=false',
        '-dPreserveHalftoneInfo=true',
        '-dPreserveOverprintSettings=true',
        `-sOutputICCProfile="${iccProfile}"`,
        `-sOutputFile="${cmykPath}"`,
        `"${vectorPath}"`,
      ].join(' ');

      try {
        await execAsync(gsCommand);
        outputPath = cmykPath;
        
        const cmykStats = await fs.stat(cmykPath);
        console.log(`[${jobId}] CMYK conversion complete: ${cmykStats.size} bytes`);
      } catch (gsError) {
        console.error(`[${jobId}] CMYK conversion failed, returning RGB:`, gsError.message);
        outputPath = vectorPath;
      }
    }

    const pdfBuffer = await fs.readFile(outputPath);
    
    console.log(`[${jobId}] Complete: ${pdfBuffer.length} bytes, ${pageCount} pages in ${Date.now() - startTime}ms`);

    res.set('Content-Type', 'application/pdf');
    res.set('X-Render-Time-Ms', String(Date.now() - startTime));
    res.set('X-Page-Count', String(pageCount));
    res.set('X-Color-Mode', wantCmyk ? 'cmyk' : 'rgb');
    res.send(pdfBuffer);
  } catch (e) {
    console.error(`[${jobId}] Multi-page export error:`, e);
    res.status(500).json({ error: e.message });
  } finally {
    fs.unlink(vectorPath).catch(() => {});
    fs.unlink(cmykPath).catch(() => {});
  }
});

// =============================================================================
// EXPORT LABELS WITH IMPOSITION
// =============================================================================
app.post('/export-labels', authenticate, async (req, res) => {
  const startTime = Date.now();
  const jobId = uuidv4();
  const labelsPath = path.join(TEMP_DIR, `${jobId}-labels.pdf`);

  try {
    const { scene, layout, options = {} } = req.body;

    if (!scene || !scene.pages) {
      return res.status(400).json({ error: 'Scene with pages is required' });
    }

    if (!layout) {
      return res.status(400).json({ error: 'Layout configuration is required' });
    }

    const labelCount = scene.pages.length;
    console.log(`[${jobId}] Exporting ${labelCount} labels (CMYK: ${options.cmyk})`);

    // Export all labels as a multi-page PDF
    await jsonToPDF(scene, labelsPath, {
      title: options.title || 'Labels Export',
    });

    const labelsBuffer = await fs.readFile(labelsPath);
    console.log(`[${jobId}] Labels exported: ${labelsBuffer.length} bytes in ${Date.now() - startTime}ms`);

    // TODO: Implement proper imposition with qpdf/Ghostscript
    // For now, return the multi-page labels PDF directly

    res.set('Content-Type', 'application/pdf');
    res.set('X-Render-Time-Ms', String(Date.now() - startTime));
    res.set('X-Label-Count', String(labelCount));
    res.send(labelsBuffer);
  } catch (e) {
    console.error(`[${jobId}] Label export error:`, e);
    res.status(500).json({ error: e.message });
  } finally {
    fs.unlink(labelsPath).catch(() => {});
  }
});

// =============================================================================
// COMPOSE PDFs (merge multiple PDFs preserving vectors)
// =============================================================================
app.post('/compose-pdfs', authenticate, async (req, res) => {
  const startTime = Date.now();
  const jobId = uuidv4();
  const outputPath = path.join(TEMP_DIR, `${jobId}-composed.pdf`);
  const inputPaths = [];

  try {
    const { pdfs } = req.body;

    if (!Array.isArray(pdfs) || pdfs.length === 0) {
      return res.status(400).json({ error: 'PDFs array (base64) is required' });
    }

    console.log(`[${jobId}] Composing ${pdfs.length} PDFs`);

    // Write base64 PDFs to temp files
    for (let i = 0; i < pdfs.length; i++) {
      const pdfPath = path.join(TEMP_DIR, `${jobId}-input-${i}.pdf`);
      const buffer = Buffer.from(pdfs[i], 'base64');
      await fs.writeFile(pdfPath, buffer);
      inputPaths.push(pdfPath);
    }

    // Use qpdf to merge (preserves PDF structure)
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
// LEGACY ENDPOINTS
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
  console.log(`Endpoints: /health, /render-vector, /batch-render-vector, /export-multipage, /export-labels, /compose-pdfs`);
});
