import express from 'express';
import cors from 'cors';
import { jsonToPDF } from '@polotno/pdf-export';
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { execSync } from 'child_process';

const app = express();
const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.API_SECRET || 'V9rQm7L2xAPz8K4nW6bY3cJ5';

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Auth middleware
const authenticate = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// =============================================================================
// HEALTH CHECK
// =============================================================================
app.get('/health', async (req, res) => {
  try {
    // Check Ghostscript
    const gsVersion = execSync('gs --version', { encoding: 'utf8' }).trim();
    
    // Check ICC profiles
    const profilesDir = '/app/profiles';
    const gracolExists = await fs.access(path.join(profilesDir, 'GRACoL2013_CRPC6.icc'))
      .then(() => true).catch(() => false);
    const fogra39Exists = await fs.access(path.join(profilesDir, 'ISOcoated_v2_eci.icc'))
      .then(() => true).catch(() => false);

    res.json({
      status: 'healthy',
      ghostscript: gsVersion,
      polotnoExport: true,
      profiles: {
        gracol: gracolExists,
        fogra39: fogra39Exists
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      error: error.message
    });
  }
});

// =============================================================================
// RENDER VECTOR - Single scene to PDF
// Uses @polotno/pdf-export for true vector output
// =============================================================================
app.post('/render-vector', authenticate, async (req, res) => {
  const { scene, options = {} } = req.body;
  
  if (!scene) {
    return res.status(400).json({ error: 'Missing scene data' });
  }

  const tempDir = `/tmp/render-${uuidv4()}`;
  const outputPath = path.join(tempDir, 'output.pdf');
  const startTime = Date.now();

  try {
    await fs.mkdir(tempDir, { recursive: true });

    console.log(`[render-vector] Starting render, CMYK: ${options.cmyk ?? false}`);

    // Use @polotno/pdf-export for true vector PDF
    await jsonToPDF(scene, outputPath, {
      pdfx1a: options.cmyk ?? false,  // Native CMYK via PDF/X-1a
      metadata: {
        title: options.title || 'MergeKit Export',
        application: 'MergeKit VPS',
        creator: 'MergeKit PDF Service'
      }
    });

    // Read the generated PDF
    const pdfBuffer = await fs.readFile(outputPath);
    const renderTime = Date.now() - startTime;

    console.log(`[render-vector] Success: ${pdfBuffer.length} bytes in ${renderTime}ms`);

    // Return PDF
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Length', pdfBuffer.length);
    res.set('X-Render-Time-Ms', renderTime.toString());
    res.send(pdfBuffer);

    // Cleanup
    await fs.rm(tempDir, { recursive: true, force: true });
  } catch (error) {
    console.error('[render-vector] Error:', error);
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    res.status(500).json({
      error: 'Render failed',
      details: error.message
    });
  }
});

// =============================================================================
// BATCH RENDER VECTOR - Multiple scenes to PDFs
// Returns array of base64-encoded PDFs
// =============================================================================
app.post('/batch-render-vector', authenticate, async (req, res) => {
  const { scenes, options = {} } = req.body;

  if (!scenes || !Array.isArray(scenes) || scenes.length === 0) {
    return res.status(400).json({ error: 'Missing or empty scenes array' });
  }

  console.log(`[batch-render-vector] Processing ${scenes.length} scenes, CMYK: ${options.cmyk ?? false}`);
  const startTime = Date.now();
  const results = [];

  for (let i = 0; i < scenes.length; i++) {
    const tempDir = `/tmp/batch-${uuidv4()}`;
    const outputPath = path.join(tempDir, 'output.pdf');

    try {
      await fs.mkdir(tempDir, { recursive: true });

      await jsonToPDF(scenes[i], outputPath, {
        pdfx1a: options.cmyk ?? false
      });

      const pdfBuffer = await fs.readFile(outputPath);
      results.push({
        index: i,
        success: true,
        pdf: pdfBuffer.toString('base64'),
        size: pdfBuffer.length
      });

      await fs.rm(tempDir, { recursive: true, force: true });
      console.log(`[batch-render-vector] Scene ${i + 1}/${scenes.length} complete`);
    } catch (error) {
      console.error(`[batch-render-vector] Scene ${i} failed:`, error.message);
      results.push({
        index: i,
        success: false,
        error: error.message
      });
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  const totalTime = Date.now() - startTime;
  const successCount = results.filter(r => r.success).length;

  console.log(`[batch-render-vector] Complete: ${successCount}/${scenes.length} in ${totalTime}ms`);

  res.json({
    results,
    successful: successCount,
    total: scenes.length,
    totalTimeMs: totalTime
  });
});

// =============================================================================
// LEGACY: CMYK CONVERSION (kept for backward compatibility)
// Converts existing RGB PDF to CMYK using Ghostscript
// =============================================================================
app.post('/convert-cmyk', authenticate, async (req, res) => {
  const profile = req.query.profile || 'gracol';
  const profileMap = {
    gracol: '/app/profiles/GRACoL2013_CRPC6.icc',
    fogra39: '/app/profiles/ISOcoated_v2_eci.icc'
  };
  const profilePath = profileMap[profile] || profileMap.gracol;

  const tempDir = `/tmp/cmyk-${uuidv4()}`;
  const inputPath = path.join(tempDir, 'input.pdf');
  const outputPath = path.join(tempDir, 'output.pdf');
  const startTime = Date.now();

  try {
    await fs.mkdir(tempDir, { recursive: true });

    // Get raw PDF bytes from request body
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const pdfBuffer = Buffer.concat(chunks);

    if (pdfBuffer.length === 0) {
      return res.status(400).json({ error: 'No PDF data provided' });
    }

    await fs.writeFile(inputPath, pdfBuffer);

    console.log(`[convert-cmyk] Converting ${pdfBuffer.length} bytes with profile: ${profile}`);

    // Ghostscript CMYK conversion (more forgiving than strict PDF/X)
    const gsCommand = [
      'gs',
      '-dBATCH',
      '-dNOPAUSE',
      '-dQUIET',
      '-dNOSAFER',
      '-dPDFSETTINGS=/prepress',
      '-dCompatibilityLevel=1.4',
      '-sDEVICE=pdfwrite',
      '-sColorConversionStrategy=CMYK',
      '-sProcessColorModel=DeviceCMYK',
      '-dConvertCMYKImagesToRGB=false',
      '-dOverrideICC=true',
      `-sOutputICCProfile=${profilePath}`,
      `-sOutputFile=${outputPath}`,
      inputPath
    ].join(' ');

    execSync(gsCommand, {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024
    });

    const cmykBuffer = await fs.readFile(outputPath);
    const conversionTime = Date.now() - startTime;

    console.log(`[convert-cmyk] Success: ${cmykBuffer.length} bytes in ${conversionTime}ms`);

    res.set('Content-Type', 'application/pdf');
    res.set('Content-Length', cmykBuffer.length);
    res.set('X-Conversion-Time-Ms', conversionTime.toString());
    res.send(cmykBuffer);

    await fs.rm(tempDir, { recursive: true, force: true });
  } catch (error) {
    console.error('[convert-cmyk] Error:', error);
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    res.status(500).json({
      error: 'CMYK conversion failed',
      details: error.message
    });
  }
});

// =============================================================================
// BATCH CMYK CONVERSION (legacy)
// =============================================================================
app.post('/batch-convert-cmyk', authenticate, async (req, res) => {
  const { pdfs, profile = 'gracol' } = req.body;

  if (!pdfs || !Array.isArray(pdfs) || pdfs.length === 0) {
    return res.status(400).json({ error: 'Missing or empty pdfs array' });
  }

  const profileMap = {
    gracol: '/app/profiles/GRACoL2013_CRPC6.icc',
    fogra39: '/app/profiles/ISOcoated_v2_eci.icc'
  };
  const profilePath = profileMap[profile] || profileMap.gracol;

  console.log(`[batch-convert-cmyk] Processing ${pdfs.length} PDFs with profile: ${profile}`);
  const startTime = Date.now();
  const results = [];

  for (let i = 0; i < pdfs.length; i++) {
    const tempDir = `/tmp/batch-cmyk-${uuidv4()}`;
    const inputPath = path.join(tempDir, 'input.pdf');
    const outputPath = path.join(tempDir, 'output.pdf');

    try {
      await fs.mkdir(tempDir, { recursive: true });

      // Decode base64 PDF
      const pdfBuffer = Buffer.from(pdfs[i], 'base64');
      await fs.writeFile(inputPath, pdfBuffer);

      const gsCommand = [
        'gs',
        '-dBATCH',
        '-dNOPAUSE',
        '-dQUIET',
        '-dNOSAFER',
        '-dPDFSETTINGS=/prepress',
        '-dCompatibilityLevel=1.4',
        '-sDEVICE=pdfwrite',
        '-sColorConversionStrategy=CMYK',
        '-sProcessColorModel=DeviceCMYK',
        '-dConvertCMYKImagesToRGB=false',
        '-dOverrideICC=true',
        `-sOutputICCProfile=${profilePath}`,
        `-sOutputFile=${outputPath}`,
        inputPath
      ].join(' ');

      execSync(gsCommand, {
        encoding: 'utf8',
        maxBuffer: 50 * 1024 * 1024
      });

      const cmykBuffer = await fs.readFile(outputPath);
      results.push({
        index: i,
        success: true,
        pdf: cmykBuffer.toString('base64'),
        size: cmykBuffer.length
      });

      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      console.error(`[batch-convert-cmyk] PDF ${i} failed:`, error.message);
      results.push({
        index: i,
        success: false,
        error: error.message
      });
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  const totalTime = Date.now() - startTime;
  const successCount = results.filter(r => r.success).length;

  console.log(`[batch-convert-cmyk] Complete: ${successCount}/${pdfs.length} in ${totalTime}ms`);

  res.json({
    results,
    successful: successCount,
    total: pdfs.length,
    totalTimeMs: totalTime
  });
});

// =============================================================================
// START SERVER
// =============================================================================
app.listen(PORT, () => {
  console.log(`MergeKit PDF Service v2.0.0 running on port ${PORT}`);
  console.log(`Endpoints:`);
  console.log(`  GET  /health              - Health check`);
  console.log(`  POST /render-vector       - Render scene to vector PDF`);
  console.log(`  POST /batch-render-vector - Batch render scenes`);
  console.log(`  POST /convert-cmyk        - Convert PDF to CMYK (legacy)`);
  console.log(`  POST /batch-convert-cmyk  - Batch CMYK conversion (legacy)`);
});
