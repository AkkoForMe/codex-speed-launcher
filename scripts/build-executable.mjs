#!/usr/bin/env node
// Build-only tooling. Users of the resulting executable need no Node.js/npm.
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTarMember, readZipMember, runtimeTargets } from './package.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const MAX_TOOL_ARCHIVE = 32 * 1024 * 1024;
const TOOL_SPECS = Object.freeze({
  esbuild: Object.freeze({
    version: '0.28.2', file: 'esbuild-win32-x64-0.28.2.tgz',
    url: 'https://registry.npmjs.org/@esbuild/win32-x64/-/win32-x64-0.28.2.tgz',
    integrity: 'sha512-5ebpxr3nWMzrL/rnUI755Jkuee0bHL/Gq0WTF9lvcpv73wAp5eu8MfBUgWK9bhWvZjj7yX8etf/8tI8Ney695g==',
  }),
  esbuildLicense: Object.freeze({
    version: '0.28.2', file: 'esbuild-0.28.2.tgz',
    url: 'https://registry.npmjs.org/esbuild/-/esbuild-0.28.2.tgz',
    integrity: 'sha512-HKVLS8dvII+xoKW9kmqxbRKrnWEXfJJr/FZhhJmiqIB0e053QNYFqOBouTMO/k5sID4MvCiUCvv8b9M4h32wIA==',
  }),
  postject: Object.freeze({
    version: '1.0.0-alpha.6', file: 'postject-1.0.0-alpha.6.tgz',
    url: 'https://registry.npmjs.org/postject/-/postject-1.0.0-alpha.6.tgz',
    integrity: 'sha512-b9Eb8h2eVqNE8edvKdwqkrY6O7kAwmI8kcnBv1NScolYJbo59XUF0noFq+lxbC1yN20bmC0WBEbDC5H/7ASb0A==',
  }),
});
const require = createRequire(import.meta.url);
const sha256 = data => createHash('sha256').update(data).digest('hex');

export const buildToolSpecs = TOOL_SPECS;

/** Remove only the copied PE's Authenticode table; injected bytes cannot retain it. */
export function unsignedPeCopy(source) {
  const bytes = Buffer.from(source);
  if (bytes.length < 64 || bytes.readUInt16LE(0) !== 0x5a4d) throw new Error('The runtime is not a DOS/PE executable.');
  const pe = bytes.readUInt32LE(0x3c), optional = pe + 24;
  if (pe < 64 || optional + 112 + 40 > bytes.length || bytes.readUInt32LE(pe) !== 0x4550
    || bytes.readUInt16LE(optional) !== 0x20b) throw new Error('The runtime is not an expected PE32+ executable.');
  const security = optional + 112 + 8 * 4;
  const offset = bytes.readUInt32LE(security), size = bytes.readUInt32LE(security + 4);
  if (!offset && !size) return bytes;
  if (!offset || !size || offset < security + 8 || offset + size > bytes.length) throw new Error('Invalid PE certificate table.');
  bytes.fill(0, security, security + 8);
  // The security-directory address is a raw file offset, not a virtual address.
  // Keep any unrelated trailing data if the certificate is not the last table.
  return offset + size === bytes.length ? bytes.subarray(0, offset) : bytes;
}

export function verifyToolArchive(bytes, spec) {
  const actual = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  if (actual !== spec.integrity) throw new Error(`Build tool integrity failed: ${spec.file}`);
  return bytes;
}

async function toolArchive(spec, cache) {
  const path = join(cache, spec.file);
  let bytes;
  try { bytes = await readFile(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const response = await fetch(spec.url, { redirect: 'error', signal: AbortSignal.timeout(90_000) });
    if (!response.ok || !response.body) throw new Error(`Build tool download failed: ${spec.file} (${response.status})`);
    const parts = [];
    let total = 0;
    for await (const part of response.body) {
      total += part.length;
      if (total > MAX_TOOL_ARCHIVE) throw new Error('Build tool download exceeds size limit.');
      parts.push(part);
    }
    bytes = Buffer.concat(parts);
    verifyToolArchive(bytes, spec);
    const pending = `${path}.part-${process.pid}-${randomBytes(4).toString('hex')}`;
    try { await writeFile(pending, bytes, { flag: 'wx' }); await rename(pending, path); }
    catch (writeError) { await rm(pending, { force: true }); throw writeError; }
  }
  return verifyToolArchive(bytes, spec);
}

/** The executable has fixed Node flags; command arguments always reach the CLI. */
export function seaConfig(main, output, assets) {
  for (const path of [main, output, ...Object.values(assets)]) {
    if (typeof path !== 'string' || !path || isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path)
      || path.startsWith('\\') || path.split(/[\\/]/).some(part => part === '..')) {
      throw new Error('SEA paths must be relative to the isolated build directory.');
    }
  }
  return {
    main, output, disableExperimentalSEAWarning: true,
    useSnapshot: false, useCodeCache: false,
    execArgv: ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning'],
    execArgvExtension: 'none', assets,
  };
}

/** Absolute author paths must not be serialized into the published payload. */
export function assertNoBuildPaths(bytes, paths) {
  const needles = new Set(paths.filter(Boolean).flatMap(path => [path, path.replaceAll('\\', '/'), path.replaceAll('/', '\\')]));
  for (const path of needles) {
    for (const encoding of ['utf8', 'utf16le']) {
      if (bytes.includes(Buffer.from(path, encoding))) throw new Error(`Executable contains an absolute build path (${encoding}).`);
    }
  }
}

/** CJS bundling replaces import.meta.url only to disable the source auto-run guard. */
export function seaEntry(entryPath, syntaxPath) {
  return `import { main } from ${JSON.stringify(entryPath)};
import { assertModuleSyntax } from ${JSON.stringify(syntaxPath)};
import { getAsset } from 'node:sea';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const arguments_ = process.argv.slice(2);
const defaultLaunch = arguments_.length === 0;
async function finish(code) {
  process.exitCode = code;
  if (defaultLaunch && process.stdin.isTTY && process.stdout.isTTY) {
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    await new Promise(resolve => terminal.question('Press Return to close this window. ', resolve));
    terminal.close();
  }
}
async function run() {
  if (arguments_[0] === '--licenses' && arguments_.length === 1) {
    console.log(getAsset('licenses', 'utf8')); return 0;
  }
  // Private build regression hook: parse stdin without linking/evaluating it.
  if (arguments_[0] === '--csl-check-module' && arguments_.length === 1) {
    assertModuleSyntax(readFileSync(0, 'utf8')); return 0;
  }
  return main(defaultLaunch ? ['launch'] : arguments_);
}
run().then(finish, error => {
  console.error('Codex Speed Launcher: ' + error.message);
  if (error instanceof AggregateError) for (const cause of error.errors) console.error('  ' + cause.message);
  return finish(1);
});
`;
}

function run(file, args, options = {}) {
  const result = spawnSync(file, args, {
    cwd: ROOT, windowsHide: true, encoding: 'utf8', timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024, ...options,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Build command failed: ${file}\n${result.error?.message || result.stderr || result.stdout || result.status}`);
  }
  return result;
}

async function nodeRuntime(nodeCache) {
  const spec = runtimeTargets['win-x64'], path = join(nodeCache, spec.file);
  let archive;
  try { archive = await readFile(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    run(process.execPath, [join(ROOT, 'scripts', 'package.mjs'), '--target', 'win-x64', '--download-only', '--cache', nodeCache], { timeout: 900_000 });
    archive = await readFile(path);
  }
  if (sha256(archive) !== spec.hash) throw new Error(`Node.js archive integrity failed: ${spec.file}`);
  const version = spec.file.match(/^node-v([0-9.]+)-win-x64\.zip$/)?.[1];
  if (!version) throw new Error('Unrecognized pinned Node.js archive name.');
  return {
    executable: readZipMember(archive, `node-v${version}-win-x64/node.exe`),
    license: readZipMember(archive, `node-v${version}-win-x64/LICENSE`),
    version, file: spec.file, archiveSha256: spec.hash,
  };
}

export async function buildExecutable({ out = join(ROOT, 'dist'), cache = join(ROOT, '.cache', 'executable-tools'), nodeCache = join(ROOT, '.cache', 'node'), force = false } = {}) {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('This build script currently requires Windows x64. macOS executable packaging is not implemented.');
  }
  out = resolve(out); cache = resolve(cache); nodeCache = resolve(nodeCache);
  const metadata = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(metadata.version)) throw new Error('Invalid launcher version.');
  const name = `codex-speed-launcher-${metadata.version}-windows-x64.exe`, destination = join(out, name);
  try { await lstat(destination); if (!force) throw new Error(`Output exists; use --force to replace: ${destination}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(cache, { recursive: true }); await mkdir(out, { recursive: true });
  const tools = Object.fromEntries(await Promise.all(Object.entries(TOOL_SPECS).map(async ([key, spec]) => [key, await toolArchive(spec, cache)])));
  const node = await nodeRuntime(nodeCache);
  const work = await mkdtemp(join(cache, 'sea-build-'));
  // Work directory is kept under .cache for auditing, and never enters release.
  const nodeExe = join(work, 'node.exe'), esbuildExe = join(work, 'esbuild.exe'), postjectModule = join(work, 'postject.cjs');
  await writeFile(nodeExe, node.executable);
  await writeFile(esbuildExe, readTarMember(tools.esbuild, 'package/esbuild.exe'));
  await writeFile(postjectModule, readTarMember(tools.postject, 'package/dist/api.js'));
  const actualNodeVersion = run(nodeExe, ['--version']).stdout.trim();
  if (actualNodeVersion !== `v${node.version}`) throw new Error('Pinned Node.js executable version differs from archive.');
  const actualEsbuildVersion = run(esbuildExe, ['--version']).stdout.trim();
  if (actualEsbuildVersion !== TOOL_SPECS.esbuild.version) throw new Error('Pinned esbuild executable version differs from archive.');
  const notices = await readFile(join(ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  const launcherLicense = await readFile(join(ROOT, 'LICENSE'), 'utf8');
  const esbuildLicense = readTarMember(tools.esbuildLicense, 'package/LICENSE.md').toString('utf8');
  const postjectLicense = readTarMember(tools.postject, 'package/LICENSE').toString('utf8');
  const licenses = `Codex Speed Launcher ${metadata.version}\n\n=== Launcher license ===\n${launcherLicense}\n=== Launcher notices ===\n${notices}\n=== Node.js ${node.version} and bundled components ===\n${node.license.toString('utf8')}\n=== esbuild ${TOOL_SPECS.esbuild.version} (build tool) ===\n${esbuildLicense}\n=== postject ${TOOL_SPECS.postject.version} (build tool) ===\n${postjectLicense}\n`;
  const licensePath = join(work, 'THIRD_PARTY_LICENSES.txt');
  await writeFile(licensePath, licenses);
  const entry = join(work, 'sea-entry.mjs'), bundle = join(work, 'launcher.cjs'), blob = join(work, 'launcher.blob');
  const entrySource = seaEntry(join(ROOT, 'src', 'cli.mjs'), join(ROOT, 'src', 'syntax-check.mjs'));
  await writeFile(entry, entrySource);
  run(esbuildExe, ['--sourcefile=sea-entry.mjs', '--bundle', '--platform=node', '--format=cjs', '--target=node24',
    `--outfile=${bundle}`, '--define:import.meta.url="codex-speed-sea:entry"', '--log-level=warning'], { input: entrySource });
  const configPath = join(work, 'sea-config.json');
  // Node serializes `main` verbatim into the SEA blob. Relative filenames keep
  // the maintainer's checkout, username and random work directory out of it.
  await writeFile(configPath, `${JSON.stringify(seaConfig('launcher.cjs', 'launcher.blob', { licenses: 'THIRD_PARTY_LICENSES.txt' }), null, 2)}\n`);
  run(nodeExe, ['--experimental-sea-config', 'sea-config.json'], { cwd: work });
  const pending = join(work, name);
  await writeFile(pending, unsignedPeCopy(node.executable));
  const { inject } = require(postjectModule);
  await inject(pending, 'NODE_SEA_BLOB', await readFile(blob), { sentinelFuse: SEA_FUSE });
  // Every generated executable checks its real parser, not just bundle syntax.
  if (run(pending, ['--version']).stdout.trim() !== metadata.version) throw new Error('Executable reports the wrong launcher version.');
  run(pending, ['--csl-check-module'], { input: 'import x from "missing"; export { x }; throw Error("must not execute");' });
  const invalid = spawnSync(pending, ['--csl-check-module'], { input: 'export const broken = ;', encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  if (invalid.status === 0 || invalid.error) throw new Error('Executable failed to reject invalid module syntax.');
  if (!run(pending, ['--licenses']).stdout.includes('Copyright (c) 2026 Veath')) throw new Error('Executable did not retain the required attribution.');
  const bytes = await readFile(pending);
  assertNoBuildPaths(bytes, [ROOT, work, process.env.USERPROFILE, process.env.HOME]);
  const receipt = {
    format: 1, name, version: metadata.version, platform: 'win32', architecture: 'x64',
    packaging: 'Node.js single executable application', signed: false,
    executableSha256: sha256(bytes), executableBytes: bytes.length,
    runtime: { version: node.version, archive: node.file, archiveSha256: node.archiveSha256 },
    buildTools: Object.fromEntries(Object.entries(TOOL_SPECS).map(([key, spec]) => [key, { ...spec }])),
    bundleSha256: sha256(await readFile(bundle)), licensesSha256: sha256(licenses),
  };
  // No install, code signing, system mutation, or Codex application bundling.
  const outputPending = `${destination}.part-${process.pid}-${randomBytes(4).toString('hex')}`;
  try { await writeFile(outputPending, bytes, { flag: 'wx' }); await rename(outputPending, destination); }
  catch (error) { await rm(outputPending, { force: true }); throw error; }
  await writeFile(join(out, 'THIRD_PARTY_LICENSES.txt'), licenses);
  await writeFile(join(out, `${name}.build.json`), `${JSON.stringify(receipt, null, 2)}\n`);
  await writeFile(join(out, `${name}.sha256`), `${receipt.executableSha256}  ${name}\n`);
  return { executable: destination, ...receipt, workDirectory: relative(ROOT, work) };
}

export async function main(args = process.argv.slice(2)) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--help') {
      console.log('Usage: node scripts/build-executable.mjs [--out DIR] [--cache DIR] [--node-cache DIR] [--force]\nBuilds a Windows x64 console executable with embedded licenses. Requires Windows x64; no global installation.'); return;
    }
    if (args[index] === '--force') { options.force = true; continue; }
    const key = { '--out': 'out', '--cache': 'cache', '--node-cache': 'nodeCache' }[args[index]];
    if (!key || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Unknown or incomplete argument: ${args[index]}`);
    options[key] = args[++index];
  }
  console.log(JSON.stringify(await buildExecutable(options), null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Executable build failed: ${error.message}`); process.exitCode = 1; });
}
