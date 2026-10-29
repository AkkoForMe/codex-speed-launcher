#!/usr/bin/env node
// Portable, dependency-free release packager. Only the explicit source allowlist
// and an integrity-checked official Node.js runtime enter a distribution.
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { deflateRawSync, gunzipSync, inflateRawSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NODE_VERSION = '24.22.2';
const NODE_ORIGIN = `https://nodejs.org/dist/v${NODE_VERSION}`;
const TARGETS = {
  'win-x64': { file: `node-v${NODE_VERSION}-win-x64.zip`, hash: 'ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2', binary: 'node.exe', entry: 'node.exe', format: 'zip' },
  'darwin-arm64': { file: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`, hash: 'aa9549349e47dffaa42dcf95d6e06ade8c4bdafc980979883b88767670df385a', binary: 'node', entry: 'bin/node', format: 'tar.gz' },
  'darwin-x64': { file: `node-v${NODE_VERSION}-darwin-x64.tar.gz`, hash: 'd5e336d588c45be0c37dbd52cc29895593009ca4997a77a1fd02815131ed0e52', binary: 'node', entry: 'bin/node', format: 'tar.gz' },
};
const TOP_FILES = ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'package.json', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md'];
const WINDOWS_FILES = ['launch-windows.cmd', 'inspect-windows.cmd'];
const MACOS_FILES = ['launch-macos.command', 'inspect-macos.command'];
const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const normalized = (path) => path.split(sep).join('/');

export const runtimeTargets = Object.freeze(Object.fromEntries(Object.entries(TARGETS).map(([key, item]) => [key, Object.freeze({ ...item })])));

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
export function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function safeMember(name) {
  return typeof name === 'string' && name.length > 0 && !name.includes('\\') && !name.includes('\0')
    && !name.startsWith('/') && !/^[a-z]:/i.test(name) && name.split('/').every((part) => part && part !== '.' && part !== '..');
}

// A small ZIP32 writer also records Unix executable bits when packaging on
// Windows. Compress-Archive otherwise loses .command/node permissions on macOS.
export function makeZip(files) {
  if (files.length > 65535) throw new Error('Too many files for ZIP32.');
  const parts = [], central = [];
  let offset = 0;
  for (const item of files) {
    if (!safeMember(item.path)) throw new Error(`Unsafe ZIP member: ${item.path}`);
    const name = Buffer.from(item.path, 'utf8');
    const bytes = Buffer.from(item.bytes);
    const compressed = deflateRawSync(bytes, { level: 9 });
    if (bytes.length > 0xffffffff || compressed.length > 0xffffffff || offset > 0xffffffff || name.length > 65535) throw new Error('ZIP32 size exceeded.');
    const crc = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6); // UTF-8 names.
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(33, 12); // 1980-01-01; reproducible archive metadata.
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, compressed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE((3 << 8) | 20, 4); // Made on Unix, including on Windows.
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(33, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(bytes.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(((0o100000 | (item.mode ?? 0o644)) << 16) >>> 0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralBytes = Buffer.concat(central);
  if (offset > 0xffffffff || centralBytes.length > 0xffffffff) throw new Error('ZIP32 size exceeded.');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBytes, end]);
}

export function readZipMember(archive, wanted) {
  let end = -1;
  for (let pos = archive.length - 22; pos >= Math.max(0, archive.length - 22 - 65535); pos -= 1) {
    if (archive.readUInt32LE(pos) === 0x06054b50 && pos + 22 + archive.readUInt16LE(pos + 20) === archive.length) { end = pos; break; }
  }
  if (end < 0) throw new Error('Invalid ZIP end record.');
  const count = archive.readUInt16LE(end + 10);
  let position = archive.readUInt32LE(end + 16);
  for (let index = 0; index < count; index += 1) {
    if (position + 46 > end || archive.readUInt32LE(position) !== 0x02014b50) throw new Error('Invalid ZIP directory.');
    const method = archive.readUInt16LE(position + 10), flags = archive.readUInt16LE(position + 8);
    const compressedSize = archive.readUInt32LE(position + 20), size = archive.readUInt32LE(position + 24);
    const nameLength = archive.readUInt16LE(position + 28), extraLength = archive.readUInt16LE(position + 30), commentLength = archive.readUInt16LE(position + 32);
    const name = archive.subarray(position + 46, position + 46 + nameLength).toString('utf8');
    if (name === wanted) {
      const localOffset = archive.readUInt32LE(position + 42);
      if (flags & 1 || localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Unsupported ZIP member.');
      const start = localOffset + 30 + archive.readUInt16LE(localOffset + 26) + archive.readUInt16LE(localOffset + 28);
      if (start + compressedSize > archive.length || size > MAX_DOWNLOAD_BYTES) throw new Error('ZIP member exceeds limits.');
      const data = archive.subarray(start, start + compressedSize);
      const bytes = method === 0 ? Buffer.from(data) : method === 8 ? inflateRawSync(data, { maxOutputLength: MAX_DOWNLOAD_BYTES }) : null;
      if (!bytes || bytes.length !== size || crc32(bytes) !== archive.readUInt32LE(position + 16)) throw new Error('ZIP member integrity check failed.');
      return bytes;
    }
    position += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`ZIP member missing: ${wanted}`);
}

export function readTarMember(archive, wanted) {
  const data = gunzipSync(archive, { maxOutputLength: 512 * 1024 * 1024 });
  for (let position = 0; position + 512 <= data.length;) {
    const header = data.subarray(position, position + 512);
    if (header.every((byte) => byte === 0)) break;
    const namePart = header.subarray(0, 100).toString('utf8').split('\0')[0];
    const prefix = header.subarray(345, 500).toString('utf8').split('\0')[0];
    const name = prefix ? `${prefix}/${namePart}` : namePart;
    const size = Number.parseInt(header.subarray(124, 136).toString('ascii').replace(/\0/g, '').trim(), 8);
    if (!Number.isSafeInteger(size) || size < 0 || position + 512 + size > data.length) throw new Error('Invalid TAR size.');
    if (name === wanted) {
      if (![0, 48].includes(header[156])) throw new Error('Requested TAR member is not a regular file.');
      return Buffer.from(data.subarray(position + 512, position + 512 + size));
    }
    position += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`TAR member missing: ${wanted}`);
}

async function listFiles(directory, extensions, sourceRoot = ROOT) {
  const full = resolve(sourceRoot, directory), out = [];
  if (!(await lstat(full)).isDirectory()) throw new Error(`Expected regular source directory: ${full}`);
  for (const entry of await readdir(full, { withFileTypes: true })) {
    const path = join(full, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symlinks are not packaged: ${path}`);
    if (entry.isDirectory()) out.push(...await listFiles(relative(sourceRoot, path), extensions, sourceRoot));
    else if (entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension))) out.push(normalized(relative(sourceRoot, path)));
  }
  return out;
}

export async function collectSourceFiles(target, sourceRoot = ROOT) {
  sourceRoot = resolve(sourceRoot);
  if (target !== 'source' && !TARGETS[target]) throw new Error('Unsupported source target.');
  const source = target === 'source';
  const files = [...TOP_FILES, ...await listFiles('src', ['.mjs'], sourceRoot), ...await listFiles('docs', ['.md'], sourceRoot)];
  if (source || target.startsWith('win-')) files.push(...WINDOWS_FILES);
  if (source || target.startsWith('darwin-')) files.push(...MACOS_FILES);
  if (source) {
    files.push(...await listFiles('scripts', ['.mjs'], sourceRoot), ...await listFiles('test', ['.mjs'], sourceRoot));
    files.push('.gitignore', ...await listFiles('.github', ['.yml', '.yaml', '.md'], sourceRoot));
    try { await lstat(join(sourceRoot, 'AGENTS.md')); files.push('AGENTS.md'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!files.includes('src/cli.mjs')) throw new Error('Source is incomplete: src/cli.mjs is missing.');
  return Promise.all([...new Set(files)].sort().map(async (path) => {
    if (!safeMember(path)) throw new Error(`Unsafe source path: ${path}`);
    const info = await lstat(join(sourceRoot, path));
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Expected regular source file: ${path}`);
    return { path, bytes: await readFile(join(sourceRoot, path)), mode: path.endsWith('.command') ? 0o755 : 0o644 };
  }));
}

async function fileHash(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function getRuntime(target, cache) {
  const spec = TARGETS[target], archivePath = join(cache, spec.file);
  await mkdir(cache, { recursive: true });
  try {
    await lstat(archivePath);
    if (await fileHash(archivePath) !== spec.hash) throw new Error(`Cached runtime hash mismatch. Remove only this file and retry: ${archivePath}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const sums = await fetch(`${NODE_ORIGIN}/SHASUMS256.txt`, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
    if (!sums.ok) throw new Error(`Node.js checksum download failed: ${sums.status}`);
    const text = await sums.text();
    const entry = text.split(/\r?\n/).find((line) => line.trim().endsWith(`  ${spec.file}`));
    if (entry?.split(/\s+/)[0] !== spec.hash) throw new Error('Official runtime checksum differs from the pinned release checksum.');
    await writeFile(join(cache, 'SHASUMS256.txt'), text);
    const response = await fetch(`${NODE_ORIGIN}/${spec.file}`, { redirect: 'error', signal: AbortSignal.timeout(900_000) });
    if (!response.ok || !response.body) throw new Error(`Node.js runtime download failed: ${response.status}`);
    const partial = `${archivePath}.part-${process.pid}-${randomBytes(4).toString('hex')}`;
    const hash = createHash('sha256');
    let bytes = 0;
    try {
      await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, encoding, callback) {
        bytes += chunk.length;
        if (bytes > MAX_DOWNLOAD_BYTES) return callback(new Error('Runtime download exceeds size limit.'));
        hash.update(chunk); callback(null, chunk);
      } }), createWriteStream(partial, { flags: 'wx' }));
      if (hash.digest('hex') !== spec.hash) throw new Error('Downloaded runtime SHA-256 mismatch.');
      await rename(partial, archivePath);
    } catch (downloadError) { await rm(partial, { force: true }); throw downloadError; }
  }
  const archive = await readFile(archivePath);
  const base = `node-v${NODE_VERSION}-${target}`;
  const extract = spec.format === 'zip' ? readZipMember : readTarMember;
  return {
    files: [
      { path: `runtime/${spec.binary}`, bytes: extract(archive, `${base}/${spec.entry}`), mode: 0o755 },
      { path: 'runtime/LICENSE', bytes: extract(archive, `${base}/LICENSE`), mode: 0o644 },
    ],
    receipt: { version: NODE_VERSION, source: `${NODE_ORIGIN}/${spec.file}`, archiveSha256: spec.hash, checksums: `${NODE_ORIGIN}/SHASUMS256.txt` },
  };
}

export async function verifyDirectory(directory) {
  const root = await realpath(resolve(directory)), manifest = JSON.parse(await readFile(join(root, 'package-manifest.json'), 'utf8'));
  if (manifest.format !== 1 || !Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error('Invalid package manifest.');
  const seen = new Set();
  for (const item of manifest.files) {
    if (!safeMember(item.path) || seen.has(item.path) || !/^[0-9a-f]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.bytes)) throw new Error('Invalid manifest file entry.');
    seen.add(item.path);
    const path = resolve(root, item.path);
    if (!path.startsWith(`${root}${sep}`)) throw new Error('Manifest path leaves package directory.');
    const actual = await realpath(path);
    if (!actual.startsWith(`${root}${sep}`)) throw new Error('Manifest file resolves outside package directory.');
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== item.bytes || await fileHash(path) !== item.sha256) throw new Error(`Package file integrity failed: ${item.path}`);
  }
  return { ok: true, target: manifest.target, version: manifest.version, verifiedFiles: manifest.files.length };
}

async function main(args) {
  const options = { target: 'all', out: join(ROOT, 'dist'), cache: join(ROOT, '.cache', 'node'), source: false, sourceOnly: false, downloadOnly: false, force: false, plan: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help') {
      console.log('Usage: node scripts/package.mjs [--target all|win-x64|darwin-arm64|darwin-x64] [--source|--source-only] [--out DIR] [--cache DIR] [--force] [--plan]\n       node scripts/package.mjs --download-only [--target TARGET] [--cache DIR]\n       node scripts/package.mjs --verify-dir EXTRACTED_PACKAGE'); return;
    }
    if (arg === '--verify-dir') { if (!args[i + 1]) throw new Error('--verify-dir requires a directory.'); console.log(JSON.stringify(await verifyDirectory(args[++i]), null, 2)); return; }
    if (['--target', '--out', '--cache'].includes(arg)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${arg} requires a value.`);
      options[arg.slice(2)] = args[++i];
    } else if (arg === '--source') options.source = true;
    else if (arg === '--source-only') options.sourceOnly = true;
    else if (arg === '--download-only') options.downloadOnly = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--plan') options.plan = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.target !== 'all' && !TARGETS[options.target]) throw new Error('Unsupported target.');
  if (options.downloadOnly && (options.source || options.sourceOnly || options.plan)) throw new Error('--download-only cannot be combined with source or plan options.');
  const targets = options.sourceOnly ? ['source'] : [...(options.target === 'all' ? Object.keys(TARGETS) : [options.target]), ...(options.source ? ['source'] : [])];
  if (options.downloadOnly) {
    for (const target of targets) {
      const runtime = await getRuntime(target, resolve(options.cache));
      console.log(`Cached and verified ${target}: ${runtime.receipt.archiveSha256} (${runtime.files[0].bytes.length} executable bytes)`);
    }
    return;
  }
  const metadata = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/.test(metadata.version)) throw new Error('Invalid package version.');
  const out = resolve(options.out), cache = resolve(options.cache);
  const plans = [];
  for (const target of targets) {
    const files = await collectSourceFiles(target);
    const filename = `codex-speed-launcher-${metadata.version}-${target}.zip`;
    plans.push({ target, filename, sourceFiles: files.map((file) => file.path), runtime: target === 'source' ? null : { file: TARGETS[target].file, sha256: TARGETS[target].hash } });
    if (options.plan) continue;
    const destination = join(out, filename);
    try { await lstat(destination); if (!options.force) throw new Error(`Output exists; use --force to replace this release file: ${destination}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const runtime = target === 'source' ? { files: [], receipt: null } : await getRuntime(target, cache);
    const payload = [...files, ...runtime.files].sort((a, b) => a.path.localeCompare(b.path, 'en'));
    const manifest = {
      format: 1, name: 'codex-speed-launcher', version: metadata.version, target,
      runtime: runtime.receipt,
      files: payload.map((file) => ({ path: file.path, bytes: file.bytes.length, sha256: sha256(file.bytes), mode: file.mode.toString(8) })),
    };
    payload.push({ path: 'package-manifest.json', bytes: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), mode: 0o644 });
    const folder = filename.slice(0, -4);
    const bytes = makeZip(payload.map((file) => ({ ...file, path: `${folder}/${file.path}` })));
    await mkdir(out, { recursive: true });
    const partial = `${destination}.part-${process.pid}-${randomBytes(4).toString('hex')}`;
    try { await writeFile(partial, bytes, { flag: 'wx' }); await rename(partial, destination); }
    catch (error) { await rm(partial, { force: true }); throw error; }
    console.log(`${sha256(bytes)}  ${filename} (${payload.length} files, ${bytes.length} bytes)`);
  }
  if (options.plan) { console.log(JSON.stringify(plans, null, 2)); return; }
  const pattern = new RegExp(`^codex-speed-launcher-${metadata.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(?:win-x64|darwin-arm64|darwin-x64|source)\\.zip$`);
  const checksums = [];
  for (const name of (await readdir(out)).filter((name) => pattern.test(name)).sort()) checksums.push(`${await fileHash(join(out, name))}  ${name}`);
  await writeFile(join(out, 'SHA256SUMS.txt'), `${checksums.join('\n')}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(`Packaging failed: ${error.message}`); process.exitCode = 1; });
}
