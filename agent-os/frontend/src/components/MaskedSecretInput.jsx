import { useState } from 'react';

/**
 * Secret input masked by default; reveal with eye toggle.
 */
export default function MaskedSecretInput({
  value,
  onChange,
  placeholder,
  rows,
  className = '',
  autoComplete = 'off',
  id,
}) {
  const [visible, setVisible] = useState(false);
  const multiline = rows != null && rows > 1;
  const shared = {
    id,
    value: value ?? '',
    onChange,
    placeholder,
    autoComplete,
    className: `masked-secret-input ${className}`.trim(),
    style: !visible && multiline ? { WebkitTextSecurity: 'disc' } : undefined,
  };

  return (
    <div className="masked-secret-wrap">
      {multiline ? (
        <textarea rows={rows} {...shared} />
      ) : (
        <input type={visible ? 'text' : 'password'} {...shared} />
      )}
      <button
        type="button"
        className="masked-secret-toggle"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? 'Hide secret' : 'Show secret'}
        title={visible ? 'Hide' : 'Show'}
      >
        {visible ? '🙈' : '👁'}
      </button>
    </div>
  );
}

/** Build { auth: { bearer, headers } } for MCP connect/call APIs. */
export function buildMcpAuthPayload(httpHeadersJson, legacyBearer = '', legacyHeadersJson = '') {
  const headers = {
    ...parseHeadersFromJson(legacyHeadersJson),
    ...parseHeadersFromJson(httpHeadersJson),
  };
  const auth = {};
  const bearer = String(legacyBearer || '').trim();
  if (bearer && !headers.Authorization && !headers.authorization) {
    auth.bearer = bearer;
  }
  if (Object.keys(headers).length) auth.headers = headers;
  return Object.keys(auth).length ? { auth } : {};
}

function parseHeadersFromJson(raw) {
  if (!raw || !String(raw).trim()) return {};
  try {
    const parsed = JSON.parse(String(raw));
    if (Array.isArray(parsed)) {
      const out = {};
      for (const row of parsed) {
        const k = String(row?.key || '').trim();
        if (k) out[k] = String(row?.value ?? '');
      }
      return out;
    }
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}
