export default async function routes(app, options) {
app.get('/api/proxy-logo', async (request, reply) => {
  const targetUrl = request.query.url;
  if (!targetUrl) {
    return reply.status(400).send({ error: 'Missing url parameter' });
  }

  try {
    const res = await fetch(targetUrl);
    if (!res.ok) {
      return reply.status(res.status).send({ error: 'Failed to fetch image' });
    }

    const contentType = res.headers.get('content-type') || 'image/png';
    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    reply.header('Content-Type', contentType);
    reply.header('Cache-Control', 'public, max-age=86400, s-maxage=86400');
    return reply.send(buffer);
  } catch (err) {
    app.log.error('Error proxying logo:', err);
    return reply.status(500).send({ error: 'Internal Server Error' });
  }
});

// -------------------------------------------------------------
// 3.2 GET /api/proxy-svg
// -------------------------------------------------------------
app.get('/api/proxy-svg', async (request, reply) => {
  const url = request.query.url;
  if (!url) {
    return reply.status(400).send({ error: 'Missing url parameter' });
  }

  try {
    let contentType = 'image/svg+xml';
    const lowerUrl = url.toLowerCase();
    if (lowerUrl.endsWith('.webp')) contentType = 'image/webp';
    else if (lowerUrl.endsWith('.png')) contentType = 'image/png';
    else if (lowerUrl.endsWith('.jpg') || lowerUrl.endsWith('.jpeg')) contentType = 'image/jpeg';

    const isLocal = !url.startsWith('http') || url.startsWith('http://localhost') || url.startsWith('http://127.0.0.1');

    if (isLocal) {
      const fs = await import('fs');
      const path = await import('path');
      let pathname = '';
      try {
        pathname = new URL(url.startsWith('http') ? url : `http://localhost${url}`).pathname;
      } catch {
        pathname = url;
      }

      const filePath = path.join(process.cwd(), 'public', pathname);
      if (fs.existsSync(filePath)) {
        const fileContent = await fs.promises.readFile(filePath);
        reply.header('Content-Type', contentType);
        reply.header('Cache-Control', 'public, max-age=31536000, immutable');
        return reply.send(fileContent);
      }
    }

    const res = await fetch(url);
    if (!res.ok) {
      return reply.status(res.status).send({ error: 'Failed to fetch resource' });
    }

    const respContentType = res.headers.get('content-type') || contentType;
    const arrayBuffer = await res.arrayBuffer();
    
    reply.header('Content-Type', respContentType);
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    return reply.send(Buffer.from(arrayBuffer));
  } catch (err) {
    app.log.error('Proxy error:', err);
    return reply.status(500).send({ error: 'Failed to fetch resource content' });
  }
});

}
