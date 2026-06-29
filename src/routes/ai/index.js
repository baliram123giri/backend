import { generateAIBiodata } from '../../services/aiService.js';

export default async function aiRoutes(fastify, options) {
  fastify.post('/api/ai-fill-biodata', async (request, reply) => {
    try {
      const { gender, religion, language } = request.body || {};
      
      const data = await generateAIBiodata({ gender, religion, language });
      
      return reply.send({ data });
    } catch (error) {
      request.log.error('[AI Fill Biodata] Error:', error);
      if (error instanceof SyntaxError) {
        return reply.status(500).send({ error: 'AI returned invalid JSON. Please try again.' });
      }
      return reply.status(500).send({ error: error.message || 'Failed to generate AI data' });
    }
  });
}
