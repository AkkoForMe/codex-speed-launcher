// Platform discovery and launch design informed by Veath/codexfast and
// Kiana-ZY/codexfast-windows (MIT, Copyright (c) 2026 Veath).
// This module never writes into an installed application or a user configuration.
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const WINDOWS_PUBLISHER = 'CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B';
const WINDOWS_PUBLISHER_ID = '2p2nqsd0c76g0';
const MAC_TEAM = '2DC432GLL2';
const PACKAGE_NAMES = ['OpenAI.Codex', 'OpenAI.CodexBeta'];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const defaultRun = (file, args, options = {}) => execFile(file, args, {
  encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
  windowsHide: true, ...options,
});

function system(overrides = {}) {
  return {
    run: defaultRun, spawn, kill: process.kill.bind(process),
    readFile: file => readFile(file, 'utf8'),
    exists: async file => { try { await access(file); return true; } catch { return false; } },
    sleep: delay, now: () => Date.now(), ...overrides,
  };
}

function pathsFor(platform) { return platform === 'win32' ? win32 : posix; }
function samePath(a, b, platform) {
  const paths = pathsFor(platform);
  const normalize = value => paths.resolve(value).replace(/[\\/]+$/, '');
  return platform === 'win32'
    ? normalize(a).toLowerCase() === normalize(b).toLowerCase()
    : normalize(a) === normalize(b);
}
function inside(root, file, platform) {
  const paths = pathsFor(platform);
  const relative = paths.relative(root, file);
  return relative !== '' && !relative.startsWith(`..${paths.sep}`)
    && relative !== '..' && !paths.isAbsolute(relative);
}
function jsonArray(source) {
  const parsed = JSON.parse(source.trim().replace(/^\uFEFF/, '') || '[]');
  return parsed == null ? [] : Array.isArray(parsed) ? parsed : [parsed];
}
function psPath(env = process.env) {
  return win32.join(env.SystemRoot || env.WINDIR || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}
async function powershell(source, io, env = process.env) {
  const prefix = "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);\n";
  try {
    return await io.run(psPath(env), ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text',
      '-EncodedCommand', Buffer.from(prefix + source, 'utf16le').toString('base64')], { env });
  } catch (error) {
    const detail = error.stderr?.trim() || (error.code ? String(error.code) : error.message);
    throw new Error(`Windows PowerShell command failed: ${detail.slice(0, 1500)}`, { cause: error });
  }
}

function decodeXml(value) {
  return value.replace(/&(?:quot|apos|amp|lt|gt);/g,
    entity => ({ '&quot;': '"', '&apos;': "'", '&amp;': '&', '&lt;': '<', '&gt;': '>' })[entity]);
}
function attributes(source) {
  return Object.fromEntries([...source.matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)]
    .map(match => [match[1], decodeXml(match[2] ?? match[3])]));
}

export function parseManifest(xml) {
  const source = xml.replace(/<!--[\s\S]*?-->/g, '');
  const identity = source.match(/<(?:[\w.-]+:)?Identity\b([^>]*)>/i);
  if (!identity) throw new Error('MSIX manifest has no Identity.');
  const applications = [...source.matchAll(/<(?:[\w.-]+:)?Application\b([^>]*)>/gi)]
    .map(match => attributes(match[1]));
  const application = applications.find(item => /(?:^|[\\/])(?:Codex|ChatGPT)\.exe$/i.test(item.Executable || ''));
  if (!application?.Id) throw new Error('MSIX manifest has no Codex desktop executable.');
  return { identity: attributes(identity[1]), application };
}

function versionCompare(a, b) {
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if ((left[i] || 0) !== (right[i] || 0)) return (right[i] || 0) - (left[i] || 0);
  }
  return 0;
}

async function discoverWindows({ appPath, io, env }) {
  const { stdout } = await powershell(`$packages = @(Get-AppxPackage | Where-Object { $_.Name -in @('OpenAI.Codex', 'OpenAI.CodexBeta') } | ForEach-Object {
  [pscustomobject]@{Name=$_.Name;Version=$_.Version.ToString();Publisher=$_.Publisher;InstallLocation=$_.InstallLocation;PackageFamilyName=$_.PackageFamilyName;PackageFullName=$_.PackageFullName}
}); [Console]::Out.Write((ConvertTo-Json -Compress -InputObject $packages))`, io, env);
  const packages = jsonArray(stdout).filter(item => PACKAGE_NAMES.includes(item.Name));
  packages.sort((a, b) => PACKAGE_NAMES.indexOf(a.Name) - PACKAGE_NAMES.indexOf(b.Name)
    || versionCompare(a.Version, b.Version));
  const selected = appPath
    ? packages.find(item => samePath(item.InstallLocation, appPath, 'win32'))
    : packages[0];
  if (!selected) throw new Error(appPath
    ? 'The requested Windows app is not registered to the current user.'
    : 'Codex Desktop was not found. Install the official Windows app for this user.');
  const root = win32.resolve(selected.InstallLocation);
  const family = `${selected.Name}_${WINDOWS_PUBLISHER_ID}`;
  if (!/^\d+(?:\.\d+){3}$/.test(selected.Version) || selected.Publisher !== WINDOWS_PUBLISHER || selected.PackageFamilyName !== family
    || !new RegExp(`^${selected.Name.replaceAll('.', '\\.')}_${selected.Version.replaceAll('.', '\\.')}_(?:x64|arm64|x86)__${WINDOWS_PUBLISHER_ID}$`).test(selected.PackageFullName)) {
    throw new Error('The registered Windows package identity is not an official Codex identity.');
  }
  const manifestPath = win32.join(root, 'AppxManifest.xml');
  const manifest = parseManifest(await io.readFile(manifestPath));
  if (manifest.identity.Name !== selected.Name || manifest.identity.Publisher !== WINDOWS_PUBLISHER
    || manifest.identity.Version !== selected.Version) {
    throw new Error('Registered Windows package and manifest identities disagree.');
  }
  const executable = win32.resolve(root, manifest.application.Executable);
  if (!inside(root, executable, 'win32')) throw new Error('MSIX executable escapes its package.');
  const asarPath = win32.join(win32.dirname(executable), 'resources', 'app.asar');
  const signaturePath = win32.join(root, 'AppxSignature.p7x');
  for (const path of [executable, asarPath, signaturePath]) {
    if (!await io.exists(path)) throw new Error(`Required Windows application file is missing: ${path}`);
  }
  return {
    platform: 'win32', root, executable, asarPath, manifestPath, signaturePath,
    version: selected.Version, packageFamilyName: family, packageFullName: selected.PackageFullName,
    aumid: `${family}!${manifest.application.Id}`, publisher: WINDOWS_PUBLISHER,
    supportsIsolation: true,
  };
}

async function discoverMac({ appPath, io, env, home }) {
  const candidates = appPath ? [appPath] : [
    '/Applications/Codex.app', '/Applications/ChatGPT.app',
    posix.join(home, 'Applications/Codex.app'), posix.join(home, 'Applications/ChatGPT.app'),
  ];
  let lastError;
  for (const candidate of candidates) {
    const root = posix.resolve(candidate), plistPath = posix.join(root, 'Contents/Info.plist');
    if (!await io.exists(plistPath)) continue;
    try {
      const { stdout } = await io.run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', plistPath], { env });
      const plist = JSON.parse(stdout);
      if (plist.CFBundleIdentifier !== 'com.openai.codex') {
        throw new Error('The macOS app is not the com.openai.codex bundle.');
      }
      if (!['Codex', 'ChatGPT'].includes(plist.CFBundleExecutable)) {
        throw new Error('The macOS bundle has an unexpected desktop executable.');
      }
      await io.run('/usr/bin/codesign', ['--verify', '--deep', '--strict', root], { env });
      const signature = await io.run('/usr/bin/codesign', ['-dv', '--verbose=4', root], { env });
      if (!new RegExp(`(?:^|\\n)TeamIdentifier=${MAC_TEAM}(?:\\r?\\n|$)`).test(`${signature.stdout}\n${signature.stderr || ''}`)) {
        throw new Error('The macOS app does not have the expected OpenAI signing team.');
      }
      const executable = posix.join(root, 'Contents/MacOS', plist.CFBundleExecutable);
      const asarPath = posix.join(root, 'Contents/Resources/app.asar');
      for (const path of [executable, asarPath]) {
        if (!await io.exists(path)) throw new Error(`Required macOS application file is missing: ${path}`);
      }
      return {
        platform: 'darwin', root, executable, asarPath, plistPath,
        version: String(plist.CFBundleShortVersionString || ''), build: String(plist.CFBundleVersion || ''),
        bundleId: plist.CFBundleIdentifier, teamId: MAC_TEAM,
        supportsIsolation: true, experimental: true,
      };
    } catch (error) {
      lastError = error;
      if (appPath) throw error;
    }
  }
  throw lastError || new Error('Codex Desktop was not found in /Applications or ~/Applications.');
}

/** Read-only discovery. `system` is an injectable adapter for regression tests. */
export async function discoverApp(options = {}) {
  const platform = options.platform || process.platform;
  const args = { ...options, io: system(options.system), env: options.env || process.env,
    home: options.home || homedir() };
  if (platform === 'win32') return discoverWindows(args);
  if (platform === 'darwin') return discoverMac(args);
  throw new Error(`Unsupported platform: ${platform}. Use Windows or macOS.`);
}

function normalizeWindowsProcess(record) {
  return {
    pid: Number(record.ProcessId ?? record.Pid),
    executable: String(record.ExecutablePath || ''),
    started: String(record.StartTimeUtc || record.CreationDate || ''),
    commandLine: String(record.CommandLine || ''),
  };
}

async function windowsProcesses(io, env, pid) {
  const filter = pid ? `ProcessId = ${pid}` : "Name = 'ChatGPT.exe' OR Name = 'Codex.exe'";
  const { stdout } = await powershell(`$rows = @(Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object {
  $start = ''; if ($null -ne $_.CreationDate) { $start = $_.CreationDate.ToUniversalTime().ToString('o', [Globalization.CultureInfo]::InvariantCulture) }
  [pscustomobject]@{ProcessId=$_.ProcessId;ExecutablePath=$_.ExecutablePath;StartTimeUtc=$start;CommandLine=$_.CommandLine}
}); [Console]::Out.Write((ConvertTo-Json -Compress -InputObject $rows))`, io, env);
  return jsonArray(stdout).map(normalizeWindowsProcess);
}

export async function listAppProcesses(app, options = {}) {
  const io = system(options.system), env = options.env || process.env;
  if (app.platform === 'win32') {
    const rows = await windowsProcesses(io, env);
    if (!options.allowUnreadable && rows.some(row => !row.executable)) {
      throw new Error('A Codex/ChatGPT process has an unreadable identity. Close it normally before launching.');
    }
    return rows.filter(row => !row.executable || inside(app.root, row.executable, app.platform));
  }
  if (app.platform === 'darwin') {
    const { stdout } = await io.run('/bin/ps', ['-ww', '-axo', 'pid=,lstart=,comm='], { env: { ...env, LC_ALL: 'C' } });
    const rows = [];
    for (const line of stdout.split('\n')) {
      const match = line.match(/^\s*(\d+)\s+(.{24})\s+(.+)$/);
      if (!match) continue;
      if (inside(app.root, match[3], 'darwin')) {
        rows.push({ pid: Number(match[1]), started: match[2], executable: match[3], commandLine: '' });
      }
    }
    return rows;
  }
  throw new Error(`Unsupported platform: ${app.platform}`);
}

export async function assertAppIdle(app, options = {}) {
  const running = await listAppProcesses(app, options);
  if (running.length) throw new Error('Codex Desktop is already running. Fully quit it, then start the speed launcher.');
}

export function buildLaunchArguments(port, isolatedDir) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid debugging port.');
  const args = [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'];
  if (isolatedDir) args.push(`--user-data-dir=${isolatedDir}`);
  return args;
}

/** In isolated mode the environment override is required: the app resets userData itself. */
export function childEnvironment({ env = process.env, isolatedDir, codexHome } = {}) {
  const result = { ...env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_EXTRA_LAUNCH_ARGS', 'NODE_OPTIONS',
    'CODEX_ELECTRON_AGENT_RUN_ID', 'CODEX_WINDOWS_REGISTERED_CORE']) delete result[key];
  if (codexHome) result.CODEX_HOME = codexHome;
  if (isolatedDir) result.CODEX_ELECTRON_USER_DATA_PATH = isolatedDir;
  return result;
}

export function sameProcessIdentity(a, b, platform = 'win32') {
  return Boolean(a && b && a.pid === b.pid && a.started && a.started === b.started
    && a.executable && b.executable && samePath(a.executable, b.executable, platform));
}

export function validateProcessOwnership(app, identity, { port, startedAt, completedAt, previousPids = [] }) {
  if (!identity || previousPids.includes(identity.pid)
    || !samePath(identity.executable || '.', app.executable, app.platform)) {
    throw new Error('The launched PID does not identify a new Codex process; it will not be terminated.');
  }
  const start = Date.parse(identity.started);
  if (!Number.isFinite(start) || start < startedAt - 1000 || start > completedAt + 1000) {
    throw new Error('The launched process start time does not match this launch.');
  }
  for (const flag of buildLaunchArguments(port)) {
    if (!identity.commandLine.split(/\s+/).some(word => word.replace(/^"|"$/g, '') === flag)) {
      throw new Error('The launched process is missing this launch\'s debugging flags.');
    }
  }
}

// COM layout follows the public IApplicationActivationManager interface. No key or
// user-controlled text is interpolated into PowerShell/C#; values travel in env vars.
const ACTIVATION_SOURCE = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace CodexSpeed {
  [ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IActivation {
    [PreserveSig] int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string id, [MarshalAs(UnmanagedType.LPWStr)] string arguments, uint options, out uint pid);
    [PreserveSig] int ActivateForFile([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr items, [MarshalAs(UnmanagedType.LPWStr)] string verb, out uint pid);
    [PreserveSig] int ActivateForProtocol([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr items, out uint pid);
  }
  [ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")] class ActivationManager {}
  public static class Launcher {
    public static uint Activate(string id, string arguments) {
      uint pid; int hr=((IActivation)new ActivationManager()).ActivateApplication(id, arguments, 0, out pid);
      Marshal.ThrowExceptionForHR(hr); return pid;
    }
  }
}
'@
[Console]::Out.WriteLine([CodexSpeed.Launcher]::Activate($env:CODEX_SPEED_AUMID, $env:CODEX_SPEED_ARGUMENTS))`;

async function activateWindows(app, args, io, env) {
  const { stdout } = await powershell(ACTIVATION_SOURCE, io,
    { ...env, CODEX_SPEED_AUMID: app.aumid, CODEX_SPEED_ARGUMENTS: args.join(' ') });
  const pid = Number(stdout.trim());
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('Windows activation did not return a process ID.');
  return pid;
}

async function stopWindows(identity, io, env) {
  // Recheck path, creation time and per-launch arguments immediately before tree
  // termination. Never kill by image name or accept a PID reused by another process.
  const { stdout } = await powershell(`
$expected = ConvertFrom-Json $env:CODEX_SPEED_PROCESS
$row = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$expected.pid)
if ($null -eq $row) { [Console]::Out.Write('exited'); exit 0 }
$start = $row.CreationDate.ToUniversalTime().ToString('o', [Globalization.CultureInfo]::InvariantCulture)
if ($row.ExecutablePath -ine $expected.executable -or $start -cne $expected.started -or $row.CommandLine -cne $expected.commandLine) {
  throw 'Process identity changed. Refusing to terminate a reused or unrelated PID.'
}
$process = Get-Process -Id ([int]$expected.pid)
$heldHandle = $process.Handle
& "$env:SystemRoot\\System32\\taskkill.exe" /PID ([int]$expected.pid) /T /F | Out-Null
if ($LASTEXITCODE -ne 0 -and -not $process.HasExited) { throw 'Failed to stop the owned Codex process.' }
[Console]::Out.Write('stopped')`, io, { ...env, CODEX_SPEED_PROCESS: JSON.stringify(identity) });
  if (!['exited', 'stopped'].includes(stdout.trim())) throw new Error('Unexpected process cleanup result.');
}

async function windowsHandle(app, pid, ownership, io, env, child) {
  const identity = (await windowsProcesses(io, env, pid))[0];
  validateProcessOwnership(app, identity, ownership);
  let exited = false;
  let exitPromise;
  return {
    pid, identity,
    waitForExit() {
      exitPromise ||= (async () => {
        while (!exited) {
          const current = (await windowsProcesses(io, env, pid))[0];
          if (!sameProcessIdentity(identity, current)) { exited = true; break; }
          await io.sleep(1000);
        }
        return child?.exitCode || 0;
      })();
      return exitPromise;
    },
    async stop() {
      if (exited) return;
      await stopWindows(identity, io, env);
      exited = true;
    },
  };
}

function directLaunch(app, args, io, env) {
  const child = io.spawn(app.executable, args, {
    // This is the interactive GUI process. SW_HIDE freezes its first-run
    // welcome animation; only command helpers should hide their windows.
    env, detached: app.platform === 'darwin', stdio: 'ignore', windowsHide: false,
  });
  // Subscribe immediately, including the interval before the spawn event.
  const exit = new Promise(resolve => {
    child.once('error', () => resolve(1));
    child.once('exit', code => resolve(code ?? 0));
  });
  const ready = new Promise((resolve, reject) => {
    child.once('spawn', resolve); child.once('error', reject);
  });
  return { child, exit, ready };
}

/** Only returns a handle after ownership has been established. */
export async function launchApp(app, options = {}) {
  const io = system(options.system), baseEnv = options.env || process.env;
  const paths = pathsFor(app.platform);
  const { isolatedDir, codexHome } = options;
  if (isolatedDir) {
    if (!paths.isAbsolute(isolatedDir) || !codexHome || !paths.isAbsolute(codexHome)) {
      throw new Error('Isolated launch requires absolute isolatedDir and codexHome paths.');
    }
    if (samePath(codexHome, baseEnv.CODEX_HOME || paths.join(homedir(), '.codex'), app.platform)) {
      throw new Error('Isolated launch must use a separate CODEX_HOME.');
    }
    if (baseEnv.CODEX_ELECTRON_USER_DATA_PATH
      && samePath(isolatedDir, baseEnv.CODEX_ELECTRON_USER_DATA_PATH, app.platform)) {
      throw new Error('Isolated launch must use a separate Electron user data directory.');
    }
  }
  const args = buildLaunchArguments(options.port, isolatedDir);
  const env = childEnvironment({ env: baseEnv, isolatedDir, codexHome });
  const previous = await listAppProcesses(app, { system: io, env: baseEnv, allowUnreadable: Boolean(isolatedDir) });
  if (!isolatedDir && previous.length) throw new Error('Codex Desktop is already running. Fully quit it before launching.');
  const startedAt = io.now();
  if (app.platform === 'win32' && !isolatedDir) {
    // Re-resolve registration immediately before activation; a Store update can
    // otherwise replace the inspected version between inspection and launch.
    const current = await discoverApp({ platform: 'win32', appPath: app.root, system: io, env: baseEnv });
    if (current.packageFullName !== app.packageFullName || current.executable !== app.executable) {
      throw new Error('The Windows package registration changed. Inspect it again.');
    }
    const pid = await activateWindows(app, args, io, env);
    return windowsHandle(app, pid, { port: options.port, startedAt, completedAt: io.now(),
      previousPids: previous.map(item => item.pid) }, io, env);
  }
  if (!['win32', 'darwin'].includes(app.platform)) throw new Error(`Unsupported platform: ${app.platform}`);
  const { child, exit, ready } = directLaunch(app, args, io, env);
  await ready;
  if (!child.pid || previous.some(item => item.pid === child.pid)) {
    throw new Error('Direct launch did not create a new owned process.');
  }
  if (app.platform === 'win32') {
    return windowsHandle(app, child.pid, { port: options.port, startedAt,
      completedAt: io.now(), previousPids: previous.map(item => item.pid) }, io, env, child);
  }
  let exited = false;
  exit.then(() => { exited = true; });
  return {
    pid: child.pid,
    waitForExit: () => exit,
    async stop() {
      if (exited) return;
      // A detached macOS child has a new process group. Use only the group of
      // this still-live child, rather than a process-name search.
      try { io.kill(-child.pid, 'SIGTERM'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; return; }
      await Promise.race([exit, io.sleep(4000)]);
      if (!exited) {
        try { io.kill(-child.pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    },
  };
}
