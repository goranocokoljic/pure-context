/**
 * Fixture test file — referenced by check-delete-safe tests to verify
 * that symbols used only in test files get a 'test-subject' risk.
 *
 * This file intentionally calls testSubject so that the fixture index
 * contains a test-file reference to that symbol.
 */
import { testSubject } from '../src/utils.js';

// Minimal test-style reference
const result = testSubject();
void result;
