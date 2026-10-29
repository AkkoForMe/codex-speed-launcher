import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { join } from 'node:path';
import { verifyBackend, validateMockConfig } from '../src/backend-verify.mjs';

const config = `model = "gpt-6.1-sol"
model_provider = "speed_mock"
service_tier = "default"
[features]
shell_tool = false
[model_providers.speed_mock]
base_url = "http://127.0.0.1:48111/v1"
wire_api = "responses"
requires_openai_auth = false
env_key = "CODEX_SPEED_MOCK_KEY"
`;
const env = { CODEX_SPEED_MOCK_KEY: 'local-verification-dummy-key' };
const app = { platform: 'win32', executable: 'C:\\WindowsApps\\Official\\app\\ChatGPT.exe' };
const codexHome = join(process.cwd(), 'test-only-home'), cwd = process.cwd();

function mockCore(options = {}) {
  const state = { kills: [], methods: [], requests: [], destroyed: false, capturedSpawn: null };
  const captures = [];
  const child = new EventEmitter(); child.pid = 4242; child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let dead = false, turnIndex = 0;
  const emit = message => {
    if (dead) return;
    const data = `${JSON.stringify(message)}\n`;
    if (options.fragmented) {
      child.stdout.write(data.slice(0, 13)); child.stdout.write(data.slice(13));
    } else child.stdout.write(data);
  };
  child.stdin = new Writable({ write(chunk, encoding, callback) {
    const message = JSON.parse(chunk.toString());
    state.requests.push(message);
    if (!message.method) { callback(); return; }
    state.methods.push(message.method);
    if (options.timeout === message.method) { callback(); return; }
    setImmediate(() => {
      if (dead || message.id == null) return;
      const result = value => emit({ jsonrpc: '2.0', id: message.id, result: value });
      if (message.method === 'initialize') result({ userAgent: 'MockCore/1.0' });
      else if (message.method === 'windowsSandbox/readiness') result({ status: options.readiness || 'ready' });
      else if (message.method === 'model/list') result({ data: [{ model: 'gpt-6.1-sol', id: 'gpt-6.1-sol',
        serviceTiers: options.noFast ? [] : [{ id: 'priority', name: 'Fast' }], additionalSpeedTiers: [] }] });
      else if (message.method === 'thread/start') result({ thread: { id: 'same-thread' } });
      else if (message.method === 'turn/start') {
        const number = ++turnIndex, turn = { id: `turn-${number}`, status: options.failedTurn === number ? 'failed' : 'completed' };
        if (options.exitTurn === number) { dead = true; child.emit('exit', 1); return; }
        const tier = options.dropFast && number === 2 ? null : message.params.serviceTier;
        const model = options.aliasModel ? 'gpt-6.1-sol-fast' : message.params.model;
        captures.push({ model, serviceTier: tier });
        if (options.extraCapture === number) captures.push({ model, serviceTier: tier });
        const notify = () => {
          if (options.approvalRequest) emit({ jsonrpc: '2.0', id: `approval-${number}`,
            method: 'item/commandExecution/requestApproval', params: {} });
          emit({ method: 'item/completed', params: { threadId: 'same-thread', turnId: turn.id,
            item: { type: 'agentMessage', text: options.wrongAnswer ? 'WRONG' : 'SPEED_TEST_OK' } } });
          emit({ method: 'turn/completed', params: { threadId: 'same-thread', turn } });
        };
        if (options.notificationBeforeReply) { notify(); result({ turn }); }
        else { result({ turn }); notify(); }
      }
    });
    callback();
  } });
  child.kill = signal => {
    state.kills.push(signal || 'default');
    if (!dead) { dead = true; child.emit('exit', 0); }
    return true;
  };
  child.unref = () => { state.destroyed = child.stdin.destroyed && child.stdout.destroyed && child.stderr.destroyed; };
  const io = {
    access: async () => {}, readFile: async () => config, sleep: async () => {},
    spawn: (file, args, options) => { state.capturedSpawn = { file, args, options }; return child; },
  };
  return { state, io, captures };
}

async function runMock(options = {}) {
  const fixture = mockCore(options);
  const report = await verifyBackend(app, { codexHome, cwd, env, captures: fixture.captures,
    system: fixture.io, timeoutMs: 100 });
  return { ...fixture, report };
}

test('Verifier only accepts the generated dummy provider on a numeric loopback port', () => {
  assert.equal(validateMockConfig(config, env).provider, 'speed_mock');
  for (const [source, variables] of [
    [config.replace('model_provider = "speed_mock"', 'model_provider = "openai"'), env],
    [config.replace('127.0.0.1:48111', 'api.example.com'), env],
    [config.replace('127.0.0.1:48111', '127.0.0.1'), env],
    [config.replace('requires_openai_auth = false', 'requires_openai_auth = true'), env],
    [config, { CODEX_SPEED_MOCK_KEY: 'real-or-arbitrary-key' }],
    [config.replace('CODEX_SPEED_MOCK_KEY', 'OPENAI_API_KEY'), env],
  ]) assert.throws(() => validateMockConfig(source, variables));
});

test('Backend verifier proves Standard → Fast → Standard using one model and thread', async () => {
  const { report, state } = await runMock({ fragmented: true });
  assert.equal(report.ok, true);
  assert.equal(report.backendVersion, 'MockCore/1.0');
  assert.equal(report.sandboxReadiness, 'ready');
  assert.equal(report.guiPreflightReady, true);
  assert.deepEqual(report.rows.map(row => row.capturedTier), [null, 'priority', null]);
  assert.equal(state.requests.filter(row => row.method === 'thread/start').length, 1);
  const turns = state.requests.filter(row => row.method === 'turn/start');
  assert.deepEqual(turns.map(row => row.params.threadId), ['same-thread', 'same-thread', 'same-thread']);
  assert.deepEqual(turns.map(row => row.params.model), ['gpt-6.1-sol', 'gpt-6.1-sol', 'gpt-6.1-sol']);
  assert.equal(report.coreStopped, true);
  assert.equal(state.destroyed, true);
  assert.equal(state.kills.length, 1);
});

test('Fast metadata absence stops before any inference request', async () => {
  const { report, state, captures } = await runMock({ noFast: true });
  assert.equal(report.ok, false);
  assert.match(report.error, /does not advertise Fast/);
  assert.equal(state.methods.includes('turn/start'), false);
  assert.equal(captures.length, 0);
  assert.equal(report.coreStopped, true);
});

test('A dropped Fast tier and aliased models fail the wire-level verification', async () => {
  let fixture = await runMock({ dropFast: true });
  assert.equal(fixture.report.ok, false);
  assert.equal(fixture.report.rows.length, 2);
  assert.equal(fixture.report.rows[1].capturedTier, null);
  fixture = await runMock({ aliasModel: true });
  assert.equal(fixture.report.ok, false);
  assert.equal(fixture.report.rows[0].sameModel, false);
});

test('Duplicate inference requests, failed turns and wrong answers fail verification', async () => {
  for (const options of [{ extraCapture: 1 }, { failedTurn: 1 }, { wrongAnswer: true }]) {
    const { report } = await runMock(options);
    assert.equal(report.ok, false);
    assert.equal(report.rows[0].ok, false);
    assert.equal(report.coreStopped, true);
  }
});

test('Completion arriving before the turn/start response is retained', async () => {
  const { report } = await runMock({ notificationBeforeReply: true });
  assert.equal(report.ok, true);
});

test('Server tool or approval requests are denied rather than approved', async () => {
  const { report, state } = await runMock({ approvalRequest: true });
  assert.equal(report.ok, true);
  assert.equal(report.deniedServerRequests, 3);
  const replies = state.requests.filter(message => message.error);
  assert.equal(replies.length, 3);
  assert.equal(replies.every(reply => reply.error.code === -32601), true);
});

test('RPC timeout and early core exit reject quickly and terminate only the diagnostic child', async () => {
  let fixture = await runMock({ timeout: 'initialize' });
  assert.equal(fixture.report.ok, false);
  assert.match(fixture.report.error, /timed out/);
  assert.equal(fixture.report.coreStopped, true);
  fixture = await runMock({ exitTurn: 1 });
  assert.equal(fixture.report.ok, false);
  assert.match(fixture.report.error, /exited/);
  assert.equal(fixture.report.coreStopped, true);
});

test('Core spawn uses only the bundled executable, isolated home and sanitized environment', async () => {
  const fixture = mockCore();
  await verifyBackend(app, { codexHome, cwd,
    env: { ...env, HTTPS_PROXY: 'https://bad-proxy', CODEX_AUTHAPI_BASE_URL: 'https://external',
      OPENAI_API_KEY: 'real-sensitive-key', NODE_OPTIONS: '--require unsafe', KEEP: 'present' },
    captures: fixture.captures, system: fixture.io });
  const { file, args, options } = fixture.state.capturedSpawn;
  assert.equal(file, 'C:\\WindowsApps\\Official\\app\\resources\\codex.exe');
  assert.deepEqual(args, ['app-server', '--stdio']);
  assert.equal(options.env.CODEX_HOME, codexHome);
  assert.equal(options.env.OPENAI_API_KEY, 'local-verification-dummy-key');
  assert.equal(options.env.HTTPS_PROXY, undefined);
  assert.equal(options.env.CODEX_AUTHAPI_BASE_URL, undefined);
  assert.equal(options.env.NODE_OPTIONS, undefined);
  assert.equal(options.env.KEEP, 'present');
});

test('Relative paths and missing captures are refused before spawn', async () => {
  const fixture = mockCore();
  await assert.rejects(verifyBackend(app, { codexHome: 'relative', cwd, env, captures: [], system: fixture.io }), /absolute/);
  await assert.rejects(verifyBackend(app, { codexHome, cwd, env, system: fixture.io }), /captures/);
  assert.equal(fixture.state.capturedSpawn, null);
});

test('macOS core is resolved inside the same signed app bundle', async () => {
  const fixture = mockCore();
  const report = await verifyBackend({ platform: 'darwin', root: '/Applications/ChatGPT.app' },
    { codexHome, cwd, env, captures: fixture.captures, system: fixture.io });
  assert.equal(report.ok, true);
  assert.equal(fixture.state.capturedSpawn.file, '/Applications/ChatGPT.app/Contents/Resources/codex');
});

test('An already aborted backend verification never spawns or reads a config', async () => {
  const fixture = mockCore(), controller = new AbortController();
  let reads = 0;
  fixture.io.readFile = async () => { reads++; return config; };
  controller.abort(new Error('cancel before backend spawn'));
  await assert.rejects(verifyBackend(app, { codexHome, cwd, env, captures: fixture.captures,
    system: fixture.io, signal: controller.signal }), /cancel before backend spawn/);
  assert.equal(reads, 0);
  assert.equal(fixture.state.capturedSpawn, null);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('Aborting an active RPC ends only the diagnostic core and removes its listener', async () => {
  const fixture = mockCore({ timeout: 'initialize' }), controller = new AbortController();
  const originalSpawn = fixture.io.spawn;
  fixture.io.spawn = (...args) => {
    const child = originalSpawn(...args);
    queueMicrotask(() => controller.abort(new Error('cancel active backend')));
    return child;
  };
  await assert.rejects(verifyBackend(app, { codexHome, cwd, env, captures: fixture.captures,
    system: fixture.io, signal: controller.signal }), /cancel active backend/);
  assert.equal(fixture.state.kills.length, 1);
  assert.equal(fixture.state.destroyed, true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('Normal backend completion also removes a supplied abort listener', async () => {
  const fixture = mockCore(), controller = new AbortController();
  const report = await verifyBackend(app, { codexHome, cwd, env, captures: fixture.captures,
    system: fixture.io, signal: controller.signal });
  assert.equal(report.ok, true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('Sandbox readiness is queried before inference and never invokes setup or approves tools', async () => {
  for (const status of ['ready', 'notConfigured', 'updateRequired']) {
    const { report, state } = await runMock({ readiness: status });
    assert.equal(report.ok, true); // Transport proof is independent of GUI eligibility.
    assert.equal(report.sandboxReadiness, status);
    assert.equal(report.guiPreflightReady, status === 'ready');
    const request = state.requests.find(row => row.method === 'windowsSandbox/readiness');
    assert.equal(Object.hasOwn(request, 'params'), false); // Protocol takes no parameters.
    assert.equal(state.methods.indexOf('windowsSandbox/readiness') < state.methods.indexOf('thread/start'), true);
    assert.equal(state.methods.some(method => /setupStart|setupCompleted/.test(method)), false);
  }
});

test('Unknown sandbox readiness fails conservatively before creating a thread', async () => {
  const { report, state } = await runMock({ readiness: 'unexpected' });
  assert.equal(report.ok, false);
  assert.match(report.error, /unknown Windows sandbox readiness/);
  assert.equal(state.methods.includes('thread/start'), false);
  assert.equal(report.coreStopped, true);
});
