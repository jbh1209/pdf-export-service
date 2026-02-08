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
// CROP MARK INJECTION HELPER
// =============================================================================

/**
 * Generate crop mark line elements for a single corner
 * @param {string} corner - 'tl' | 'tr' | 'bl' | 'br'
 * @param {number} trimWidth - Page width (trim box)
 * @param {number} trimHeight - Page height (trim box)
 * @param {number} bleed - Bleed extension in pixels
 * @param {number} markLength - Length of crop mark lines in pixels
 * @param {number} markOffset - Gap between trim edge and mark start in pixels
 * @returns {Array} Two line elements for this corner
 */
function generateCornerCropMarks(corner, trimWidth, trimHeight, bleed, markLength, markOffset) {
  const strokeWidth = 0.75; // ~0.25pt at 300 DPI
  const stroke = '#000000'; // Registration black
  
  // Calculate positions based on corner
  let hLine, vLine;
  
  switch (corner) {
    case 'tl': // Top-left
      hLine = {
        id: `crop-${corner}-h-${uuidv4().slice(0, 8)}`,
        type: 'line',
        x: -markOffset - markLength,
        y: 0,
        width: markLength,
        height: 0,
        stroke,
        strokeWidth,
      };
      vLine = {
        id: `crop-${corner}-v-${uuidv4().slice(0, 8)}`,
        type: 'line',
        x: 0,
        y: -markOffset - markLength,
        width: 0,
        height: markLength,
        stroke,
        strokeWidth,
      };
      break;
      
    case 'tr': // Top-right
      hLine = {
        id: `crop-${corner}-h-${uuidv4().slice(0, 8)}`,
        type: 'line',
        x: trimWidth + markOffset,
        y: 0,
        width: markLength,
        height: 0,
        stroke,
        strokeWidth,
      };
      vLine = {
        id: `crop-${corner}-v-${uuidv4().slice(0, 8)}`,
        type: 'line',
        x: trimWidth,
        y: -markOffset - markLength,
        width: 0,
        height: markLength,
        stroke,
        strokeWidth,
      };
      break;
      
    case 'bl': // Bottom-left
      hLine = {
        id: `crop-${corner}-h-${uuidv4().slice(0, 8)}`,
        type: 'line',
        x: -markOffset - markLength,
        y: trimHeight,
        width: markLength,
        height: 0,
        stroke,
        strokeWidth,
      };
      vLine = {
        id: `crop-${corner}-v-${uuidv4().slice(0, 8)}`,
        type: 'line',
        x: 0,
        y: trimHeight + markOffset,
        width: 0,
        height: markLength,
        stroke,
        strokeWidth,
      };
      break;
      
    case 'br': // Bottom-right
      hLine = {
        id: `crop-${corner}-h-${uuidv4().slice(0, 8)}`,
        type: 'line',
        x: trimWidth + markOffset,
        y: trimHeight,
        width: markLength,
        height: 0,
        stroke,
        strokeWidth,
      };
      vLine = {
        id: `crop-${corner}-v-${uuidv4().slice(0, 8)}`,
        type: 'line',
        x: trimWidth,
        y: trimHeight + markOffset,
        width: 0,
        height: markLength,
        stroke,
        strokeWidth,
      };
      break;
  }
  
  return [hLine, vLine];
}

/**
 * Inject crop mark elements into the scene JSON
 * @param {Object} scene - Polotno scene JSON
 * @param {number} bleedPx - Bleed in pixels
 * @param {boolean} enableCropMarks - Whether to add crop marks
 * @returns {Object} Modified scene with crop marks
 */
function injectCropMarks(scene, bleedPx, enableCropMarks) {
  if (!enableCropMarks || !scene.pages) {
    return scene;
  }
  
  // Read dimensions from SCENE level (correct Polotno structure)
  const trimWidth = scene.width;
  const trimHeight = scene.height;
  
  // Validate dimensions to prevent NaN
  if (!trimWidth || !trimHeight || isNaN(trimWidth) || isNaN(trimHeight)) {
    console.warn('[crop-marks] Scene dimensions missing, skipping crop marks');
    return scene;
  }
  
  // Crop mark dimensions at 300 DPI
  // Mark length: 10mm ≈ 118px (10 * 300 / 25.4)
  // Mark offset: 3mm ≈ 35px (3 * 300 / 25.4)
  const markLength = Math.round(10 * (300 / 25.4)); // ~118px
  const markOffset = Math.round(3 * (300 / 25.4));  // ~35px
  
  const modifiedPages = scene.pages.map((page, pageIndex) => {
    const bleed = page.bleed || bleedPx;
    
    // Generate crop marks for all four corners using scene dimensions
    const cropMarkElements = [
      ...generateCornerCropMarks('tl', trimWidth, trimHeight, bleed, markLength, markOffset),
      ...generateCornerCropMarks('tr', trimWidth, trimHeight, bleed, markLength, markOffset),
      ...generateCornerCropMarks('bl', trimWidth, trimHeight, bleed, markLength, markOffset),
      ...generateCornerCropMarks('br', trimWidth, trimHeight, bleed, markLength, markOffset),
    ];
    
    console.log(`[crop-marks] Page ${pageIndex + 1}: Added ${cropMarkElements.length} marks at ${trimWidth}x${trimHeight}px`);
    
    return {
      ...page,
      children: [...(page.children || []), ...cropMarkElements],
    };
  });
  
  return { ...scene, pages: modifiedPages };
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
      cropMarks: 'vector injection supported',
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
    const wantCropMarks = options.cropMarks === true;
    
    // Convert bleed from mm to pixels (assuming 300 DPI scene)
    // bleed in mm → pixels: bleed_mm * (300 / 25.4)
    const bleedMm = options.bleed || 0;
    const bleedPx = Math.round(bleedMm * (300 / 25.4));

    console.log(`[${jobId}] Exporting ${pageCount} pages (CMYK: ${wantCmyk}, bleed: ${bleedMm}mm/${bleedPx}px, cropMarks: ${wantCropMarks})`);

    // =========================================================================
    // STEP 1: Apply bleed to pages
    // =========================================================================
    const sceneWithBleed = {
      ...scene,
      pages: scene.pages.map(page => ({
        ...page,
        bleed: page.bleed || bleedPx,
      })),
    };

    // =========================================================================
    // STEP 2: Inject crop mark elements if requested
    // =========================================================================
    const sceneWithMarks = injectCropMarks(sceneWithBleed, bleedPx, wantCropMarks);

    // =========================================================================
    // PASS 1: Generate vector PDF with Polotno
    // =========================================================================
    console.log(`[${jobId}] Pass 1: Polotno vector PDF generation...`);
    await jsonToPDF(sceneWithMarks, vectorPath, {
      title: options.title || 'MergeKit Export',
    });

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
    res.set('X-Crop-Marks', wantCropMarks ? 'injected' : 'none');
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
  console.log(`Crop marks: Vector injection enabled`);
});
