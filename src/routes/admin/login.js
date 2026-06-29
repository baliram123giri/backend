import { prisma } from '../../lib/prisma.js';
import { verifyPassword, signSession } from '../../lib/auth.js';

export default async function loginRoutes(app, options) {
  app.post('/login', {
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string', format: 'email' },
          password: { type: 'string', minLength: 6 }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { email, password } = request.body;

      const user = await prisma.user.findUnique({
        where: { email }
      });

      if (!user) {
        return reply.status(401).send({ error: "Invalid email or password" });
      }

      if (user.status !== "active") {
        return reply.status(403).send({ error: "Account is suspended" });
      }

      const isValid = verifyPassword(password, user.password);
      if (!isValid) {
        return reply.status(401).send({ error: "Invalid email or password" });
      }

      if (user.role !== "admin" && user.role !== "superadmin") {
        return reply.status(403).send({ error: "Unauthorized access" });
      }

      // Generate a signed session token
      const sessionData = {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role
      };
      const token = signSession(sessionData);

      return reply.send({
        success: true,
        token,
        user: sessionData
      });
    } catch (error) {
      app.log.error("Admin login error:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });
}
