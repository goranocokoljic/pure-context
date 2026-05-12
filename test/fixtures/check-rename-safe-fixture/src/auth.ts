// auth.ts — authentication utilities for the rename-safe fixture

export function authenticate(user: string): boolean {
  return user.length > 0;
}

// verifyIdentity exists to create a conflict when newName='verifyIdentity'
export function verifyIdentity(user: string): boolean {
  return true;
}

export function processToken(token: string): string {
  return token.trim();
}

export function isolatedFunc(): void {
  console.log('no external dependencies');
}
