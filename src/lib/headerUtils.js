/**
 * Creates an RFC 6266 / RFC 5987 compliant Content-Disposition header value.
 * The standard `filename="..."` must ONLY contain ASCII characters (32..126) to prevent
 * Node.js TypeError [ERR_INVALID_CHAR] in `http.ServerResponse.setHeader`.
 * The UTF-8 encoded `filename*=UTF-8''...` preserves full Unicode / Indic characters in modern browsers.
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

  // Strip all non-ASCII characters and illegal header/filename chars
  let cleanAsciiBase = baseWithoutExt
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/["\\/]/g, '')
    .replace(/^[\s_.-]+|[\s_.-]+$/g, '')
    .trim();

  // If stripping left nothing or only symbols, fallback to defaultBase
  if (!cleanAsciiBase) {
    cleanAsciiBase = defaultBase;
  }

  const asciiFileName = `${cleanAsciiBase}${ext}`;
  const utf8FileName = encodeURIComponent(raw)
    .replace(/['()]/g, escape)
    .replace(/\*/g, '%2A');

  return `attachment; filename="${asciiFileName}"; filename*=UTF-8''${utf8FileName}`;
}
