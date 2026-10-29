import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  discoverApp, parseManifest, listAppProcesses, assertAppIdle, launchApp,
  childEnvironment, buildLaunchArguments, validateProcessOwnership, sameProcessIdentity,
} from '../src/platform.mjs';

const root = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1023.6621.0_x64__2p2nqsd0c76g0';
const executable = `${root}\\app\\ChatGPT.exe`;
const publisher = 'CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B';
const registration = {
  Name: 'OpenAI.Codex', Version: '26.1023.6621.0', Publisher: publisher,
  InstallLocation: root, PackageFamilyName: 'OpenAI.Codex_2p2nqsd0c76g0',
  PackageFullName: 'OpenAI.Codex_26.1023.6621.0_x64__2p2nqsd0c76g0',
};
const manifest = `<Package><Identity Name="OpenAI.Codex" Version="26.1023.6621.0" Publisher="${publisher}"/>
  <Applications><Application Id="App" Executable="app/ChatGPT.exe" />
  <Application Id="Core" Executable="app/resources/codex-command-runner.exe"/></Applications></Package>`;
const now = Date.parse('2026-10-29T04:00:00Z');
const identity = {
  pid: 42, executable, started: '2026-10-29T04:00:00.0000000Z',
  commandLine: `"${executable}" --remote-debugging-port=48123 --remote-debugging-address=127.0.0.1`,
};
const psIdentity = row => ({ ProcessId: row.pid, ExecutablePath: row.executable,
  StartTimeUtc: row.started, CommandLine: row.commandLine });

function windowsSystem(overrides = {}) {
  const calls = [], state = { rows: [], owned: identity, ...overrides.state };
  const io = {
    now: () => now, sleep: async () => {}, exists: async () => true,
    readFile: async () => overrides.manifest || manifest,
    run: async (file, args, options) => {
      const source = Buffer.from(args.at(-1), 'base64').toString('utf16le');
      calls.push({ file, args, options, source });
      if (source.includes('ConvertFrom-Json $env:CODEX_SPEED_PROCESS')) {
        if (overrides.stopError) throw new Error(overrides.stopError);
        return { stdout: 'stopped' };
      }
      if (source.includes('Get-AppxPackage')) return { stdout: JSON.stringify(overrides.packages || [registration]) };
      if (source.includes('[CodexSpeed.Launcher]::Activate')) return { stdout: '42' };
      if (source.includes("Name = 'ChatGPT.exe'")) return { stdout: JSON.stringify(state.rows.map(psIdentity)) };
      if (source.includes('ProcessId = 42')) return { stdout: JSON.stringify(state.owned ? [psIdentity(state.owned)] : []) };
      throw new Error(`Unexpected command: ${source.slice(0, 200)}`);
    },
    ...overrides.io,
  };
  return { io, calls, state };
}

test('Windows discovery binds registered package, manifest, executable and signature', async () => {
  const { io, calls } = windowsSystem();
  const app = await discoverApp({ platform: 'win32', system: io });
  assert.equal(app.executable, executable);
  assert.equal(app.aumid, 'OpenAI.Codex_2p2nqsd0c76g0!App');
  assert.equal(app.version, registration.Version);
  assert.match(app.asarPath, /app\\resources\\app\.asar$/);
  assert.equal(app.supportsIsolation, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.includes('-EncodedCommand'), true);
});

test('Windows prefers Stable deterministically and selects an explicitly registered Beta', async () => {
  const beta = { ...registration, Name: 'OpenAI.CodexBeta',
    InstallLocation: root.replaceAll('OpenAI.Codex_', 'OpenAI.CodexBeta_'),
    PackageFamilyName: registration.PackageFamilyName.replace('Codex_', 'CodexBeta_'),
    PackageFullName: registration.PackageFullName.replace('Codex_', 'CodexBeta_') };
  const { io } = windowsSystem({ packages: [beta, registration] });
  assert.equal((await discoverApp({ platform: 'win32', system: io })).packageFamilyName, registration.PackageFamilyName);
  const betaSystem = windowsSystem({ packages: [beta, registration], manifest: manifest.replaceAll('OpenAI.Codex"', 'OpenAI.CodexBeta"') });
  assert.equal((await discoverApp({ platform: 'win32', appPath: beta.InstallLocation, system: betaSystem.io })).packageFamilyName,
    beta.PackageFamilyName);
});

test('Windows refuses unregistered overrides, wrong publisher and manifest drift', async () => {
  let env = windowsSystem();
  await assert.rejects(discoverApp({ platform: 'win32', appPath: 'D:\\untrusted', system: env.io }), /not registered/);
  env = windowsSystem({ packages: [{ ...registration, Publisher: 'someone else' }] });
  await assert.rejects(discoverApp({ platform: 'win32', system: env.io }), /official Codex identity/);
  env = windowsSystem({ manifest: manifest.replace('Version="26.1023.6621.0"', 'Version="1.0.0.0"') });
  await assert.rejects(discoverApp({ platform: 'win32', system: env.io }), /identities disagree/);
});

test('Windows rejects an escaped executable and a missing signature file', async () => {
  let env = windowsSystem({ manifest: manifest.replace('app/ChatGPT.exe', '../ChatGPT.exe') });
  await assert.rejects(discoverApp({ platform: 'win32', system: env.io }), /escapes/);
  env = windowsSystem({ io: { exists: async path => !path.endsWith('AppxSignature.p7x') } });
  await assert.rejects(discoverApp({ platform: 'win32', system: env.io }), /missing/);
});

test('Manifest parser supports single quotes, namespace prefixes and ignores comments', () => {
  const result = parseManifest(`<p:Package><!--<Identity Name='fake'/>--><p:Identity Name='OpenAI.Codex'/>
    <p:Application Id='App' Executable='app\\ChatGPT.exe'/></p:Package>`);
  assert.equal(result.identity.Name, 'OpenAI.Codex');
  assert.equal(result.application.Executable, 'app\\ChatGPT.exe');
  assert.throws(() => parseManifest('<Package/>'), /no Identity/);
});

function macSystem(overrides = {}) {
  const calls = [];
  const plist = { CFBundleIdentifier: 'com.openai.codex', CFBundleExecutable: 'ChatGPT',
    CFBundleShortVersionString: '26.1023.6621', CFBundleVersion: '9000', ...overrides.plist };
  return { calls, io: {
    exists: async path => path.startsWith('/Applications/ChatGPT.app/'),
    run: async (file, args) => {
      calls.push([file, args]);
      if (file.endsWith('plutil')) return { stdout: JSON.stringify(plist) };
      if (args[0] === '--verify') {
        if (overrides.signatureError) throw new Error('codesign verification failed');
        return { stdout: '' };
      }
      return { stdout: '', stderr: `Identifier=com.openai.codex\nTeamIdentifier=${overrides.team || '2DC432GLL2'}\n` };
    },
  } };
}

test('macOS discovery checks plist and official team without changing signatures', async () => {
  const { io, calls } = macSystem();
  const app = await discoverApp({ platform: 'darwin', system: io, home: '/Users/test' });
  assert.equal(app.executable, '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT');
  assert.equal(app.asarPath, '/Applications/ChatGPT.app/Contents/Resources/app.asar');
  assert.equal(app.experimental, true);
  assert.equal(calls.filter(([file]) => file.endsWith('codesign')).length, 2);
  assert.equal(calls.some(([, args]) => args.some(arg => ['--sign', '--force'].includes(arg))), false);
});

test('macOS refuses wrong app identity, signing team and changed signatures', async () => {
  for (const overrides of [
    { plist: { CFBundleIdentifier: 'com.openai.chat' } },
    { team: 'NOTOPENAI' }, { signatureError: true },
    { plist: { CFBundleExecutable: '../../arbitrary' } },
  ]) {
    const { io } = macSystem(overrides);
    await assert.rejects(discoverApp({ platform: 'darwin', appPath: '/Applications/ChatGPT.app', system: io }));
  }
});

test('Windows process detection excludes the CLI outside the app and fails closed on unreadable candidates', async () => {
  const { io, state } = windowsSystem({ state: { rows: [identity, { ...identity, pid: 55,
    executable: 'C:\\Users\\test\\.local\\bin\\codex.exe' }] } });
  const app = await discoverApp({ platform: 'win32', system: io });
  assert.deepEqual((await listAppProcesses(app, { system: io })).map(row => row.pid), [42]);
  await assert.rejects(assertAppIdle(app, { system: io }), /already running/);
  state.rows = [{ ...identity, executable: '' }];
  await assert.rejects(listAppProcesses(app, { system: io }), /unreadable identity/);
  assert.equal((await listAppProcesses(app, { system: io, allowUnreadable: true })).length, 1);
});

test('macOS process detection uses executable paths, including paths with spaces', async () => {
  const app = { platform: 'darwin', root: '/Applications/Codex Test.app' };
  const rows = await listAppProcesses(app, { system: { run: async () => ({ stdout:
    '  111 Thu Oct 29 12:00:00 2026 /Applications/Codex Test.app/Contents/MacOS/ChatGPT\n'
    + '  222 Thu Oct 29 12:00:00 2026 /usr/local/bin/codex\n' }) } });
  assert.deepEqual(rows.map(row => row.pid), [111]);
});

test('Isolated environment requires both profile variables and strips inherited injection flags', () => {
  const result = childEnvironment({ env: { CODEX_HOME: 'old', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--require unsafe',
    CODEX_WINDOWS_REGISTERED_CORE: 'old-core', PATH: 'path', KEEP: 'value' },
  isolatedDir: 'D:\\isolated\\electron', codexHome: 'D:\\isolated\\codex' });
  assert.equal(result.CODEX_HOME, 'D:\\isolated\\codex');
  assert.equal(result.CODEX_ELECTRON_USER_DATA_PATH, 'D:\\isolated\\electron');
  assert.equal(result.NODE_OPTIONS, undefined);
  assert.equal(result.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(result.CODEX_WINDOWS_REGISTERED_CORE, undefined);
  assert.equal(result.KEEP, 'value');
  assert.deepEqual(buildLaunchArguments(48123, 'path with spaces').slice(0, 2),
    ['--remote-debugging-port=48123', '--remote-debugging-address=127.0.0.1']);
  assert.throws(() => buildLaunchArguments(0), /Invalid/);
});

test('Ownership validation refuses reused PID, executable drift, stale creation time and missing unique flags', () => {
  const app = { platform: 'win32', executable };
  const ownership = { port: 48123, startedAt: now, completedAt: now + 50 };
  assert.doesNotThrow(() => validateProcessOwnership(app, identity, ownership));
  for (const [row, params] of [
    [identity, { ...ownership, previousPids: [42] }],
    [{ ...identity, executable: 'D:\\fake.exe' }, ownership],
    [{ ...identity, started: '2026-10-28T04:00:00Z' }, ownership],
    [{ ...identity, commandLine: '--remote-debugging-port=48124' }, ownership],
    [{ ...identity, started: '' }, ownership],
  ]) assert.throws(() => validateProcessOwnership(app, row, params));
  assert.equal(sameProcessIdentity(identity, { ...identity, started: 'different' }), false);
});

test('Normal Windows launch checks idle status, activates AUMID and only cleans up owned PID', async () => {
  const { io, calls, state } = windowsSystem();
  const app = await discoverApp({ platform: 'win32', system: io });
  const handle = await launchApp(app, { port: 48123, system: io });
  assert.equal(handle.pid, 42);
  const activation = calls.find(call => call.source.includes('[CodexSpeed.Launcher]::Activate'));
  assert.equal(activation.options.env.CODEX_SPEED_AUMID, app.aumid);
  await handle.stop();
  await handle.stop();
  const cleanups = calls.filter(call => call.source.includes('ConvertFrom-Json $env:CODEX_SPEED_PROCESS'));
  assert.equal(cleanups.length, 1);
  assert.equal(JSON.parse(cleanups[0].options.env.CODEX_SPEED_PROCESS).pid, 42);
  assert.match(cleanups[0].source, /ExecutablePath -ine/);
  assert.match(cleanups[0].source, /\$start -cne/);
  assert.match(cleanups[0].source, /CommandLine -cne/);
  state.owned = undefined;
  assert.equal(await handle.waitForExit(), 0);
});

test('Normal launch will not activate while the original app is running', async () => {
  const { io, calls } = windowsSystem({ state: { rows: [identity] } });
  const app = await discoverApp({ platform: 'win32', system: io });
  await assert.rejects(launchApp(app, { port: 48123, system: io }), /already running/);
  assert.equal(calls.some(call => call.source.includes('[CodexSpeed.Launcher]::Activate')), false);
});

test('Isolated Windows launch uses independent app data, codex home and a new child, even with existing main app', async () => {
  let spawnCall;
  const { io, calls } = windowsSystem({ state: { rows: [{ ...identity, pid: 7 }] }, io: {
    spawn: (file, args, options) => {
      spawnCall = { file, args, options };
      const child = new EventEmitter(); child.pid = 42;
      setImmediate(() => child.emit('spawn'));
      return child;
    },
  } });
  const app = await discoverApp({ platform: 'win32', system: io });
  const handle = await launchApp(app, { port: 48123, isolatedDir: 'D:\\test\\electron',
    codexHome: 'D:\\test\\codex', system: io });
  assert.equal(handle.pid, 42);
  assert.equal(spawnCall.options.env.CODEX_ELECTRON_USER_DATA_PATH, 'D:\\test\\electron');
  assert.equal(spawnCall.options.env.CODEX_HOME, 'D:\\test\\codex');
  assert.equal(spawnCall.args.includes('--user-data-dir=D:\\test\\electron'), true);
  assert.equal(calls.some(call => call.source.includes('[CodexSpeed.Launcher]::Activate')), false);
  await handle.stop();
});

test('Isolation refuses a missing codex home and reuse of the active home', async () => {
  const { io } = windowsSystem();
  const app = await discoverApp({ platform: 'win32', system: io });
  await assert.rejects(launchApp(app, { port: 48123, isolatedDir: 'D:\\test', system: io }), /requires absolute/);
  await assert.rejects(launchApp(app, { port: 48123, isolatedDir: 'D:\\test', codexHome: 'C:\\real',
    env: { CODEX_HOME: 'C:\\real' }, system: io }), /separate CODEX_HOME/);
});

test('Cleanup failure is reported instead of claiming the PID was stopped', async () => {
  const { io } = windowsSystem({ stopError: 'Process identity changed.' });
  const app = await discoverApp({ platform: 'win32', system: io });
  const handle = await launchApp(app, { port: 48123, system: io });
  await assert.rejects(handle.stop(), /identity changed/);
});

test('Waiting treats PID reuse as original exit without terminating the new process', async () => {
  const { io, state, calls } = windowsSystem();
  const app = await discoverApp({ platform: 'win32', system: io });
  const handle = await launchApp(app, { port: 48123, system: io });
  state.owned = { ...identity, started: '2026-10-29T05:00:00Z' };
  assert.equal(await handle.waitForExit(), 0);
  await handle.stop();
  assert.equal(calls.some(call => call.source.includes('ConvertFrom-Json $env:CODEX_SPEED_PROCESS')), false);
});

test('macOS owns a detached child group and cleans up only that group', async () => {
  let child, spawnOptions;
  const signals = [];
  const app = { platform: 'darwin', root: '/Applications/ChatGPT.app',
    executable: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT' };
  const io = {
    run: async () => ({ stdout: '' }),
    spawn: (file, args, options) => {
      spawnOptions = options;
      child = new EventEmitter(); child.pid = 1234;
      setImmediate(() => child.emit('spawn'));
      return child;
    },
    kill: (group, signal) => { signals.push([group, signal]); child.emit('exit', 0); },
    sleep: async () => {},
  };
  const handle = await launchApp(app, { port: 48123, system: io });
  assert.equal(spawnOptions.detached, true);
  await handle.stop();
  assert.deepEqual(signals, [[-1234, 'SIGTERM']]);
  assert.equal(await handle.waitForExit(), 0);
  await handle.stop();
  assert.equal(signals.length, 1);
});

test('macOS stops gracefully if the owned process exits during cleanup', async () => {
  const app = { platform: 'darwin', root: '/Applications/ChatGPT.app',
    executable: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT' };
  const handle = await launchApp(app, { port: 48123, system: {
    run: async () => ({ stdout: '' }), spawn: () => {
      const child = new EventEmitter(); child.pid = 1234;
      setImmediate(() => child.emit('spawn')); return child;
    }, kill: () => { const error = new Error('already exited'); error.code = 'ESRCH'; throw error; },
  } });
  await assert.doesNotReject(handle.stop());
});
