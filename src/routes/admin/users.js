import { prisma } from '../../lib/prisma.js';
import { hashPassword } from '../../lib/auth.js';

export default async function adminUsersRoutes(app, options) {
  // GET all users with filtering, sorting, pagination, and search
  app.get('/users', async (request, reply) => {
    try {
      const { search = '', role = '', status = '', page = 1, limit = 10, sortBy = 'createdAt', sortOrder = 'desc' } = request.query;

      const pageNum = parseInt(page);
      const limitNum = parseInt(limit);
      const skip = (pageNum - 1) * limitNum;

      // Build query filters
      const where = {};
      if (search) {
        where.OR = [
          { name: { contains: search, mode: 'insensitive' } },
          { email: { contains: search, mode: 'insensitive' } }
        ];
      }
      if (role && role !== 'all') {
        where.role = role;
      }
      if (status && status !== 'all') {
        where.status = status;
      }

      // Execute database count and search query
      const [users, total] = await Promise.all([
        prisma.user.findMany({
          where,
          skip,
          take: limitNum,
          orderBy: { [sortBy]: sortOrder },
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
            status: true,
            createdAt: true,
            updatedAt: true
          }
        }),
        prisma.user.count({ where })
      ]);

      return reply.send({
        success: true,
        users,
        pagination: {
          total,
          page: pageNum,
          limit: limitNum,
          totalPages: Math.ceil(total / limitNum)
        }
      });
    } catch (error) {
      app.log.error('Admin Fetch Users Error:', error);
      return reply.status(500).send({ error: 'Failed to fetch users' });
    }
  });

  // POST create a new user
  app.post('/users', async (request, reply) => {
    try {
      const { name, email, password, role = 'user', status = 'active' } = request.body;

      if (!name || !email || !password) {
        return reply.status(400).send({ error: 'Name, email, and password are required' });
      }

      const existingUser = await prisma.user.findUnique({
        where: { email }
      });

      if (existingUser) {
        return reply.status(400).send({ error: 'User with this email already exists' });
      }

      const hashedPassword = hashPassword(password);

      const user = await prisma.user.create({
        data: {
          name,
          email,
          password: hashedPassword,
          role,
          status
        },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          status: true,
          createdAt: true
        }
      });

      return reply.send({ success: true, user });
    } catch (error) {
      app.log.error('Admin Create User Error:', error);
      return reply.status(500).send({ error: 'Failed to create user' });
    }
  });

  // PUT update a user (role, status, name, or password)
  app.put('/users/:id', async (request, reply) => {
    try {
      const { id } = request.params;
      const { name, role, status, password } = request.body;

      const updateData = {};
      if (name) updateData.name = name;
      if (role) updateData.role = role;
      if (status) updateData.status = status;
      if (password) {
        updateData.password = hashPassword(password);
      }

      const updatedUser = await prisma.user.update({
        where: { id },
        data: updateData,
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          status: true,
          createdAt: true
        }
      });

      return reply.send({ success: true, user: updatedUser });
    } catch (error) {
      app.log.error('Admin Update User Error:', error);
      return reply.status(500).send({ error: 'Failed to update user' });
    }
  });

  // DELETE a user
  app.delete('/users/:id', async (request, reply) => {
    try {
      const { id } = request.params;

      // Prevent admin from deleting themselves if they match
      if (request.admin && request.admin.id === id) {
        return reply.status(400).send({ error: 'Cannot delete your own administrator account' });
      }

      await prisma.user.delete({
        where: { id }
      });

      return reply.send({ success: true, message: 'User deleted successfully' });
    } catch (error) {
      app.log.error('Admin Delete User Error:', error);
      return reply.status(500).send({ error: 'Failed to delete user' });
    }
  });
}
