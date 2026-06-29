import { verifySession } from '../lib/auth.js';

export async function adminAuth(request, reply) {
  // Bypass authentication for the admin login endpoint
  if (request.url === '/api/admin/login' || request.url.includes('/api/admin/login')) {
    return;
  }

  const auth = request.headers['x-admin-key'];
  
  if (!auth) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  // 1. Check if it matches static ADMIN_API_KEY
  const apiKey = process.env.ADMIN_API_KEY || 'admin_key_12345';
  if (auth === apiKey) {
    return;
  }

  // 2. Verify if it's a signed admin session token
  const session = verifySession(auth);
  if (session && (session.role === 'admin' || session.role === 'superadmin')) {
    request.admin = session;
    return;
  }

  return reply.status(401).send({ error: 'Unauthorized' });
}
