/**
 * Public base URL for webhooks, callbacks, and absolute links.
 * Set AGENT_OS_BASE_URL (or AGENT_OS_PUBLIC_URL / PUBLIC_URL) to your DNS endpoint in production.
 */
export function getPublicBaseUrl() {
  const port = Number(process.env.PORT) || 3001;
  const raw =
    process.env.AGENT_OS_BASE_URL ||
    process.env.AGENT_OS_PUBLIC_URL ||
    process.env.PUBLIC_URL ||
    `http://127.0.0.1:${port}`;
  return String(raw).replace(/\/$/, '');
}
