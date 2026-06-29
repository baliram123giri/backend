import crypto from "crypto";

const SESSION_SECRET = process.env.SESSION_SECRET || "d99b2bfb6d394dfca0787e9cfb9f91a0c7ffb68c92a2a0a2df3dcfeb2b9472e3";

/**
 * Hashes a plain text password using PBKDF2 with a random salt.
 * Format: salt:hash
 */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, "sha512").toString("hex");
  return `${salt}:${hash}`;
}

/**
 * Verifies if a password matches the stored PBKDF2 hash.
 */
export function verifyPassword(password, storedHash) {
  try {
    const [salt, hash] = storedHash.split(":");
    if (!salt || !hash) return false;
    const verifyHash = crypto.pbkdf2Sync(password, salt, 10000, 64, "sha512").toString("hex");
    return verifyHash === hash;
  } catch (e) {
    return false;
  }
}

/**
 * Encrypts/signs a session payload to prevent tampering.
 */
export function signSession(data) {
  const payload = Buffer.from(JSON.stringify(data)).toString("base64");
  const signature = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
  return `${payload}.${signature}`;
}

/**
 * Verifies a signed session token and returns the payload if valid.
 */
export function verifySession(token) {
  try {
    const [payload, signature] = token.split(".");
    if (!payload || !signature) return null;
    const expectedSig = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
    
    const signatureBuffer = Buffer.from(signature, "hex");
    const expectedBuffer = Buffer.from(expectedSig, "hex");
    
    // Constant time comparison to prevent timing attacks
    if (signatureBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
      return JSON.parse(Buffer.from(payload, "base64").toString("utf-8"));
    }
    return null;
  } catch (e) {
    return null;
  }
}
