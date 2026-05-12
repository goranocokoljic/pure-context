export async function authenticate(token: string): Promise<boolean> {
  return token.length > 0;
}

export function generateToken(userId: string): string {
  return `token-${userId}`;
}

export function revokeToken(token: string): void {
  activeTokens.delete(token);
}

function hashPassword(password: string): string {
  return `hashed:${password}`;
}

const activeTokens = new Set<string>();

const SALT_ROUNDS = 10;
