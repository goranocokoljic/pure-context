import type { Session } from './auth.js';

export class UserService {
  private users: Map<string, string> = new Map();

  async createUser(name: string): Promise<void> {
    this.users.set(name, name);
  }

  async getUser(id: string): Promise<string | undefined> {
    return this.users.get(id);
  }

  validateEmail(email: string): boolean {
    return email.includes('@');
  }

  getUserCount(): number {
    return this.users.size;
  }

  async listSessions(userId: string): Promise<Session[]> {
    return [];
  }
}

export function buildUserProfile(id: string, name: string): Record<string, string> {
  return { id, name };
}
