import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { win32 } from 'node:path';
import { promisify } from 'node:util';
import { configuredModel, createGuiController } from '../src/gui-controller.mjs';
import { showGuiFailure, startGuiBridge } from '../src/gui.mjs';
import { windowsGuiScript } from '../src/gui-window.mjs';

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function fixture(overrides = {}) {
  const records = { launch: 0, close: 0, stop: 0, cleanup: 0, sessions: [] };
  const system = {
    discover: async () => ({ version: '26.1106.6628.0', asarPath: 'fixture' }),
    inspect: () => ({ requiredIds: ['one'] }), processes: async () => [],
    readConfig: async () => 'model="gpt-6.1-sol"\n[model_providers.secret]\napi_key="sk-never-display"',
    sleep: () => new Promise(() => {}),
    launch: async () => {
      records.launch++;
      const exit = deferred(), lost = deferred();
      const session = { exit, lost,
        child: { waitForExit: () => exit.promise, stop: async () => { records.stop++; exit.resolve(0); } },
        runtime: { lost: lost.promise,
          closeApp: async () => { records.close++; exit.resolve(0); },
          close: () => { records.cleanup++; },
        },
      };
      records.sessions.push(session); return session;
    }, ...overrides,
  };
  return { controller: createGuiController({ system }), records };
}

test('GUI startup errors are shown as redacted data in a fixed hidden helper', async () => {
  const message = 'failed Bearer private-token sk-private-value; $(must-not-run)';
  let call;
  await showGuiFailure(new Error(message), { env: { SystemRoot: 'C:\\Windows' },
    run: async (file, args, options) => { call = { file, args, options }; } });
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.env.CODEX_SPEED_GUI_ERROR.includes('private-token'), false);
  assert.equal(call.options.env.CODEX_SPEED_GUI_ERROR.includes('sk-private-value'), false);
  const script = Buffer.from(call.args.at(-1), 'base64').toString('utf16le');
  assert.ok(script.includes('$env:CODEX_SPEED_GUI_ERROR'));
  assert.equal(script.includes('must-not-run'), false);
});

test('GUI displays only a safe root model, never provider secrets or a section override', () => {
  assert.equal(configuredModel('model = "gpt-6.1-sol" # chosen\n[providers.test]\nmodel="private"'), 'gpt-6.1-sol');
  assert.equal(configuredModel("model = 'gpt-6-astra'"), 'gpt-6-astra');
  for (const source of ['[providers.test]\nmodel="sk-secret"', 'model="bad\\nmodel"', 'model=6', 'model="<script>"']) {
    assert.equal(configuredModel(source), '未读取');
  }
});

test('opening and refreshing the GUI are read-only, and external app processes block start', async () => {
  const { controller, records } = fixture({ processes: async () => [{ pid: 123 }] });
  await controller.initialize();
  assert.equal(records.launch, 0);
  assert.equal(controller.snapshot().externalRunning, true);
  assert.equal(controller.snapshot().compatible, true);
  assert.match(controller.snapshot().status, /先退出/);
  assert.equal(JSON.stringify(controller.snapshot()).includes('sk-never-display'), false);
  await controller.dispatch('start');
  assert.equal(records.launch, 0);
  await controller.dispatch('refresh');
  await controller.dispatch('quit');
  assert.equal(controller.snapshot().closed, true);
  assert.equal(records.close, 0);
  assert.equal(records.stop, 0);
});

test('owned session restart closes the old app gracefully then starts a new session', async () => {
  const { controller, records } = fixture();
  await controller.initialize(); await controller.dispatch('start');
  assert.equal(controller.snapshot().managed, true);
  await controller.dispatch('restart');
  assert.equal(records.launch, 2);
  assert.equal(records.close, 1);
  assert.equal(records.stop, 0);
  assert.equal(controller.snapshot().phase, 'running');
  await controller.dispatch('quit');
  assert.equal(records.close, 2);
  assert.equal(records.stop, 0);
  assert.equal(controller.snapshot().closed, true);
});

test('start and restart refresh the model summary after an external configuration switch', async () => {
  let model = 'gpt-6.1-sol';
  const { controller } = fixture({ readConfig: async () => `model = "${model}"` });
  await controller.initialize();
  model = 'gpt-6-astra';
  await controller.dispatch('start');
  assert.equal(controller.snapshot().model, 'gpt-6-astra');
  model = 'gpt-6-luna';
  await controller.dispatch('restart');
  assert.equal(controller.snapshot().model, 'gpt-6-luna');
  await controller.dispatch('quit');
});

test('a normal restart never forces a Codex window that declines to quit', async () => {
  const { controller, records } = fixture({ sleep: async () => {} });
  await controller.initialize(); await controller.dispatch('start');
  records.sessions[0].runtime.closeApp = async () => {};
  await controller.dispatch('restart');
  assert.equal(records.launch, 1);
  assert.equal(records.stop, 0);
  assert.equal(controller.snapshot().managed, true);
  assert.match(controller.snapshot().detail, /尚未退出/);
  records.sessions[0].exit.resolve(0);
  await nextTurn();
  assert.equal(controller.snapshot().managed, false);
});

test('CDP disconnect during a deliberate quit waits for graceful process exit', async () => {
  const { controller, records } = fixture();
  await controller.initialize(); await controller.dispatch('start');
  const owned = records.sessions[0];
  owned.runtime.closeApp = async () => { owned.lost.resolve(new Error('CDP closed normally')); };
  const quit = controller.dispatch('quit');
  await nextTurn();
  assert.equal(records.stop, 0);
  owned.exit.resolve(0);
  await quit;
  await nextTurn();
  assert.equal(records.stop, 0);
  assert.equal(controller.snapshot().closed, true);
});

test('a delayed deliberate quit stays graceful even when CDP is lost before the UI timeout', async () => {
  const { controller, records } = fixture({ sleep: async () => {} });
  await controller.initialize(); await controller.dispatch('start');
  const owned = records.sessions[0];
  owned.runtime.closeApp = async () => { owned.lost.resolve(new Error('CDP closed normally')); };
  await controller.dispatch('restart');
  await nextTurn();
  assert.equal(records.stop, 0);
  assert.equal(records.launch, 1);
  assert.equal(controller.snapshot().managed, true);
  assert.match(controller.snapshot().detail, /尚未退出/);
  owned.exit.resolve(0); await nextTurn();
  assert.equal(controller.snapshot().managed, false);
  assert.equal(records.stop, 0);
});

test('runtime loss stops only the owned child and reports a redacted error', async () => {
  const { controller, records } = fixture();
  await controller.initialize(); await controller.dispatch('start');
  records.sessions[0].lost.resolve(new Error('lost Bearer abc123 sk-private-value'));
  await nextTurn();
  assert.equal(records.stop, 1);
  assert.equal(controller.snapshot().managed, false);
  assert.equal(controller.snapshot().phase, 'error');
  assert.equal(controller.snapshot().detail.includes('abc123'), false);
  assert.equal(controller.snapshot().detail.includes('sk-private-value'), false);
});

test('failed loss cleanup retains ownership so the user can retry a graceful quit', async () => {
  const { controller, records } = fixture();
  await controller.initialize(); await controller.dispatch('start');
  const owned = records.sessions[0];
  owned.child.stop = async () => { records.stop++; throw new Error('identity check unavailable'); };
  owned.lost.resolve(new Error('CDP disconnected')); await nextTurn();
  assert.equal(records.stop, 1);
  assert.equal(controller.snapshot().managed, true);
  assert.match(controller.snapshot().status, /尚未退出/);
  await controller.dispatch('quit');
  assert.equal(controller.snapshot().closed, true);
});

test('a failed process monitor takes the same owned cleanup path as runtime loss', async () => {
  let stops = 0;
  const { controller } = fixture({ launch: async () => ({
    child: { waitForExit: async () => { throw new Error('monitor unavailable'); }, stop: async () => { stops++; } },
    runtime: { lost: new Promise(() => {}), close() {} },
  }) });
  await controller.initialize(); await controller.dispatch('start');
  await nextTurn();
  assert.equal(stops, 1);
  assert.equal(controller.snapshot().managed, false);
  assert.match(controller.snapshot().detail, /monitor unavailable/);
});

test('window crash cleanup falls back to owned process cleanup if normal quit fails', async () => {
  const { controller, records } = fixture({ sleep: async () => {} });
  await controller.initialize(); await controller.dispatch('start');
  records.sessions[0].runtime.closeApp = async () => {};
  await assert.rejects(controller.dispose(), /尚未退出/);
  assert.equal(records.stop, 1);
  assert.ok(records.cleanup >= 1);
});

test('concurrent actions are refused while a launch is pending', async () => {
  const gate = deferred();
  const { controller } = fixture({ launch: () => gate.promise });
  await controller.initialize();
  const operation = controller.dispatch('start');
  assert.throws(() => controller.dispatch('restart'), /稍候/);
  gate.resolve({ child: { waitForExit: () => new Promise(() => {}) }, runtime: { lost: new Promise(() => {}), close() {} } });
  await operation;
  assert.equal(controller.snapshot().managed, true);
});

test('loopback bridge rejects missing credentials, browser origins, wrong methods and unknown actions', async t => {
  const { controller } = fixture(); await controller.initialize();
  const bridge = await startGuiBridge(controller); t.after(() => bridge.close());
  const headers = { Authorization: `Bearer ${bridge.token}` };
  assert.equal((await fetch(`${bridge.endpoint}/state`)).status, 403);
  assert.equal((await fetch(`${bridge.endpoint}/state`, { headers: { ...headers, Origin: 'http://evil.test' } })).status, 403);
  const wrongHost = await new Promise((resolve, reject) => {
    const request = http.get(`${bridge.endpoint}/state`, { headers: { ...headers, Host: 'evil.test' } }, response => {
      response.resume(); resolve(response.statusCode);
    });
    request.on('error', reject);
  });
  assert.equal(wrongHost, 403);
  assert.equal((await fetch(`${bridge.endpoint}/action`, { headers })).status, 404);
  assert.equal((await fetch(`${bridge.endpoint}/action`, { method: 'POST', headers, body: 'arbitrary-code' })).status, 409);
  const state = await (await fetch(`${bridge.endpoint}/state`, { headers })).json();
  assert.equal(state.model, 'gpt-6.1-sol');
  assert.equal((await fetch(`${bridge.endpoint}/action`, { method: 'POST', headers, body: 'refresh' })).status, 202);
});

test('WPF window uses native controls, no browser/network assets, and confirms owned restart and quit', () => {
  const script = windowsGuiScript();
  assert.ok(Buffer.byteLength(Buffer.from(script, 'utf16le').toString('base64')) < 30_000, 'EncodedCommand fits Windows command line');
  assert.ok(script.includes("$client.Proxy = $null"));
  assert.ok(script.includes("$env:CODEX_SPEED_GUI_TOKEN"));
  assert.ok(script.includes("Send-Action 'restart'"));
  assert.ok(script.includes('Standard / Fast'));
  assert.ok(script.includes('$eventArgs.Cancel = $true'));
  assert.equal(script.includes('WebBrowser'), false);
  assert.equal(script.includes('https://'), false);
});

test('Windows parses the PowerShell script and instantiates the WPF window without showing it', { skip: process.platform !== 'win32' }, async () => {
  const check = String.raw`$ErrorActionPreference='Stop'
$source = $env:CODEX_GUI_SOURCE
$tokens=$null; $errors=$null
$null=[System.Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
$markup=[regex]::Match($source,'(?s)<Window xmlns=.*?</Window>').Value
if (-not $markup) { throw 'Window markup missing' }
$window=[Windows.Markup.XamlReader]::Parse($markup)
if (-not $window.FindName('Primary') -or -not $window.FindName('Status')) { throw 'Required controls missing' }
$window.Close()
[Console]::Out.Write('WPF_OK')`;
  const file = win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const { stdout } = await promisify(execFile)(file, ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(check, 'utf16le').toString('base64')], {
    env: { ...process.env, CODEX_GUI_SOURCE: windowsGuiScript() }, windowsHide: true, timeout: 20_000,
  });
  assert.equal(stdout, 'WPF_OK');
});
