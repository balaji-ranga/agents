import { useState } from 'react';
import { resolveMediaSrc, isResolvableMediaUrl } from '../utils/resolveMediaSrc';

/**
 * Renders chat message content: text plus inline images/videos (URLs, data: base64, OpenClaw sandbox media).
 * Use in AgentChat, Broadcast, and standup chat so images/videos display instead of raw URLs.
 */

function ImageWithFallback({ src, alt = 'Image' }) {
  const resolved = resolveMediaSrc(src);
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span style={{ display: 'inline-block', marginTop: '0.5rem', marginBottom: '0.5rem' }}>
        <a href={resolved} target="_blank" rel="noopener noreferrer" style={{ fontSize: '0.9rem', color: 'var(--accent)' }}>
          Open image
        </a>
      </span>
    );
  }
  return (
    <span style={{ display: 'block', marginTop: '0.5rem', marginBottom: '0.5rem' }}>
      <img
        src={resolved}
        alt={alt}
        style={{ maxWidth: '100%', maxHeight: 480, borderRadius: 8, verticalAlign: 'middle' }}
        onError={() => setFailed(true)}
      />
    </span>
  );
}

function toText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (p && (p.text ?? p.content ?? (typeof p === 'string' ? p : ''))) ?? '').join('');
  if (typeof content === 'object' && (content.text || content.content)) return content.text || content.content || '';
  return String(content);
}

/** If the API stored OpenAI-style content parts as JSON string, parse to plain text + image URLs. */
function parseContentParts(str) {
  if (typeof str !== 'string' || !str.trim()) return { text: str, imageUrls: [] };
  const trimmed = str.trim();
  if (trimmed[0] !== '[') return { text: str, imageUrls: [] };
  let parts;
  try {
    parts = JSON.parse(str);
  } catch (_) {
    return { text: str, imageUrls: [] };
  }
  if (!Array.isArray(parts)) return { text: str, imageUrls: [] };
  const textParts = [];
  const imageUrls = [];
  for (const p of parts) {
    if (!p || typeof p !== 'object') continue;
    if (p.type === 'text' && p.text) textParts.push(p.text);
    if (p.type === 'image_url' && p.image_url?.url) imageUrls.push({ url: p.image_url.url, index: textParts.join('').length });
    if (p.type === 'image' && p.image_url) imageUrls.push({ url: typeof p.image_url === 'string' ? p.image_url : p.image_url.url, index: textParts.join('').length });
  }
  const text = textParts.join('');
  return { text, imageUrls };
}

function cleanMediaUrl(url) {
  return String(url || '').trim().replace(/[:;.,]+$/g, '');
}

export default function ChatMessageContent({ content }) {
  const text = toText(content);
  if (!text) return null;
  let contentStr = typeof text === 'string' ? text : String(text);

  // If backend stored OpenAI-style content parts as JSON string, use parsed text and inject image URLs as synthetic media.
  const parsed = parseContentParts(contentStr);
  const extraImageMedia = parsed.imageUrls.map(({ url, index }) => ({ index, length: 0, type: 'image', src: url }));

  const imageExt = /\.(png|jpe?g|gif|webp|bmp)(\?[^\s"'<>]*)?$/i;
  const videoExt = /\.(mp4|webm|ogg)(\?[^\s"'<>]*)?$/i;
  // URL has image extension before ? & or end (for Azure blob etc.)
  const imageInPath = /\.(png|jpe?g|gif|webp|bmp)([\?&]|$)/i;

  const media = [...extraImageMedia];
  const overlaps = (start, len) => media.some((x) => start < x.index + x.length && start + len > x.index);

  if (parsed.text !== contentStr) contentStr = parsed.text;

  // HTML <img src="url"> or <img src='url'>
  const reImgTag = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = reImgTag.exec(contentStr)) !== null) {
    const url = m[1].trim();
    if (!overlaps(m.index, m[0].length) && isResolvableMediaUrl(url)) {
      const type = url.startsWith('data:video/') ? 'video' : 'image';
      media.push({ index: m.index, length: m[0].length, type, src: url, alt: '' });
    }
  }
  // JSON {"url": "..."} (tool result often in reply)
  const reJson = /\{\s*"url"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/g;
  while ((m = reJson.exec(contentStr)) !== null) {
    const url = m[1].replace(/\\"/g, '"');
    const type = url.startsWith('data:video/') ? 'video' : url.startsWith('data:image/') || url.startsWith('data:') ? 'image' : videoExt.test(url) ? 'video' : 'image';
    if (!overlaps(m.index, m[0].length)) media.push({ index: m.index, length: m[0].length, type, src: url });
  }
  const reDataImg = /data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/gi;
  while ((m = reDataImg.exec(contentStr)) !== null) {
    if (!overlaps(m.index, m[0].length)) media.push({ index: m.index, length: m[0].length, type: 'image', src: m[0] });
  }
  const reDataVid = /data:video\/[^;]+;base64,[A-Za-z0-9+/=]+/gi;
  while ((m = reDataVid.exec(contentStr)) !== null) {
    if (!overlaps(m.index, m[0].length)) media.push({ index: m.index, length: m[0].length, type: 'video', src: m[0] });
  }
  // Markdown image ![alt](url) — http(s), data:, or OpenClaw sandbox:/media/...
  const reMdImg = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
  while ((m = reMdImg.exec(contentStr)) !== null) {
    const url = cleanMediaUrl(m[2]);
    if (!overlaps(m.index, m[0].length) && isResolvableMediaUrl(url)) {
      const resolved = resolveMediaSrc(url);
      if (videoExt.test(resolved) || videoExt.test(url)) media.push({ index: m.index, length: m[0].length, type: 'video', src: url, alt: m[1] });
      else media.push({ index: m.index, length: m[0].length, type: 'image', src: url, alt: m[1] });
    }
  }
  // OpenClaw MEDIA: sandbox:/media/... or sandbox:/api/media/... lines
  const reMediaLine = /^MEDIA:(sandbox:(?:\/api\/media\/|\/media\/)[^\s]+)/gm;
  while ((m = reMediaLine.exec(contentStr)) !== null) {
    if (!overlaps(m.index, m[0].length)) {
      media.push({ index: m.index, length: m[0].length, type: 'image', src: m[1], alt: '' });
    }
  }
  const reHttp = /https?:\/\/[^\s<>"']+/g;
  while ((m = reHttp.exec(contentStr)) !== null) {
    const url = m[0];
    if (!overlaps(m.index, url.length)) {
      if (videoExt.test(url)) media.push({ index: m.index, length: url.length, type: 'video', src: url });
      else if (imageExt.test(url) || imageInPath.test(url)) media.push({ index: m.index, length: url.length, type: 'image', src: url });
    }
  }

  media.sort((a, b) => a.index - b.index);
  const segments = [];
  let pos = 0;
  for (const med of media) {
    if (med.index > pos) segments.push({ type: 'text', value: contentStr.slice(pos, med.index) });
    segments.push({ type: med.type, value: med.src, alt: med.alt });
    pos = med.index + med.length;
  }
  if (pos < contentStr.length) segments.push({ type: 'text', value: contentStr.slice(pos) });
  if (segments.length === 0) segments.push({ type: 'text', value: contentStr });

  return (
    <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
      {segments.map((seg, i) => {
        if (seg.type === 'text') return <span key={i}>{seg.value}</span>;
        if (seg.type === 'image') {
          return (
            <ImageWithFallback key={i} src={seg.value} alt={seg.alt || 'Image'} />
          );
        }
        if (seg.type === 'video') {
          return (
            <span key={i} style={{ display: 'block', marginTop: '0.5rem', marginBottom: '0.5rem' }}>
              <video src={resolveMediaSrc(seg.value)} controls style={{ maxWidth: '100%', maxHeight: 480, borderRadius: 8 }} />
            </span>
          );
        }
        return null;
      })}
    </div>
  );
}
