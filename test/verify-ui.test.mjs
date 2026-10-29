import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { join } from 'node:path';
import { verifyNativeMenu } from '../src/verify-ui.mjs';

const directory = join(process.cwd(), 'test-ui-artifact');
const codexHome = join(directory, 'codex-home'), work = join(directory, 'workspace');
const config = `model_provider = "speed_mock"
[model_providers.speed_mock]
base_url = "http://127.0.0.1:48111/v1"
requires_openai_auth = false
env_key = "CODEX_SPEED_MOCK_KEY"
[desktop]
projectlessWorkspaceRoot = ${JSON.stringify(work)}
`;

function fixture({ dropFast = false, aliasModel = false, loseTranscript = false, duplicate = false,
  readinessDelay = 0, focusDelay = 0, closeMenuDelay = 0, auxiliary = false, unknown = false,
  wrongToken = false } = {}) {
  const captures = [], screenshots = [], commands = [], prompts = [];
  let checked = false, menu = false, input = '', markerCount = 0, focused = false;
  let readinessReads = 0, focusAttempts = 0, closing = 0;
  const runtime = { sessionId: 'isolated-page',
    async evaluate(source) {
      if (source.includes('function pageState(')) return { app: true, composerCount: 1, composerText: input,
        markerCount, stopping: false, modelLabel: '6.1 Sol', composerEditable: readinessReads++ >= readinessDelay,
        composerFocused: focused, menuOpen: menu || closing-- > 0,
        prompts: loseTranscript ? prompts.slice(-1) : [...prompts] };
      if (source.includes('function fastState(')) return menu ? { checked, disabled: false } : null;
      if (source.includes('function modelMenu(')) { menu = true; focused = false; return true; }
      if (source.includes('function focusComposer(')) { focused = !input && focusAttempts++ >= focusDelay; return focused; }
      if (source.includes('function sendComposer(')) {
        prompts.push(input.match(/CODEX_SPEED_UI_\w+/)[0]);
        if (auxiliary) captures.push({ model: 'gpt-6-luna', serviceTier: null,
          requestKind: 'auxiliary-title', diagnosticTokens: [] });
        const row = { model: aliasModel ? 'gpt-6.1-sol-fast' : 'gpt-6.1-sol',
          requestKind: unknown ? 'response' : 'user-turn',
          diagnosticTokens: [wrongToken ? 'CODEX_SPEED_UI_UNEXPECTED' : prompts.at(-1)],
          serviceTier: checked && !dropFast ? 'priority' : null };
        captures.push(row); if (duplicate) captures.push({ ...row });
        input = ''; markerCount++; return true;
      }
      if (source.includes('item.click()')) { checked = !checked; return true; }
      throw Error(`Unexpected evaluation: ${source.slice(0,80)}`);
    },
    cdp: { async send(method, params, sessionId) {
      commands.push({ method, params, sessionId });
      if (method === 'Input.insertText') {
        if (!focused || menu || closing > 0) throw Error('Input arrived before the native composer was focused.');
        input = params.text;
      }
      if (method === 'Input.dispatchKeyEvent') { if (menu) closing = closeMenuDelay; menu = false; }
      if (method === 'Page.captureScreenshot') return { data: Buffer.from('png-fixture').toString('base64') };
      return {};
    } },
  };
  const system = { readFile: async path => path.endsWith('auth.json')
    ? JSON.stringify({ OPENAI_API_KEY: 'local-verification-dummy-key' }) : config,
    writeFile: async (path, bytes) => screenshots.push({ path, bytes }), sleep: async () => {} };
  return { runtime, captures, screenshots, commands, system, prompts };
}

async function run(options) {
  const f = fixture(options);
  const report = await verifyNativeMenu(f.runtime, { captures: f.captures, directory, codexHome, work, system: f.system });
  return { ...f, report };
}

test('native UI verifier switches Standard / Fast / Standard and checks local wire captures', async () => {
  const { report, commands, screenshots, prompts } = await run();
  assert.equal(report.ok, true);
  assert.equal(report.sameThread, true);
  assert.equal(report.sameModel, true);
  assert.deepEqual(report.rows.map(row => row.capturedTier), [null, 'priority', null]);
  assert.deepEqual(report.rows.map(row => row.menuChecked), [false, true, false]);
  assert.equal(prompts.length, 3);
  assert.equal(commands.filter(command => command.method === 'Input.insertText').length, 3);
  assert.ok(commands.every(command => command.sessionId === 'isolated-page'));
  assert.equal(screenshots.length, 7);
});

test('native UI verifier rejects dropped tier, aliased model, duplicate request and replaced chat', async () => {
  for (const options of [{ dropFast: true }, { aliasModel: true }, { duplicate: true }, { loseTranscript: true },
    { unknown: true }, { wrongToken: true }, { auxiliary: true, aliasModel: true }]) {
    const { report } = await run(options);
    assert.equal(report.ok, false, JSON.stringify(options));
    assert.ok(report.error);
  }
});

test('known desktop title requests are reported separately while the same user model is verified', async () => {
  const { report, captures } = await run({ auxiliary: true });
  assert.equal(report.ok, true);
  assert.equal(report.sameModel, true);
  assert.equal(captures.length, 6);
  assert.equal(report.auxiliaryRequests.length, 3);
  assert.ok(report.auxiliaryRequests.every(request => request.model === 'gpt-6-luna'));
  assert.deepEqual(report.rows.map(row => row.requestCount), [1, 1, 1]);
  assert.deepEqual(report.rows.map(row => row.auxiliaryRequestCount), [1, 1, 1]);
  assert.ok(report.rows.every(row => row.diagnosticTokenMatches));
});

test('native verifier waits for an editable composer, dismissed menu and stable editor focus', async () => {
  const f = fixture({ readinessDelay: 3, focusDelay: 2, closeMenuDelay: 2 });
  let polls = 0;
  f.system.sleep = async () => { polls++; };
  const report = await verifyNativeMenu(f.runtime, { captures: f.captures, directory,
    codexHome, work, system: f.system });
  assert.equal(report.ok, true);
  assert.equal(f.prompts.length, 3);
  assert.ok(polls >= 8);
});

test('every screenshot waits for the compositor and rechecks the expected visible menu state', async () => {
  const f = fixture(), controller = new AbortController();
  const delays = [];
  let settleCount = 0, menuReadsAfterSettle = 0, screenshotCount = 0;
  const evaluate = f.runtime.evaluate, send = f.runtime.cdp.send;
  f.system.sleep = async (ms, value, options) => {
    delays.push(ms);
    assert.equal(options.signal, controller.signal);
    if (ms === 200) settleCount++;
  };
  f.runtime.evaluate = async source => {
    if (source.includes('function fastState(') && settleCount > screenshotCount) menuReadsAfterSettle++;
    return evaluate(source);
  };
  f.runtime.cdp.send = async (...args) => {
    if (args[0] === 'Page.captureScreenshot') {
      assert.equal(delays.at(-1), 200);
      assert.equal(settleCount, ++screenshotCount);
    }
    return send(...args);
  };
  const report = await verifyNativeMenu(f.runtime, { captures: f.captures, directory,
    system: f.system, signal: controller.signal });
  assert.equal(report.ok, true);
  assert.equal(settleCount, 7);
  assert.equal(menuReadsAfterSettle, 3);
});

test('a menu that disappears during compositor settling fails before capturing it or sending a prompt', async () => {
  const f = fixture();
  let hideMenu = false;
  const evaluate = f.runtime.evaluate;
  f.system.sleep = async ms => {
    if (ms === 200 && f.screenshots.length === 1) hideMenu = true;
  };
  f.runtime.evaluate = async source => hideMenu && source.includes('function fastState(') ? null : evaluate(source);
  const report = await verifyNativeMenu(f.runtime, { captures: f.captures, directory, system: f.system });
  assert.equal(report.ok, false);
  assert.match(report.error, /rendered native Fast menu changed/);
  assert.equal(report.screenshots.includes('native-ui-menu-standard_1.png'), false);
  assert.equal(f.captures.length, 0);
});

test('aborting the compositor wait creates no screenshot and sends no prompt', async () => {
  const f = fixture(), controller = new AbortController();
  f.system.sleep = async ms => {
    if (ms === 200) controller.abort(new Error('cancel native screenshot settling'));
  };
  await assert.rejects(verifyNativeMenu(f.runtime, { captures: f.captures, directory,
    system: f.system, signal: controller.signal }), /cancel native screenshot settling/);
  assert.equal(f.commands.some(command => command.method === 'Page.captureScreenshot'), false);
  assert.equal(f.screenshots.length, 0);
  assert.equal(f.captures.length, 0);
});

test('dummy configuration and workspace checks run before any UI action', async () => {
  for (const content of [
    config.replace('model_provider = "speed_mock"', 'model_provider = "openai"'),
    config.replace('127.0.0.1:48111', 'external.example.com:443'),
    config.replace('requires_openai_auth = false', 'requires_openai_auth = true'),
    config.replace(JSON.stringify(work), JSON.stringify(join(directory, 'different-workspace'))),
  ]) {
    const f = fixture();
    f.system.readFile = async path => path.endsWith('auth.json')
      ? JSON.stringify({ OPENAI_API_KEY: 'local-verification-dummy-key' }) : content;
    await assert.rejects(verifyNativeMenu(f.runtime, { captures: f.captures, directory, codexHome, work, system: f.system }));
    assert.equal(f.commands.length, 0);
  }
  const f = fixture();
  f.system.readFile = async path => path.endsWith('auth.json') ? JSON.stringify({ OPENAI_API_KEY: 'arbitrary-key' }) : config;
  await assert.rejects(verifyNativeMenu(f.runtime, { captures: f.captures, directory, system: f.system }), /dummy auth/);
  assert.equal(f.commands.length, 0);
});

test('missing captures and paths outside the artifact directory are refused before reading or UI actions', async () => {
  const f = fixture();
  let reads = 0;
  f.system.readFile = async () => { reads++; return config; };
  const options = { captures: f.captures, directory, codexHome, work, system: f.system };
  for (const invalid of [
    { captures: undefined }, { directory: 'relative' }, { codexHome: directory },
    { codexHome: join(directory, '..', 'outside-home') },
    { work: join(directory, '..', 'outside-workspace') },
  ]) await assert.rejects(verifyNativeMenu(f.runtime, { ...options, ...invalid }), /captures|absolute/);
  assert.equal(reads, 0);
  assert.equal(f.commands.length, 0);
});

test('an already aborted UI verification performs no reads or renderer operations', async () => {
  const f = fixture(), controller = new AbortController();
  let reads = 0;
  f.system.readFile = async () => { reads++; return config; };
  controller.abort(new Error('cancel before native UI'));
  await assert.rejects(verifyNativeMenu(f.runtime, { captures: f.captures, directory,
    system: f.system, signal: controller.signal }), /cancel before native UI/);
  assert.equal(reads, 0);
  assert.equal(f.commands.length, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('aborting while loading the generated profile stops before the next read or UI action', async () => {
  const f = fixture(), controller = new AbortController();
  let reads = 0;
  f.system.readFile = async () => {
    reads++;
    controller.abort(new Error('cancel native profile load'));
    return config;
  };
  await assert.rejects(verifyNativeMenu(f.runtime, { captures: f.captures, directory,
    system: f.system, signal: controller.signal }), /cancel native profile load/);
  assert.equal(reads, 1);
  assert.equal(f.commands.length, 0);
  assert.equal(f.screenshots.length, 0);
});

test('aborting a native readiness wait stops the loop and creates no failure screenshot', async () => {
  const f = fixture(), controller = new AbortController();
  const evaluate = f.runtime.evaluate;
  f.runtime.evaluate = async source => source.includes('function pageState(')
    ? { app: true, composerCount: 0 } : evaluate(source);
  f.system.sleep = async (ms, value, options) => {
    assert.equal(options.signal, controller.signal);
    controller.abort(new Error('cancel native readiness'));
  };
  await assert.rejects(verifyNativeMenu(f.runtime, { captures: f.captures, directory,
    system: f.system, signal: controller.signal }), /cancel native readiness/);
  assert.equal(f.commands.length, 2);
  assert.ok(f.commands.every(command => command.method === 'Input.dispatchKeyEvent'));
  assert.equal(f.captures.length, 0);
  assert.equal(f.screenshots.length, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('aborting immediately after native input prevents sending the diagnostic prompt', async () => {
  const f = fixture(), controller = new AbortController();
  const send = f.runtime.cdp.send;
  f.runtime.cdp.send = async (...args) => {
    const result = await send(...args);
    if (args[0] === 'Input.insertText') controller.abort(new Error('cancel before native send'));
    return result;
  };
  await assert.rejects(verifyNativeMenu(f.runtime, { captures: f.captures, directory,
    system: f.system, signal: controller.signal }), /cancel before native send/);
  assert.equal(f.commands.at(-1).method, 'Input.insertText');
  assert.equal(f.captures.length, 0);
  assert.equal(f.prompts.length, 0);
  assert.equal(f.screenshots.length, 2);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('successful native UI verification accepts an untriggered signal without retaining listeners', async () => {
  const f = fixture(), controller = new AbortController();
  const report = await verifyNativeMenu(f.runtime, { captures: f.captures, directory,
    system: f.system, signal: controller.signal });
  assert.equal(report.ok, true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
