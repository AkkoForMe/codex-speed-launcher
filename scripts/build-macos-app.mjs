#!/usr/bin/env node
// Build on the matching macOS architecture using the system Swift compiler.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeZip, verifyDirectory } from './package.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const escapeXml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);

export function appInfoPlist(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Expected a stable numeric app version.');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>CodexSpeedLauncher</string>
<key>CFBundleIdentifier</key><string>io.github.akkoforme.codex-speed-launcher</string>
<key>CFBundleName</key><string>Codex Speed Launcher</string>
<key>CFBundleDisplayName</key><string>Codex Speed Launcher</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${escapeXml(version)}</string>
<key>CFBundleVersion</key><string>${escapeXml(version)}</string>
<key>LSMinimumSystemVersion</key><string>13.5</string>
<key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSSupportsAutomaticTermination</key><false/>
<key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>\n`;
}

export function appBuildTarget(arch, hostArch, hostPlatform) {
  if (hostPlatform !== 'darwin') throw new Error('Build the app on macOS, using its system Swift and signing tools.');
  if (!['arm64', 'x64'].includes(arch) || arch !== hostArch) throw new Error('Build on the matching macOS architecture.');
  return { packageTarget: `darwin-${arch}`, swiftTarget: `${arch === 'x64' ? 'x86_64' : 'arm64'}-apple-macos13.5` };
}

async function archiveFiles(directory, prefix) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name), name = `${prefix}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error('App bundles must not contain links.');
    if (entry.isDirectory()) files.push(...await archiveFiles(full, name));
    else if (entry.isFile()) files.push({ path: name, bytes: await readFile(full), mode: (await lstat(full)).mode & 0o777 });
    else throw new Error('Unexpected app bundle member.');
  }
  return files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

export async function buildMacApp({ packageDir, out = join(ROOT, 'dist'), work = join(ROOT, '.cache', 'macos-app'), arch = process.arch, force = false }) {
  const target = appBuildTarget(arch, process.arch, process.platform);
  const source = resolve(packageDir);
  const verified = await verifyDirectory(source);
  if (verified.target !== target.packageTarget) throw new Error('Portable package architecture differs from the build host.');
  const version = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')).version;
  if (version !== verified.version) throw new Error('Portable package version differs from source.');
  const filename = `codex-speed-launcher-${version}-${target.packageTarget}-app.zip`;
  const destination = join(resolve(out), filename);
  try { await lstat(destination); if (!force) throw new Error('App archive already exists; use --force to replace this release artifact.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(resolve(work), { recursive: true });
  const stage = await mkdtemp(join(resolve(work), 'bundle-'));
  const bundle = join(stage, 'Codex Speed Launcher.app');
  const contents = join(bundle, 'Contents'), resources = join(contents, 'Resources', 'launcher');
  const executable = join(contents, 'MacOS', 'CodexSpeedLauncher');
  await mkdir(dirname(executable), { recursive: true });
  await mkdir(resources, { recursive: true });
  const manifest = JSON.parse(await readFile(join(source, 'package-manifest.json'), 'utf8'));
  for (const item of manifest.files) {
    const destinationFile = join(resources, item.path);
    await mkdir(dirname(destinationFile), { recursive: true });
    await copyFile(join(source, item.path), destinationFile);
    await chmod(destinationFile, Number.parseInt(item.mode, 8));
  }
  await writeFile(join(contents, 'Info.plist'), appInfoPlist(version));
  const run = (program, args) => execFileSync(program, args, { stdio: 'inherit' });
  run('/usr/bin/xcrun', ['swiftc', '-swift-version', '5', '-O', '-target', target.swiftTarget,
    '-module-cache-path', join(stage, 'swift-module-cache'), '-framework', 'AppKit',
    join(ROOT, 'native', 'macos', 'Main.swift'), '-o', executable]);
  await chmod(executable, 0o755);
  // Ad-hoc signing provides bundle integrity. It is not Developer ID signing
  // or notarization, and does not bypass Gatekeeper download checks.
  run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', join(resources, 'runtime', 'node')]);
  manifest.distributionSigning = 'ad-hoc; not Developer ID signed or notarized';
  for (const item of manifest.files) {
    const bytes = await readFile(join(resources, item.path));
    item.bytes = bytes.length; item.sha256 = sha256(bytes);
  }
  await writeFile(join(resources, 'package-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', executable]);
  run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', bundle]);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  await verifyDirectory(resources);
  const bytes = makeZip(await archiveFiles(bundle, 'Codex Speed Launcher.app'));
  await mkdir(resolve(out), { recursive: true });
  await writeFile(destination, bytes, { flag: force ? 'w' : 'wx' });
  const receipt = { version, target: target.packageTarget, filename, bytes: bytes.length, sha256: sha256(bytes),
    bundle, executable, signing: 'ad-hoc', notarized: false, runtime: manifest.runtime };
  await writeFile(join(resolve(out), `${filename}.build.json`), `${JSON.stringify({ ...receipt, bundle: undefined, executable: undefined }, null, 2)}\n`);
  console.log(JSON.stringify(receipt, null, 2));
  return receipt;
}

async function main(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (name === '--help') { console.log('Build on macOS: node scripts/build-macos-app.mjs --package-dir DIR [--arch arm64|x64] [--out DIR] [--work DIR] [--force]'); return; }
    if (name === '--force') options.force = true;
    else if (['--package-dir', '--arch', '--out', '--work'].includes(name)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${name} requires a value.`);
      options[name === '--package-dir' ? 'packageDir' : name.slice(2)] = args[++i];
    } else throw new Error(`Unknown argument: ${name}`);
  }
  if (!options.packageDir) throw new Error('--package-dir is required.');
  await buildMacApp(options);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(`macOS app build failed: ${error.message}`); process.exitCode = 1; });
}
