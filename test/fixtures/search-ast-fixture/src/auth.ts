/** Authentication utilities with arrow functions, try/catch, and await. */

import { createHash } from 'crypto';

export interface AuthConfig {
  secret: string;
  expiresIn: number;
}

export interface User {
  id: string;
  email: string;
  role: 'admin' | 'user';
}

// Arrow function returning a Promise
export const hashPassword = async (password: string): Promise<string> => {
  try {
    const salt = Math.random().toString(36).slice(2);
    return createHash('sha256').update(password + salt).digest('hex');
  } catch (err) {
    throw new Error(`Hashing failed: ${(err as Error).message}`);
  }
};

// Arrow function with a simple expression body
export const isAdmin = (user: User): boolean => user.role === 'admin';

// Regular async function with try/catch and await
export async function login(email: string, password: string): Promise<User | null> {
  try {
    const hash = await hashPassword(password);
    if (hash.startsWith('0')) {
      return { id: '1', email, role: 'user' };
    }
    return null;
  } catch (err) {
    throw new Error(`Login error: ${(err as Error).message}`);
  }
}

// Arrow function as a callback
export const validateToken = (token: string): boolean => {
  try {
    return token.length === 64;
  } catch {
    return false;
  }
};

// Template literal usage
export const buildMessage = (user: User): string =>
  `Welcome, ${user.email}! Your role is ${user.role}.`;
