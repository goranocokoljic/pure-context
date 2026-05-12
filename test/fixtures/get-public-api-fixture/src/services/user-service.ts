export class UserService {
  private users: User[] = [];

  getUser(id: string): User | undefined {
    return this.users.find((u) => u.id === id);
  }

  addUser(user: User): void {
    this.users.push(user);
  }

  removeUser(id: string): boolean {
    const idx = this.users.findIndex((u) => u.id === id);
    if (idx === -1) return false;
    this.users.splice(idx, 1);
    return true;
  }
}

export function createUserService(): UserService {
  return new UserService();
}

function validateUserId(id: string): boolean {
  return id.length > 0 && /^[a-z0-9-]+$/.test(id);
}

export interface User {
  id: string;
  name: string;
  email: string;
}
