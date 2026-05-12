/**
 * index.ts — simple entry point with no logic complexity.
 */

export { parseConfig, processMatrix, validateUserInput, routeRequest } from './core/complex-module.js';
export { processEvent, fetchWithRetry } from './core/another-complex.js';
export { formatDate, clamp, parseQueryString } from './utils/helpers.js';
export { authorizeAction, getUserDisplayName } from './services/user-service.js';
export type { User } from './services/user-service.js';
