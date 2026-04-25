import { useState } from 'react';

/**
 * Persist state to localStorage with automatic serialization.
 */
export function useLocalStorage<T>(key: string, initialValue: T): [T, (value: T) => void] {
  const [storedValue, setStoredValue] = useState<T>(() => {
    try {
      const item = window.localStorage.getItem(key);
      return item ? (JSON.parse(item) as T) : initialValue;
    } catch {
      return initialValue;
    }
  });

  function setValue(value: T): void {
    setStoredValue(value);
    window.localStorage.setItem(key, JSON.stringify(value));
  }

  return [storedValue, setValue];
}
