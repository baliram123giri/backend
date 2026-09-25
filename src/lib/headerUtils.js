/**
 * Creates an RFC 6266 / RFC 5987 compliant Content-Disposition header value.
 * The standard `filename="..."` must ONLY contain ASCII characters (32..126) to prevent
 * Node.js TypeError [ERR_INVALID_CHAR] in `http.ServerResponse.setHeader`.
 * The UTF-8 encoded `filename*=UTF-8''...` preserves full Unicode / Indic characters in modern browsers.
 *
 * A Unix timestamp is appended to every filename so the browser never shows a
 * "replace existing file?" prompt when the user downloads the same biodata twice.
 * e.g.  Rahul_Sharma.pdf  →  Rahul_Sharma_1727254663.pdf
 *
 * @param {string} rawFileName - Target file name (may contain Unicode/Indic characters)
 * @param {string} defaultBase - ASCII fallback base name (e.g. 'biodata')
 * @param {string} defaultExt - File extension with dot (e.g. '.pdf')
 * @returns {string} Safe Content-Disposition header string
 */
export function getContentDisposition(rawFileName, defaultBase = 'biodata', defaultExt = '.pdf') {
  const raw = (rawFileName && typeof rawFileName === 'string')
    ? rawFileName.trim()
    : `${defaultBase}${defaultExt}`;

  const lastDot = raw.lastIndexOf('.');
  const ext = lastDot !== -1 ? raw.slice(lastDot).replace(/[^a-zA-Z0-9._-]/g, '') : defaultExt;
  const baseWithoutExt = lastDot !== -1 ? raw.slice(0, lastDot) : raw;

  // Strip any existing timestamp suffix to prevent double-timestamping (e.g. name_1742981234_1727254663)
  const cleanBase = baseWithoutExt.replace(/_\d{10,13}$/, '');

  // Strip all non-ASCII characters and illegal header/filename chars
  let cleanAsciiBase = cleanBase
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/["\\/]/g, '')
    .replace(/^[\s_.-]+|[\s_.-]+$/g, '')
    .trim();

  // If stripping left nothing or only symbols, fallback to defaultBase
  if (!cleanAsciiBase) {
    cleanAsciiBase = defaultBase;
  }

  // Append Unix timestamp — guarantees a unique filename on every download so the
  // browser never asks "This file already exists — replace it?" confirmation.
  const ts = Math.floor(Date.now() / 1000);
  const asciiFileName = `${cleanAsciiBase}_${ts}${ext}`;

  // Encode the original Unicode filename + timestamp for the UTF-8 slot (RFC 5987 compliant)
  const rawWithTs = `${cleanBase}_${ts}${ext}`;
  const utf8FileName = encodeURIComponent(rawWithTs)
    .replace(/['()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/\*/g, '%2A');

  return `attachment; filename="${asciiFileName}"; filename*=UTF-8''${utf8FileName}`;
}
