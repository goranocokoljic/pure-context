import Fastify from 'fastify';
import usersPlugin from './users';

const fastify = Fastify({ logger: true });

fastify.register(usersPlugin, { prefix: '/users' });
fastify.register(require('./auth'), { prefix: '/auth' });

fastify.get('/health', async (_request, _reply) => {
  return { status: 'ok' };
});

fastify.post('/webhook', async (request, reply) => {
  reply.code(201).send({ received: true });
});

export default fastify;
