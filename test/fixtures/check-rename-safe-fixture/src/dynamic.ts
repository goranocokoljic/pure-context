// dynamic.ts — uses processToken as a string literal for dynamic dispatch
const HANDLER = 'processToken';

export function getDynamicHandler(): string {
  return HANDLER;
}
