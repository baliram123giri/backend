export const loggerConfig = {
  level: process.env.LOG_LEVEL || 'info',
  // In the future, you can integrate Sentry here or via a dedicated transport:
  // transport: { target: '@sentry/node' ... }
  formatters: {
    level: (label) => { return { level: label }; }
  },
  serializers: {
    req: (request) => ({
      method: request.method,
      url: request.url,
      hostname: request.hostname,
      remoteAddress: request.ip,
      remotePort: request.socket.remotePort,
    })
  }
};
