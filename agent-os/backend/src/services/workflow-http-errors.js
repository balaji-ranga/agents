/**
 * Workflow HTTP helpers — treat non-success responses and transport errors as failures.
 */

function sslHint(err) {
  const msg = `${err?.message || ''} ${err?.cause?.message || ''}`.toLowerCase();
  if (
    msg.includes('certificate') ||
    msg.includes('cert') ||
    msg.includes('ssl') ||
    msg.includes('tls') ||
    err?.cause?.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    err?.cause?.code === 'DEPTH_ZERO_SELF_SIGNED_CERT'
  ) {
    return ' (SSL/TLS certificate error)';
  }
  return '';
}

/** @throws on network/SSL failure */
export function wrapFetchError(err, label = 'HTTP request') {
  throw new Error(`${label} failed: ${err?.message || err}${sslHint(err)}`);
}

/**
 * Fail when status is not 2xx (includes 3xx/4xx/5xx). Only HTTP 200–299 are success.
 * @throws
 */
export function assertHttpSuccess(response, bodyText = '') {
  if (response.ok) return;
  const snippet = String(bodyText || '').slice(0, 300);
  throw new Error(
    `HTTP ${response.status} ${response.statusText || ''}${snippet ? `: ${snippet}` : ''}`.trim()
  );
}
