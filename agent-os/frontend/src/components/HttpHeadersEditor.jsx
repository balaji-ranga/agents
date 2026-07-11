import { useEffect, useMemo, useState } from 'react';
import MaskedSecretInput from './MaskedSecretInput';
import {
  defaultHeaderRows,
  headersObjectToRows,
  headersRowsToObject,
  isSecretHeaderName,
  parseHeadersJson,
  serializeHeadersJson,
} from '../utils/httpHeadersUtils';

/**
 * Postman-style HTTP headers editor (key / value rows).
 * Persists as JSON object string via onChange.
 */
export default function HttpHeadersEditor({ value, onChange, className = '' }) {
  const parsed = useMemo(() => parseHeadersJson(value), [value]);
  const [rows, setRows] = useState(() => {
    const r = headersObjectToRows(parsed);
    return r.length ? r : defaultHeaderRows();
  });
  const [showJson, setShowJson] = useState(false);

  useEffect(() => {
    const r = headersObjectToRows(parseHeadersJson(value));
    setRows(r.length ? r : defaultHeaderRows());
  }, [value]);

  const emit = (nextRows) => {
    setRows(nextRows);
    const obj = headersRowsToObject(nextRows.filter((r) => r.key?.trim() || r.value));
    onChange?.(serializeHeadersJson(obj));
  };

  const updateRow = (idx, patch) => {
    const next = rows.map((r, i) => (i === idx ? { ...r, ...patch } : r));
    emit(next);
  };

  const addRow = () => emit([...rows, { id: `hdr-${Date.now()}`, key: '', value: '' }]);

  const removeRow = (idx) => {
    const next = rows.filter((_, i) => i !== idx);
    emit(next.length ? next : defaultHeaderRows());
  };

  return (
    <div className={`http-headers-editor ${className}`.trim()}>
      <div className="http-headers-toolbar">
        <span className="http-headers-title">HTTP Headers</span>
        <button type="button" className="http-headers-link" onClick={() => setShowJson((v) => !v)}>
          {showJson ? 'Key / value' : 'JSON'}
        </button>
        <button type="button" className="http-headers-link" onClick={addRow}>
          + Add header
        </button>
      </div>

      {showJson ? (
        <textarea
          className="http-headers-json"
          rows={5}
          value={typeof value === 'string' ? value : serializeHeadersJson(parsed)}
          onChange={(e) => onChange?.(e.target.value)}
          placeholder='{"Authorization": "Bearer …"}'
        />
      ) : (
        <div className="http-headers-table">
          <div className="http-headers-row http-headers-head">
            <span>Key</span>
            <span>Value</span>
            <span />
          </div>
          {rows.map((row, idx) => (
            <div key={row.id || idx} className="http-headers-row">
              <input
                value={row.key}
                onChange={(e) => updateRow(idx, { key: e.target.value })}
                placeholder="Authorization"
              />
              {isSecretHeaderName(row.key) ? (
                <MaskedSecretInput
                  value={row.value}
                  onChange={(e) => updateRow(idx, { value: e.target.value })}
                  placeholder="Basic … / Bearer … / API key"
                />
              ) : (
                <input
                  value={row.value}
                  onChange={(e) => updateRow(idx, { value: e.target.value })}
                  placeholder="header value"
                />
              )}
              <button type="button" className="http-headers-remove" onClick={() => removeRow(idx)} title="Remove">
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <small className="http-headers-hint">
        Supports templates like {'{{api-login.body.accessToken}}'}. Secret header values are masked.
      </small>
    </div>
  );
}
