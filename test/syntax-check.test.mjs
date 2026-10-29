import assert from 'node:assert/strict';
import test from 'node:test';
import { assertModuleSyntax } from '../src/syntax-check.mjs';

test('module syntax checker accepts ESM including dynamic import without evaluating it', () => {
  assert.doesNotThrow(() => assertModuleSyntax('import x from "not-an-installed-package"; export { x }; await import("still-missing"); throw Error("must not execute");'));
});

test('module syntax checker rejects broken modules and non-string source', () => {
  assert.throws(() => assertModuleSyntax('export const incomplete = ;'), /syntax validation failed/);
  assert.throws(() => assertModuleSyntax(null), /must be a string/);
});
