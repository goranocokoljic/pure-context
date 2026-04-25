import { ref } from 'vue';

type Theme = 'light' | 'dark';

/**
 * Provides theme switching functionality.
 */
export function useTheme() {
  const theme = ref<Theme>('light');

  function toggleTheme(): void {
    theme.value = theme.value === 'light' ? 'dark' : 'light';
  }

  return { theme, toggleTheme };
}
