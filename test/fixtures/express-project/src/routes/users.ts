import { Router, Request, Response } from 'express';

const router = Router();

router.get('/users', (req: Request, res: Response) => {
  res.json([]);
});

router.get('/users/:id', (req: Request, res: Response) => {
  res.json({ id: req.params.id });
});

router.post('/users', (req: Request, res: Response) => {
  res.status(201).json(req.body);
});

router.put('/users/:id', (req: Request, res: Response) => {
  res.json({ id: req.params.id, ...req.body });
});

router.delete('/users/:id', (req: Request, res: Response) => {
  res.status(204).send();
});

export default router;
