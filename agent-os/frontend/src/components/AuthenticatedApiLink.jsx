import { api } from '../api';
import { isAuthenticatedApiPath, normalizeApiPath } from '../utils/authenticatedApiUrl';

/**
 * Link that opens authenticated API assets (PDFs, CSVs) via Bearer token instead of raw href.
 */
export default function AuthenticatedApiLink({ href, children, style, onError }) {
  const apiPath = normalizeApiPath(href);
  const authed = isAuthenticatedApiPath(apiPath);

  const handleClick = async (e) => {
    e.preventDefault();
    try {
      const blobUrl = await api.fetchBlobUrl(apiPath);
      window.open(blobUrl, '_blank', 'noopener,noreferrer');
    } catch (err) {
      onError?.(err);
      console.error('Authenticated download failed:', err);
    }
  };

  if (authed) {
    return (
      <a
        href={apiPath}
        onClick={handleClick}
        style={{ color: 'var(--accent)', textDecoration: 'underline', cursor: 'pointer', ...style }}
      >
        {children}
      </a>
    );
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      style={{ color: 'var(--accent)', textDecoration: 'underline', ...style }}
    >
      {children}
    </a>
  );
}
