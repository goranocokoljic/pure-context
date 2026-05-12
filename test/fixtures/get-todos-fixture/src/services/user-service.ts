// TODO: add password validation
// TODO(alice): implement rate limiting
export function createUser(name: string, email: string) {
  // FIXME: validate email format before saving
  return { id: Math.random(), name, email };
}

export class UserRepository {
  // HACK: using in-memory storage until DB is ready
  private users: unknown[] = [];

  findById(id: number) {
    // NOTE: this is O(n) — replace with a hash map
    return this.users.find((u: unknown) => (u as { id: number }).id === id);
  }

  deleteUser(id: number) {
    // TODO(bob): add audit logging before deletion
    this.users = this.users.filter((u: unknown) => (u as { id: number }).id !== id);
  }
}
