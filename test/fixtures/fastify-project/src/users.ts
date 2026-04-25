import { FastifyInstance } from 'fastify';

export default async function usersPlugin(fastify: FastifyInstance) {
  fastify.get('/users', async (_request, _reply) => {
    return [];
  });

  fastify.get('/users/:id', async (request, _reply) => {
    const { id } = request.params as { id: string };
    return { id };
  });

  fastify.post('/users', async (request, reply) => {
    reply.code(201).send(request.body);
  });

  fastify.delete('/users/:id', async (_request, reply) => {
    reply.code(204).send();
  });
}
