import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { assertNoBuildPaths, buildToolSpecs, seaConfig, seaEntry, unsignedPeCopy, verifyToolArchive } from '../scripts/build-executable.mjs';

test('SEA configuration preserves strict ESM parsing and disables cross-build snapshots/caches', () => {
  const config = seaConfig('bundle.cjs', 'bundle.blob', { licenses: 'LICENSE' });
  assert.equal(config.useSnapshot, false);
  assert.equal(config.useCodeCache, false);
  assert.equal(config.execArgvExtension, 'none');
  assert.ok(config.execArgv.includes('--experimental-vm-modules'));
  assert.equal(config.main, 'bundle.cjs');
  assert.equal(config.output, 'bundle.blob');
  assert.equal(config.assets.licenses, 'LICENSE');
});

test('SEA paths cannot serialize absolute checkout paths or escape the work directory', () => {
  for (const path of ['C:\\maintainer\\bundle.cjs', '/home/maintainer/bundle.cjs', '../bundle.cjs', '\\\\host\\share\\bundle.cjs']) {
    assert.throws(() => seaConfig(path, 'bundle.blob', { licenses: 'LICENSE' }), /must be relative/);
  }
  assert.throws(() => seaConfig('bundle.cjs', 'bundle.blob', { licenses: 'C:/private/LICENSE' }), /must be relative/);
});

test('executable privacy scan rejects author paths in both separator forms and encodings', () => {
  const path = 'E:\\private-checkout\\launcher';
  assert.doesNotThrow(() => assertNoBuildPaths(Buffer.from('generic launcher.cjs'), [path]));
  assert.throws(() => assertNoBuildPaths(Buffer.from(path), [path]), /absolute build path/);
  assert.throws(() => assertNoBuildPaths(Buffer.from(path.replaceAll('\\', '/')), [path]), /absolute build path/);
  assert.throws(() => assertNoBuildPaths(Buffer.from(path, 'utf16le'), [path]), /absolute build path/);
});

test('SEA entry uses explicit CLI dispatch and carries an unevaluated module-check path', () => {
  const entry = seaEntry('C:/a folder/src/cli.mjs', 'C:/a folder/src/syntax-check.mjs');
  assert.ok(entry.includes('import { main } from "C:/a folder/src/cli.mjs";'));
  assert.ok(entry.includes("main(defaultLaunch ? ['launch'] : arguments_)"));
  assert.ok(entry.includes("getAsset('licenses', 'utf8')"));
  assert.ok(entry.includes("assertModuleSyntax(readFileSync(0, 'utf8'))"));
  assert.ok(entry.includes('process.stdin.isTTY && process.stdout.isTTY'));
});

test('build tools have fixed HTTPS registries and reject corrupted downloads', () => {
  const bytes = Buffer.from('fixture tool archive');
  const spec = { file: 'fixture.tgz', integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` };
  assert.equal(verifyToolArchive(bytes, spec), bytes);
  assert.throws(() => verifyToolArchive(Buffer.from('modified'), spec), /integrity failed/);
  for (const value of Object.values(buildToolSpecs)) {
    assert.ok(value.url.startsWith('https://registry.npmjs.org/'));
    assert.match(value.integrity, /^sha512-[A-Za-z0-9+/]+=*$/);
    assert.ok(!value.version.includes('latest'));
  }
});

test('Windows executable copy clears the Authenticode directory without mutating the input', () => {
  const source = Buffer.alloc(512);
  source.writeUInt16LE(0x5a4d, 0); source.writeUInt32LE(64, 0x3c);
  source.writeUInt32LE(0x4550, 64); source.writeUInt16LE(0x20b, 88);
  const security = 88 + 112 + 8 * 4;
  source.writeUInt32LE(480, security); source.writeUInt32LE(32, security + 4);
  const result = unsignedPeCopy(source);
  assert.equal(result.length, 480);
  assert.equal(result.readUInt32LE(security), 0);
  assert.equal(result.readUInt32LE(security + 4), 0);
  assert.equal(source.readUInt32LE(security), 480);
  assert.equal(source.length, 512);
  source.writeUInt32LE(1000, security);
  assert.throws(() => unsignedPeCopy(source), /Invalid PE certificate table/);
  assert.throws(() => unsignedPeCopy(Buffer.from('bad binary')), /not a DOS\/PE/);
});
