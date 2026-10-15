/* global __APIS__ */
export const APIS = __APIS__;

export class GoogleError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

let cachedToken = null;

async function token(force = false) {
  if (!force && cachedToken) return cachedToken;
  const reply = await chrome.runtime.sendMessage({ to: "background", op: "token", force });
  if (!reply?.token) throw new GoogleError(401, reply?.error ?? "not signed in");
  cachedToken = reply.token;
  return cachedToken;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);

export async function request(url, { as = "json", attempts = 5 } = {}) {
  let refreshed = false;
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${await token()}` } });
    if (response.ok) return as === "blob" ? response.blob() : response.json();
    if (response.status === 401 && !refreshed) {
      refreshed = true;
      cachedToken = null;
      await token(true);
      continue;
    }
    const error = await response.json().then((body) => body.error ?? {}, () => ({}));
    const reasons = (error.errors ?? []).map((detail) => detail.reason);
    const rateLimited = response.status === 403 && reasons.some((reason) => RATE_LIMIT_REASONS.has(reason));
    if ((RETRYABLE.has(response.status) || rateLimited) && attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 500 + Math.random() * 500));
      continue;
    }
    throw new GoogleError(response.status, `${response.status} ${error.message ?? response.statusText}`);
  }
}

export const query = (params) =>
  new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined && value !== null)).toString();
