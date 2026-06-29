import { prisma } from '../../lib/prisma.js';

export default async function adminBlogRoutes(app, options) {
  // GET all blog posts
  app.get('/blog', async (request, reply) => {
    try {
      const posts = await prisma.blogPost.findMany({
        orderBy: { createdAt: 'desc' }
      });
      return reply.send({ success: true, posts });
    } catch (error) {
      app.log.error('List admin blog posts error:', error);
      return reply.status(500).send({ error: 'Failed to fetch blog posts' });
    }
  });

  // POST create a new blog post
  app.post('/blog', async (request, reply) => {
    try {
      const { title, description, slug, publishDate, readTime, category, language, thumbnailUrl, author, content } = request.body;

      if (!title || !description || !content) {
        return reply.status(400).send({ error: 'Title, description, and content are required fields' });
      }

      // Auto-generate slug from title if not supplied
      const finalSlug = (slug || title)
        .toLowerCase()
        .trim()
        .replace(/[^\w\s-]/g, '')
        .replace(/[\s_-]+/g, '-')
        .replace(/^-+|-+$/g, '');

      // Check slug uniqueness
      const existing = await prisma.blogPost.findUnique({
        where: { slug: finalSlug }
      });

      if (existing) {
        return reply.status(400).send({ error: 'A blog post with this slug or title already exists' });
      }

      // Default publishDate to current date formatted
      const finalPublishDate = publishDate || new Date().toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
      });

      // Auto-estimate read time if not provided
      const words = content.replace(/<[^>]*>/g, '').split(/\s+/).length;
      const estimatedMinutes = Math.max(1, Math.ceil(words / 200));
      const finalReadTime = readTime || `${estimatedMinutes} min read`;

      const post = await prisma.blogPost.create({
        data: {
          title,
          description,
          slug: finalSlug,
          thumbnailUrl: thumbnailUrl || null,
          publishDate: finalPublishDate,
          readTime: finalReadTime,
          category: category || 'Biodata Tips',
          language: language || 'English',
          author: author || 'Admin',
          content,
        }
      });

      return reply.send({ success: true, post });
    } catch (error) {
      app.log.error('Create blog post error:', error);
      return reply.status(500).send({ error: 'Failed to create blog post' });
    }
  });

  // PUT update a blog post
  app.put('/blog/:id', async (request, reply) => {
    try {
      const { id } = request.params;
      const { title, description, slug, publishDate, readTime, category, language, thumbnailUrl, author, content } = request.body;

      const existingPost = await prisma.blogPost.findUnique({
        where: { id }
      });

      if (!existingPost) {
        return reply.status(404).send({ error: 'Blog post not found' });
      }

      const data = {};
      if (typeof title === 'string') data.title = title;
      if (typeof description === 'string') data.description = description;
      if (typeof publishDate === 'string') data.publishDate = publishDate;
      if (typeof readTime === 'string') data.readTime = readTime;
      if (typeof category === 'string') data.category = category;
      if (typeof language === 'string') data.language = language;
      if (typeof thumbnailUrl === 'string' || thumbnailUrl === null) data.thumbnailUrl = thumbnailUrl;
      if (typeof author === 'string') data.author = author;
      if (typeof content === 'string') data.content = content;

      if (typeof slug === 'string' && slug.trim()) {
        const finalSlug = slug
          .toLowerCase()
          .trim()
          .replace(/[^\w\s-]/g, '')
          .replace(/[\s_-]+/g, '-')
          .replace(/^-+|-+$/g, '');

        if (finalSlug !== existingPost.slug) {
          const duplicate = await prisma.blogPost.findUnique({
            where: { slug: finalSlug }
          });
          if (duplicate) {
            return reply.status(400).send({ error: 'A blog post with this slug already exists' });
          }
          data.slug = finalSlug;
        }
      }

      const updatedPost = await prisma.blogPost.update({
        where: { id },
        data
      });

      return reply.send({ success: true, post: updatedPost });
    } catch (error) {
      app.log.error('Update blog post error:', error);
      return reply.status(500).send({ error: 'Failed to update blog post' });
    }
  });

  // DELETE a blog post
  app.delete('/blog/:id', async (request, reply) => {
    try {
      const { id } = request.params;

      await prisma.blogPost.delete({
        where: { id }
      });

      return reply.send({ success: true, message: 'Blog post deleted successfully' });
    } catch (error) {
      app.log.error('Delete blog post error:', error);
      return reply.status(500).send({ error: 'Failed to delete blog post' });
    }
  });
}
