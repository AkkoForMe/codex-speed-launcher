import { spawnSync } from 'node:child_process';
import { isSea } from 'node:sea';
import * as vm from 'node:vm';

/** Parse a module without importing it or running any of its contents. */
export function assertModuleSyntax(source) {
  if (typeof source !== 'string') throw new TypeError('JavaScript source must be a string.');
  if (isSea()) {
    // A SEA's process.execPath is this launcher, not an ordinary Node CLI. The
    // executable's fixed execArgv enables the module parser explicitly.
    if (typeof vm.SourceTextModule !== 'function') {
      throw new Error('The executable module parser is unavailable. Rebuild with its required VM flag.');
    }
    new vm.SourceTextModule(source);
    return;
  }
  const check = spawnSync(process.execPath, ['--check', '--input-type=module'], {
    input: source, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024, timeout: 15_000,
  });
  if (check.status !== 0) throw new SyntaxError('JavaScript module syntax validation failed.');
}
