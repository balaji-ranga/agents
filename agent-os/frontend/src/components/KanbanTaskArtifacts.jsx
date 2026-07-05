import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { resolveMediaSrc } from '../utils/resolveMediaSrc';
import AuthenticatedApiLink from './AuthenticatedApiLink.jsx';
import { isAuthenticatedApiPath, normalizeApiPath } from '../utils/authenticatedApiUrl';

const KIND_LABELS = { pdf: 'PDF', csv: 'CSV', image: 'Image', link: 'Link', text: 'Text' };
const FILE_KINDS = new Set(['pdf', 'csv', 'image']);

function PdfInline({ url, label }) {
  const [blobUrl, setBlobUrl] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let objectUrl;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .fetchBlobUrl(url)
      .then((u) => {
        if (cancelled) {
          URL.revokeObjectURL(u);
          return;
        }
        objectUrl = u;
        setBlobUrl(u);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message || 'Failed to load PDF');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url]);

  if (loading) {
    return <div style={{ fontSize: '0.8rem', color: 'var(--muted)', padding: '0.5rem 0' }}>Loading {label}…</div>;
  }
  if (error) {
    const apiPath = normalizeApiPath(url);
    return (
      <div style={{ fontSize: '0.8rem', color: 'var(--error, #dc2626)' }}>
        {error}{' '}
        {isAuthenticatedApiPath(apiPath) ? (
          <AuthenticatedApiLink href={apiPath}>Open PDF</AuthenticatedApiLink>
        ) : (
          <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>
            Open in new tab
          </a>
        )}
      </div>
    );
  }

  return (
    <iframe
      title={label}
      src={blobUrl}
      style={{
        width: '100%',
        height: 420,
        border: '1px solid var(--border)',
        borderRadius: 8,
        background: '#fff',
      }}
    />
  );
}

function AuthenticatedImage({ url, label }) {
  const [blobUrl, setBlobUrl] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let objectUrl;
    let cancelled = false;
    api
      .fetchBlobUrl(url)
      .then((u) => {
        if (cancelled) {
          URL.revokeObjectURL(u);
          return;
        }
        objectUrl = u;
        setBlobUrl(u);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url]);

  if (error) {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)', fontSize: '0.85rem' }}>
        Open {label}
      </a>
    );
  }
  if (!blobUrl) return <div style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>Loading image…</div>;
  return (
    <img
      src={blobUrl}
      alt={label}
      style={{ maxWidth: '100%', maxHeight: 360, borderRadius: 8, border: '1px solid var(--border)' }}
    />
  );
}

function CsvDownload({ url, label }) {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState(null);

  const download = async () => {
    setDownloading(true);
    setError(null);
    try {
      const blobUrl = await api.fetchBlobUrl(url);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = `${label.replace(/\W+/g, '-').slice(0, 40) || 'tracker'}.csv`;
      a.click();
      URL.revokeObjectURL(blobUrl);
    } catch (e) {
      setError(e.message || 'Download failed');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div>
      <button
        type="button"
        onClick={download}
        disabled={downloading}
        style={{
          padding: '0.4rem 0.75rem',
          borderRadius: 6,
          border: 'none',
          background: 'var(--accent)',
          color: 'white',
          cursor: downloading ? 'wait' : 'pointer',
          fontSize: '0.85rem',
        }}
      >
        {downloading ? 'Downloading…' : 'Download CSV'}
      </button>
      {error && <div style={{ fontSize: '0.8rem', color: 'var(--error, #dc2626)', marginTop: 6 }}>{error}</div>}
    </div>
  );
}

function ArtifactPreview({ artifact }) {
  if (!artifact) return null;
  const { kind, label, url, text } = artifact;

  if (kind === 'pdf' && url) return <PdfInline url={url} label={label} />;
  if (kind === 'csv' && url) return <CsvDownload url={url} label={label} />;
  if (kind === 'image' && url) {
    return url.startsWith('/api/') ? (
      <AuthenticatedImage url={url} label={label} />
    ) : (
      <img
        src={resolveMediaSrc(url)}
        alt={label}
        style={{ maxWidth: '100%', maxHeight: 360, borderRadius: 8, border: '1px solid var(--border)' }}
      />
    );
  }
  if (kind === 'text' && text) {
    return (
      <div
        style={{
          fontSize: '0.85rem',
          lineHeight: 1.55,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          maxHeight: 320,
          overflowY: 'auto',
          padding: '0.65rem',
          border: '1px solid var(--border)',
          borderRadius: 8,
          background: 'var(--surface)',
        }}
      >
        {text}
      </div>
    );
  }
  if (url && !url.startsWith('/api/')) {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)', fontSize: '0.9rem' }}>
        Open {label}
      </a>
    );
  }
  return null;
}

export default function KanbanTaskArtifacts({ artifacts = [], groups = [] }) {
  const [filter, setFilter] = useState('files');
  const [selectedId, setSelectedId] = useState(null);

  const fileArtifacts = useMemo(
    () => artifacts.filter((a) => FILE_KINDS.has(a.kind) || a.kind === 'link'),
    [artifacts]
  );
  const textArtifacts = useMemo(() => artifacts.filter((a) => a.kind === 'text'), [artifacts]);

  const filtered = useMemo(() => {
    if (filter === 'all') return artifacts;
    if (filter === 'pdf') return artifacts.filter((a) => a.kind === 'pdf');
    if (filter === 'csv') return artifacts.filter((a) => a.kind === 'csv');
    if (filter === 'files') return fileArtifacts;
    if (filter === 'text') return textArtifacts;
    return artifacts;
  }, [artifacts, filter, fileArtifacts, textArtifacts]);

  useEffect(() => {
    if (!filtered.length) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !filtered.some((a) => a.id === selectedId)) {
      const firstPreview =
        filtered.find((a) => a.kind === 'pdf' && a.inline) ||
        filtered.find((a) => a.kind === 'pdf') ||
        filtered[0];
      setSelectedId(firstPreview?.id || null);
    }
  }, [filtered, selectedId]);

  if (!artifacts.length) {
    return (
      <p style={{ fontSize: '0.85rem', color: 'var(--muted)', fontStyle: 'italic', margin: 0 }}>
        No artifacts for this task yet.
      </p>
    );
  }

  const selected = filtered.find((a) => a.id === selectedId) || artifacts.find((a) => a.id === selectedId);
  const filters = [
    { id: 'files', label: `Files (${fileArtifacts.length})` },
    { id: 'pdf', label: `PDF (${artifacts.filter((a) => a.kind === 'pdf').length})` },
    { id: 'csv', label: `CSV (${artifacts.filter((a) => a.kind === 'csv').length})` },
    { id: 'all', label: `All (${artifacts.length})` },
  ];
  if (textArtifacts.length) filters.push({ id: 'text', label: `Notes (${textArtifacts.length})` });

  const grouped = {};
  for (const a of filtered) {
    const g = a.group || 'Other';
    if (!grouped[g]) grouped[g] = [];
    grouped[g].push(a);
  }
  const groupOrder = groups.length ? groups.filter((g) => grouped[g]?.length) : Object.keys(grouped);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', minHeight: 0 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {filters.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFilter(f.id)}
            style={{
              padding: '0.25rem 0.55rem',
              fontSize: '0.75rem',
              borderRadius: 999,
              border: `1px solid ${filter === f.id ? 'var(--accent)' : 'var(--border)'}`,
              background: filter === f.id ? 'var(--accent)' : 'transparent',
              color: filter === f.id ? 'white' : 'inherit',
              cursor: 'pointer',
            }}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr)',
          gap: '0.75rem',
          minHeight: 0,
        }}
      >
        <div
          style={{
            maxHeight: 240,
            overflowY: 'auto',
            border: '1px solid var(--border)',
            borderRadius: 8,
            background: 'var(--surface)',
          }}
        >
          {groupOrder.map((groupName) => (
            <div key={groupName}>
              <div
                style={{
                  padding: '0.4rem 0.65rem',
                  fontSize: '0.72rem',
                  fontWeight: 600,
                  color: 'var(--muted)',
                  borderBottom: '1px solid var(--border)',
                  background: 'var(--bg)',
                  position: 'sticky',
                  top: 0,
                }}
              >
                {groupName}
              </div>
              {grouped[groupName].map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => setSelectedId(a.id)}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: '0.55rem 0.65rem',
                    border: 'none',
                    borderBottom: '1px solid var(--border)',
                    background: selectedId === a.id ? 'rgba(59, 130, 246, 0.12)' : 'transparent',
                    cursor: 'pointer',
                  }}
                >
                  <span
                    style={{
                      display: 'inline-block',
                      fontSize: '0.65rem',
                      fontWeight: 700,
                      padding: '1px 5px',
                      borderRadius: 4,
                      marginRight: 6,
                      background: 'var(--border)',
                      color: 'var(--text)',
                    }}
                  >
                    {KIND_LABELS[a.kind] || a.kind}
                  </span>
                  <span style={{ fontSize: '0.82rem' }}>{a.label}</span>
                </button>
              ))}
            </div>
          ))}
        </div>

        {selected && (
          <div style={{ minHeight: 0 }}>
            <div style={{ fontWeight: 600, fontSize: '0.85rem', marginBottom: 8 }}>{selected.label}</div>
            <ArtifactPreview artifact={selected} />
            {selected.url && !selected.url.startsWith('/api/') && selected.kind === 'link' && (
              <div style={{ marginTop: 8 }}>
                <a
                  href={selected.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontSize: '0.78rem', color: 'var(--muted)' }}
                >
                  Open in new tab
                </a>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
