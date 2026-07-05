/**
 * Serve OpenClaw media files (browser screenshots, etc.) from ~/.openclaw/media/
 * Maps sandbox:/media/browser/xxx.png → GET /api/media/openclaw/browser/xxx.png
 */
import { Router } from 'express';
import { join, normalize } from 'path';
import { existsSync, createReadStream } from 'fs';
import { stat } from 'fs/promises';

const router = Router();
const homedir = process.env.USERPROFILE || process.env.HOME || '';
const MEDIA_ROOT = join(homedir, '.openclaw', 'media');

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogg': 'video/ogg',
};

function safeMediaPath(relativePath) {
  const cleaned = String(relativePath || '').replace(/^\/+/, '').replace(/\\/g, '/');
  if (!cleaned || cleaned.includes('..')) return null;
  const abs = normalize(join(MEDIA_ROOT, cleaned));
  const rootNorm = normalize(MEDIA_ROOT);
  if (!abs.startsWith(rootNorm)) return null;
  return abs;
}

// Express 4 does not reliably match mounted sub-routers with regex routes; use middleware.
router.use(async (req, res) => {
  try {
    const rel = decodeURIComponent(req.path.replace(/^\//, ''));
    if (!rel) return res.status(404).json({ error: 'Media path required' });
    const filePath = safeMediaPath(rel);
    if (!filePath || !existsSync(filePath)) {
      return res.status(404).json({ error: 'Media not found' });
    }
    const st = await stat(filePath);
    if (!st.isFile()) return res.status(404).json({ error: 'Not a file' });
    const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    createReadStream(filePath).pipe(res);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
