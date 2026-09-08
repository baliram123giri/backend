import crypto from 'crypto';
import { verifySession } from '../lib/auth.js';

export async function adminAuth(request, reply) {
  // Bypass authentication strictly for the admin login endpoint
  const pathname = (request.url || '').split('?')[0];
  if (pathname === '/api/admin/login' || pathname === '/login') {
    return;
  }

  const auth = request.headers['x-admin-key'];
  
  if (!auth || typeof auth !== 'string') {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  // 1. Check if it matches static ADMIN_API_KEY (safe constant-time comparison, no default fallback)
  const configuredApiKey = process.env.ADMIN_API_KEY;
  if (configuredApiKey && configuredApiKey.trim().length > 0) {
    const keyBuf = Buffer.from(configuredApiKey, 'utf8');
    const authBuf = Buffer.from(auth, 'utf8');
    if (keyBuf.length === authBuf.length && crypto.timingSafeEqual(keyBuf, authBuf)) {
      return;
    }
  }

  // 2. Verify if it's a signed admin session token
  const session = verifySession(auth);
  if (session && (session.role === 'admin' || session.role === 'superadmin')) {
    request.admin = session;
    return;
  }

  return reply.status(401).send({ error: 'Unauthorized' });
}
