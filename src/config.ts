export const DEFAULT_REST_URL = "https://app.clawling.com" as const;
export const DEFAULT_WEBSOCKET_URL = "wss://app.clawling.com/ws" as const;
export const DEFAULT_MEDIA_URL = "https://app.clawling.com" as const;

export function normalizeHttpOrigin(value: string, field: string): string {
  const url = parseAbsoluteUrl(value, field);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${field} must use HTTP or HTTPS`);
  }
  if (
    url.username ||
    url.password ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${field} must be an HTTP(S) origin without credentials, path, query, or fragment`);
  }
  return url.origin;
}

export function normalizeWebSocketUrl(value: string, field: string): string {
  const url = parseAbsoluteUrl(value, field);
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error(`${field} must use WS or WSS`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${field} must not contain credentials, a query, or a fragment`);
  }
  return url.href;
}

function parseAbsoluteUrl(value: string, field: string): URL {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} is required`);
  }
  try {
    return new URL(value.trim());
  } catch {
    throw new Error(`${field} must be an absolute URL`);
  }
}
