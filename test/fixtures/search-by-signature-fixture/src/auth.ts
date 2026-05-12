export interface Request {
  headers: Record<string, string>;
  body: unknown;
}

export interface Response {
  status: number;
  body: unknown;
}

export interface Session {
  userId: string;
  token: string;
}

export async function authenticate(req: Request): Promise<Session> {
  return { userId: 'u1', token: 'tok' };
}

export async function logout(req: Request): Promise<void> {
  // clear session
}

export async function refreshToken(req: Request, res: Response): Promise<Session> {
  return { userId: 'u1', token: 'new-tok' };
}

export function parseToken(token: string): string[] {
  return token.split('.');
}

export async function fetchUser(id: string): Promise<string> {
  return id;
}
