// utils/fetch.js

// Centralized fetch wrapper with default headers, timeouts, and retries
const DEFAULT_TIMEOUT_MS = process.env.FETCH_TIMEOUT_MS
  ? parseInt(process.env.FETCH_TIMEOUT_MS, 10)
  : 10000;
const MAX_RETRIES = process.env.FETCH_MAX_RETRIES
  ? parseInt(process.env.FETCH_MAX_RETRIES, 10)
  : 2;
const USER_AGENT = process.env.FETCH_USER_AGENT || "MetaTune/1.0 (+https://noctark.ai)";

// Dynamically import node-fetch
const importFetch = () => import('node-fetch').then(mod => mod.default || mod);

/**
 * Fetch with timeout, retries, and default User-Agent header.
 * @param {string} url
 * @param {object} options
 * @returns {Promise<Response>}
 */
async function fetchWrapper(url, options = {}) {
  const fetch = await importFetch();
  const opts = { ...options };

  // Merge headers, preferring passed-in values
  opts.headers = {
    'User-Agent': USER_AGENT,
    ...opts.headers,
  };

  // Retry loop
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Setup timeout via AbortController
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const response = await fetch(url, { ...opts, signal: controller.signal });
      clearTimeout(timeout);
      // Retry on server errors
      if (response.status >= 500 && attempt < MAX_RETRIES) {
        await new Promise(res => setTimeout(res, 1000 * (attempt + 1)));
        continue;
      }
      return response;
    } catch (err) {
      clearTimeout(timeout);
      // Retry on timeout or connection reset
      const retriable = err.name === 'AbortError' || err.code === 'ECONNRESET';
      if (retriable && attempt < MAX_RETRIES) {
        await new Promise(res => setTimeout(res, 1000 * (attempt + 1)));
        continue;
      }
      // Non-retriable or max attempts reached
      throw err;
    }
  }
}

module.exports = fetchWrapper;
