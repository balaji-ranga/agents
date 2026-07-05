/**
 * Resolve OpenClaw virtual media URLs for browser/API-served assets.
 * sandbox:/media/browser/uuid.png → /api/media/openclaw/browser/uuid.png
 * sandbox:/api/media/openclaw/generated/uuid.png → /api/media/openclaw/generated/uuid.png
 */
export function resolveMediaSrc(src) {
  if (!src || typeof src !== 'string') return src;
  const trimmed = src.trim();

  if (trimmed.startsWith('sandbox:/api/media/')) {
    return trimmed.slice('sandbox:'.length);
  }
  if (trimmed.startsWith('sandbox:api/media/')) {
    return `/${trimmed.slice('sandbox:'.length)}`;
  }
  if (trimmed.startsWith('sandbox:/media/')) {
    return `/api/media/openclaw/${trimmed.slice('sandbox:/media/'.length)}`;
  }
  if (trimmed.startsWith('sandbox:media/')) {
    return `/api/media/openclaw/${trimmed.slice('sandbox:media/'.length)}`;
  }
  if (trimmed.startsWith('/media/')) {
    return `/api/media/openclaw/${trimmed.slice('/media/'.length)}`;
  }
  return trimmed;
}

export function isResolvableMediaUrl(url) {
  if (!url) return false;
  return (
    url.startsWith('data:') ||
    url.startsWith('http://') ||
    url.startsWith('https://') ||
    url.startsWith('/api/media/') ||
    url.startsWith('sandbox:/api/media/') ||
    url.startsWith('sandbox:api/media/') ||
    url.startsWith('sandbox:/media/') ||
    url.startsWith('sandbox:media/') ||
    url.startsWith('/media/')
  );
}
