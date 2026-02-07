const express = require('express');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.API_SECRET;

// ICC profile paths
const PROFILES = {
  gracol: '/app/profiles/GRACoL2013_CRPC6.icc',
  fogra39: '/app/profiles/ISOcoated_v2_eci.icc'
};

// =============================================================================
// MIDDLEWARE
// =============================================================================

// Authentication middleware
const authMiddleware = (req, res, next) => {
  if (!API_SECRET) {
    console.error('[Auth] API_SECRET not configured');
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  const providedKey = req.headers['x-api-key'];
  if (!providedKey || providedKey !== API_SECRET) {
    console.warn('[Auth] Invalid or missing API key');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
};

// CORS middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-api-key');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// =============================================================================
// HEALTH CHECK
// =============================================================================

app.get('/health', (req, res) => {
  try {
    const gsVersion = execSync('gs --version', { encoding: 'utf8' }).trim();

    const gracolExists = fs.existsSync(PROFILES.gracol);
    const fogra39Exists = fs.existsSync(PROFILES.fogra39);

    res.json({
      status: 'healthy',
      ghostscript: gsVersion,
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
// CMYK CONVERSION ENDPOINT
// =============================================================================

app.post(
  '/convert-cmyk',
  authMiddleware,
  express.raw({ type: 'application/pdf', limit: '100mb' }),
  async (req, res) => {
    const startTime = Date.now();
    const profile = req.query.profile === 'fogra39' ? 'fogra39' : 'gracol';
    const profilePath = PROFILES[profile];

    console.log(`[Convert] Starting CMYK conversion with profile: ${profile}`);

    if (!req.body || req.body.length === 0) {
      return res.status(400).json({ error: 'No PDF data provided' });
    }

    if (!fs.existsSync(profilePath)) {
      console.error(`[Convert] ICC profile not found: ${profilePath}`);
      return res.status(500).json({ error: `ICC profile not found: ${profile}` });
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmyk-'));
    const inputPath = path.join(tempDir, 'input.pdf');
    const outputPath = path.join(tempDir, 'output.pdf');

    try {
      fs.writeFileSync(inputPath, req.body);
      console.log(`[Convert] Input PDF: ${req.body.length} bytes`);

      const gsCommand = [
        'gs',
        '-dBATCH',
        '-dNOPAUSE',
        '-dNOSAFER',
        '-dPDFX',
        '-sDEVICE=pdfwrite',
        '-sColorConversionStrategy=CMYK',
        '-sProcessColorModel=DeviceCMYK',
        '-dOverrideICC=true',
        `-sOutputICCProfile=${profilePath}`,
        `-sOutputFile=${outputPath}`,
        inputPath
      ].join(' ');

      console.log('[Convert] Running Ghostscript...');
      execSync(gsCommand, {
        encoding: 'utf8',
        maxBuffer: 50 * 1024 * 1024
      });

      const cmykPdf = fs.readFileSync(outputPath);
      const duration = Date.now() - startTime;

      console.log(`[Convert] Success: ${cmykPdf.length} bytes in ${duration}ms`);

      res.set('Content-Type', 'application/pdf');
      res.set('X-Conversion-Time-Ms', duration.toString());
      res.send(cmykPdf);
    } catch (error) {
      console.error('[Convert] Ghostscript error:', error.message);
      res.status(500).json({
        error: 'CMYK conversion failed',
        details: error.message
      });
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (e) {
        console.warn('[Convert] Cleanup warning:', e.message);
      }
    }
  }
);

// =============================================================================
// BATCH CONVERSION ENDPOINT
// =============================================================================

app.post(
  '/batch-convert-cmyk',
  authMiddleware,
  express.json({ limit: '200mb' }),
  async (req, res) => {
    const startTime = Date.now();
    const { pdfs, profile = 'gracol' } = req.body;

    if (!Array.isArray(pdfs) || pdfs.length === 0) {
      return res.status(400).json({ error: 'No PDFs provided' });
    }

    console.log(`[Batch] Converting ${pdfs.length} PDFs with profile: ${profile}`);

    const profilePath = PROFILES[profile] || PROFILES.gracol;
    const results = [];

    for (let i = 0; i < pdfs.length; i++) {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmyk-batch-'));
      const inputPath = path.join(tempDir, 'input.pdf');
      const outputPath = path.join(tempDir, 'output.pdf');

      try {
        const pdfBuffer = Buffer.from(pdfs[i], 'base64');
        fs.writeFileSync(inputPath, pdfBuffer);

        const gsCommand = [
          'gs',
          '-dBATCH',
          '-dNOPAUSE',
          '-dNOSAFER',
          '-dPDFX',
          '-sDEVICE=pdfwrite',
          '-sColorConversionStrategy=CMYK',
          '-sProcessColorModel=DeviceCMYK',
          '-dOverrideICC=true',
          `-sOutputICCProfile=${profilePath}`,
          `-sOutputFile=${outputPath}`,
          inputPath
        ].join(' ');

        execSync(gsCommand, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });

        const cmykPdf = fs.readFileSync(outputPath);
        results.push({
          success: true,
          data: cmykPdf.toString('base64')
        });

        console.log(`[Batch] Converted ${i + 1}/${pdfs.length}`);
      } catch (error) {
        console.error(`[Batch] Error on PDF ${i + 1}:`, error.message);
        results.push({
          success: false,
          error: error.message
        });
      } finally {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (e) {}
      }
    }

    const duration = Date.now() - startTime;
    console.log(
      `[Batch] Complete: ${results.filter((r) => r.success).length}/${pdfs.length} successful in ${duration}ms`
    );

    res.json({
      success: true,
      results,
      totalTime: duration
    });
  }
);

// =============================================================================
// START SERVER
// =============================================================================

app.listen(PORT, '0.0.0.0', () => {
  console.log(`CMYK Conversion Service running on port ${PORT}`);
  console.log(`API_SECRET configured: ${API_SECRET ? 'Yes' : 'NO (server will return 500 on authed routes)'}`);

  try {
    const gsVersion = execSync('gs --version', { encoding: 'utf8' }).trim();
    console.log(`Ghostscript version: ${gsVersion}`);
  } catch (e) {
    console.error('WARNING: Ghostscript not found!');
  }

  Object.entries(PROFILES).forEach(([name, p]) => {
    const exists = fs.existsSync(p);
    console.log(`ICC Profile ${name}: ${exists ? 'Found' : 'MISSING!'}`);
  });
});
