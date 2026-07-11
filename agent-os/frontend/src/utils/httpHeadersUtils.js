const SECRET_HEADER_RE = /authorization|api[-_]?key|token|secret|password/i;

export function isSecretHeaderName(key) {
  return SECRET_HEADER_RE.test(String(key || '').trim());
}

export function parseHeadersJson(raw) {
  if (raw == null || raw === '') return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return { ...raw };
  try {
    const parsed = JSON.parse(String(raw));
    if (Array.isArray(parsed)) {
      const out = {};
      for (const row of parsed) {
        const k = String(row?.key || row?.name || '').trim();
        if (k) out[k] = row?.value != null ? String(row.value) : '';
      }
      return out;
    }
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (_) {}
  return {};
}

export function headersObjectToRows(obj = {}) {
  return Object.entries(obj).map(([key, value], i) => ({
    id: `hdr-${i}-${key}`,
    key,
    value: value != null ? String(value) : '',
  }));
}

export function headersRowsToObject(rows = []) {
  const out = {};
  for (const row of rows) {
    const k = String(row?.key || '').trim();
    if (k) out[k] = row?.value != null ? String(row.value) : '';
  }
  return out;
}

export function serializeHeadersJson(obj) {
  return JSON.stringify(obj || {}, null, 2);
}

/** Default rows when empty — one blank row like Postman */
export function defaultHeaderRows() {
  return [{ id: 'hdr-0', key: '', value: '' }];
}
