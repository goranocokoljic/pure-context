import { ref, computed } from 'vue';

interface User {
  id: number;
  name: string;
  email: string;
}

/**
 * Manages authentication state and user session.
 */
export function useAuth() {
  const user = ref<User | null>(null);
  const isAuthenticated = computed(() => user.value !== null);

  function login(credentials: { email: string; password: string }): Promise<void> {
    // Stub implementation
    return Promise.resolve();
  }

  function logout(): void {
    user.value = null;
  }

  return { user, isAuthenticated, login, logout };
}
