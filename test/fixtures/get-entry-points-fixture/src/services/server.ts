/**
 * HTTP server bootstrap.
 */

import express from 'express';

/** Starts the HTTP server and binds it to a port. */
export async function startServer(port = 3000): Promise<void> {
  const app = express();
  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
}

/** Bootstrap function — alias for startServer used in tests. */
export async function bootstrap(): Promise<void> {
  await startServer();
}

/** Internal: configure middleware. Not an entry point. */
function configureMiddleware(app: express.Application): void {
  app.use(express.json());
}

/** Internal: route setup. Not an entry point. */
function configureRoutes(app: express.Application): void {
  app.get('/health', (_req, res) => res.json({ ok: true }));
}
