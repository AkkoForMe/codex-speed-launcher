import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { collectSourceFiles, crc32, makeZip, readTarMember, readZipMember, verifyDirectory } from '../scripts/package.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'codex-speed-package-test-'));
  t.after(async () => {
    assert.ok(resolve(root).startsWith(`${resolve(tmpdir())}${sep}codex-speed-package-test-`));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function put(root, name, content = 'fixture') {
  const file = join(root, name);
  await mkdir(resolve(file, '..'), { recursive: true });
  await writeFile(file, content);
}

test('ZIP preserves UTF-8 paths, binary contents and macOS executable modes', () => {
  const payload = Buffer.from([0, 127, 128, 255]);
  const zip = makeZip([{ path: '启动器/launch-macos.command', bytes: payload, mode: 0o755 }]);
  assert.deepEqual(readZipMember(zip, '启动器/launch-macos.command'), payload);
  const directory = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(directory > 0);
  assert.equal(zip.readUInt16LE(directory + 4) >>> 8, 3);
  assert.equal(zip.readUInt16LE(directory + 8) & 0x800, 0x800);
  assert.equal((zip.readUInt32LE(directory + 38) >>> 16) & 0o777, 0o755);
});

test('ZIP refuses absolute, traversing, empty and Windows-style member paths', () => {
  for (const path of ['../auth.json', '/tmp/file', 'C:/Users/file', 'a/../secret', 'a\\..\\secret', '', 'a//b', 'a/./b', 'a\0b']) {
    assert.throws(() => makeZip([{ path, bytes: Buffer.from('fixture') }]), /Unsafe ZIP member/);
  }
});

test('ZIP validates CRC and rejects a corrupted central-directory checksum', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  const zip = makeZip([{ path: 'file.txt', bytes: Buffer.from('checked data') }]);
  const directory = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  zip[directory + 16] ^= 1;
  assert.throws(() => readZipMember(zip, 'file.txt'), /integrity check failed/);
  assert.throws(() => readZipMember(Buffer.from('not a zip'), 'file.txt'), /Invalid ZIP/);
});

test('TAR.gz extracts only the requested regular-file member', () => {
  const payload = Buffer.from('portable runtime\0fixture');
  const header = Buffer.alloc(512);
  header.write('node-fixture/bin/node');
  header.write(`${payload.length.toString(8).padStart(11, '0')}\0`, 124);
  header[156] = 48;
  const make = () => gzipSync(Buffer.concat([header, payload, Buffer.alloc(512 - payload.length), Buffer.alloc(1024)]));
  assert.deepEqual(readTarMember(make(), 'node-fixture/bin/node'), payload);
  assert.throws(() => readTarMember(make(), 'missing'), /TAR member missing/);
  header[156] = 50; // A link is not accepted as the runtime executable.
  assert.throws(() => readTarMember(make(), 'node-fixture/bin/node'), /not a regular file/);
});

test('source allowlist excludes local configs, logs, caches and unrelated projects', async t => {
  const root = await fixture(t);
  const allowed = ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md', 'package.json', '.gitignore', '.gitattributes',
    '.github/workflows/ci.yml', '.github/ISSUE_TEMPLATE/bug_report.md', 'src/cli.mjs', 'docs/readme.md',
    'scripts/package.mjs', 'test/package.test.mjs', 'launch-windows.cmd', 'inspect-windows.cmd',
    'launch-macos.command', 'inspect-macos.command'];
  const forbidden = ['auth.json', 'config.toml', '.env', '.cache/node/node.exe', 'artifacts/report.md',
    'logs/session.log', 'data/local.sqlite', 'other-project/main.mjs', 'src/private.json', 'docs/secret.env', 'runtime/node.exe'];
  for (const file of [...allowed, ...forbidden]) await put(root, file);
  const source = (await collectSourceFiles('source', root)).map(item => item.path);
  assert.deepEqual(source, [...allowed].sort());
  const windows = (await collectSourceFiles('win-x64', root)).map(item => item.path);
  assert.ok(windows.includes('launch-windows.cmd'));
  assert.ok(!windows.includes('launch-macos.command'));
  assert.ok(!windows.includes('scripts/package.mjs'));
  for (const file of forbidden) assert.ok(!source.includes(file), `Excluded ${file}`);
});

test('source allowlist refuses linked directories instead of following them', async t => {
  const root = await fixture(t);
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'outside'), { recursive: true });
  await put(root, 'outside/auth.mjs');
  try { await symlink(join(root, 'outside'), join(root, 'src', 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Host cannot create a test directory link.'); return; }
    throw error;
  }
  await assert.rejects(collectSourceFiles('win-x64', root), /Symlinks are not packaged/);
});

test('manifest validates distributed files, then rejects tampering and escaping paths', async t => {
  const root = await fixture(t), payload = Buffer.from('distribution fixture');
  await put(root, 'src/cli.mjs', payload);
  const manifest = { format: 1, target: 'fixture', version: '0.1.0', files: [
    { path: 'src/cli.mjs', bytes: payload.length, sha256: createHash('sha256').update(payload).digest('hex') }
  ] };
  await put(root, 'package-manifest.json', JSON.stringify(manifest));
  assert.equal((await verifyDirectory(root)).verifiedFiles, 1);
  await put(root, 'src/cli.mjs', Buffer.from('tampered with same len'));
  await assert.rejects(verifyDirectory(root), /integrity failed/);
  manifest.files[0].path = '../outside';
  await put(root, 'package-manifest.json', JSON.stringify(manifest));
  await assert.rejects(verifyDirectory(root), /Invalid manifest file entry/);
  assert.ok((await readFile(join(root, 'package-manifest.json'), 'utf8')).includes('../outside'));
});

test('Windows wrappers run bundled Node from a folder with spaces and preserve quoted arguments and exit status', { skip: process.platform !== 'win32' }, async t => {
  const base = await fixture(t), root = join(base, 'shared package ! with spaces');
  await mkdir(join(root, 'runtime'), { recursive: true });
  try { await link(process.execPath, join(root, 'runtime', 'node.exe')); }
  catch (error) {
    if (error.code !== 'EXDEV') throw error;
    await copyFile(process.execPath, join(root, 'runtime', 'node.exe'));
  }
  await put(root, 'src/cli.mjs', 'console.log("WRAPPER_FIXTURE="+JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));process.exitCode=7;');
  for (const [file, command] of [['launch-windows.cmd', 'launch'], ['inspect-windows.cmd', 'inspect']]) {
    await put(root, file, await readFile(new URL(`../${file}`, import.meta.url)));
    const output = await new Promise((done, reject) => {
      const path = join(root, file), app = 'C:\\example apps\\Codex.app';
      const child = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'),
        ['/d', '/s', '/c', `""${path}" --app "${app}" --json"`], {
          cwd: base, windowsHide: true, windowsVerbatimArguments: true, stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, PATH: '' }, // Bundled Node must work without PATH.
        });
      let stdout = '', stderr = '';
      child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
      child.on('error', reject); child.on('exit', code => done({ code, stdout, stderr }));
      child.stdin.end('\r\n');
    });
    assert.equal(output.code, 7, output.stderr || output.stdout);
    const record = output.stdout.split(/\r?\n/).find(line => line.startsWith('WRAPPER_FIXTURE='));
    assert.ok(record, output.stdout);
    const actual = JSON.parse(record.slice('WRAPPER_FIXTURE='.length));
    assert.deepEqual(actual.args, [command, '--app', 'C:\\example apps\\Codex.app', '--json']);
    assert.equal(actual.cwd, root);
  }
});

test('macOS entry scripts are BOM-free LF shell files', async () => {
  for (const file of ['launch-macos.command', 'inspect-macos.command']) {
    const bytes = await readFile(new URL(`../${file}`, import.meta.url));
    assert.ok(bytes.toString('utf8').startsWith('#!/bin/bash\n'));
    assert.equal(bytes.includes(13), false);
    assert.ok(bytes.toString('utf8').includes('"$SPEED_NODE" "$SPEED_ROOT/src/cli.mjs"'));
  }
});
