import express from 'express';
import { jsonToPDF } from '@polotno/pdf-export';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';

const app = express();
app.use(express.json({ limit: '100mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { error: 'Too many requests' }
});
app.use(limiter);

// Auth middleware - validates shared secret
const authMiddleware = (req, res, next) => {
  const token = req.headers['x-api-key'];
  if (token !== process.env.API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// Health check (no auth required)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Single PDF render
app.post('/render', authMiddleware, async (req, res) => {
  const { scene, options, uploadPath } = req.body;
  
  if (!scene) {
    return res.status(400).json({ error: 'Scene JSON required' });
  }

  const tempPath = `/tmp/${crypto.randomUUID()}.pdf`;
  
  try {
    // Generate vector PDF with optional CMYK
    await jsonToPDF(scene, tempPath, {
      pdfx1a: options?.cmyk ?? false,
      metadata: {
        title: options?.title || 'Export',
        author: 'PDF Export Service',
      },
    });

    // If uploadPath provided, upload to Supabase Storage
    if (uploadPath && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
      const supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_KEY
      );
      
      const pdfBuffer = await fs.readFile(tempPath);
      const { error: uploadError } = await supabase.storage
        .from('generated-pdfs')
        .upload(uploadPath, pdfBuffer, {
          contentType: 'application/pdf',
          upsert: true,
        });
      
      if (uploadError) {
        throw new Error(`Upload failed: ${uploadError.message}`);
      }
      
      await fs.unlink(tempPath);
      return res.json({ success: true, path: uploadPath });
    }

    // Otherwise return PDF bytes
    const pdfBuffer = await fs.readFile(tempPath);
    await fs.unlink(tempPath);
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="export.pdf"');
    res.send(pdfBuffer);
  } catch (error) {
    console.error('Render error:', error);
    try { await fs.unlink(tempPath); } catch {}
    res.status(500).json({ error: error.message });
  }
});

// Batch render (multiple scenes)
app.post('/batch-render', authMiddleware, async (req, res) => {
  const { scenes, options, uploadPrefix } = req.body;
  
  if (!scenes?.length) {
    return res.status(400).json({ error: 'Scenes array required' });
  }

  const results = [];
  const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
    : null;

  for (let i = 0; i < scenes.length; i++) {
    const tempPath = `/tmp/${crypto.randomUUID()}.pdf`;
    
    try {
      await jsonToPDF(scenes[i], tempPath, {
        pdfx1a: options?.cmyk ?? false,
      });

      if (supabase && uploadPrefix) {
        const uploadPath = `${uploadPrefix}/page-${i.toString().padStart(4, '0')}.pdf`;
        const pdfBuffer = await fs.readFile(tempPath);
        
        await supabase.storage
          .from('generated-pdfs')
          .upload(uploadPath, pdfBuffer, {
            contentType: 'application/pdf',
            upsert: true,
          });
        
        results.push({ success: true, path: uploadPath, index: i });
      } else {
        results.push({ success: true, index: i });
      }
      
      await fs.unlink(tempPath);
    } catch (error) {
      console.error(`Render error for scene ${i}:`, error);
      try { await fs.unlink(tempPath); } catch {}
      results.push({ success: false, error: error.message, index: i });
    }
  }

  res.json({ results, total: scenes.length, successful: results.filter(r => r.success).length });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`PDF Export Service running on port ${PORT}`);
});

