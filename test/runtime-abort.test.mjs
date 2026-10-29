import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startRuntime } from '../src/runtime.mjs';
import { sha256 } from '../src/asar.mjs';

const resource = {
  runtimePath: 'assets/speed-abort.js', archivePath: 'webview/assets/speed-abort.js',
  sourceHash: sha256('original'), patchedHash: sha256('patched'), content: 'patched', ids: ['speed'],
};
const plan = { requiredIds: ['speed'], resources: [resource] };

class AbortConnection extends EventEmitter {
  commands = [];
  closed = false;
  pending = new Map();
  constructor({ attachInitially = true } = {}) { super(); this.attachInitially = attachInitially; }
  attach(id, url = 'app://-/index.html', type = 'page') {
    this.emit('Target.attachedToTarget', { sessionId: id, targetInfo: { type, url }, waitingForDebugger: true });
  }
  async send(method, params = {}, session) {
    this.commands.push({ method, params, session });
    if (method === 'Target.setAutoAttach' && this.attachInitially) queueMicrotask(() => this.attach('primary'));
    if (method === 'Runtime.evaluate') {
      if (params.expression.startsWith('({url:')) return { result: { value: { url: 'app://-/index.html', ready: 'complete' } } };
      if (params.expression.startsWith('Promise.all')) {
        const requestId = `preload-${session}`;
        const fulfilled = new Promise(resolve => this.pending.set(requestId, resolve));
        this.emit('Fetch.requestPaused', { requestId, responseStatusCode: 200,
          request: { url: 'app://-/assets/speed-abort.js' } }, session);
        await fulfilled;
        return { result: { value: [200] } };
      }
    }
    if (method === 'Fetch.getResponseBody') return { body: 'original', base64Encoded: false };
    if (method === 'Fetch.fulfillRequest' || method === 'Fetch.failRequest') this.pending.get(params.requestId)?.();
    return {};
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const resolve of this.pending.values()) resolve();
    this.emit('disconnected', new Error('test connection closed'));
  }
}

test('An already cancelled startup never starts CDP work', async () => {
  const controller = new AbortController(), connection = new AbortConnection();
  controller.abort(new Error('cancel before launch'));
  await assert.rejects(startRuntime(50000, plan, { connection, signal: controller.signal }), /cancel before launch/);
  assert.equal(connection.commands.length, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('Cancellation while waiting for the first renderer closes the owned CDP connection promptly', async () => {
  const controller = new AbortController(), connection = new AbortConnection({ attachInitially: false });
  const runtime = startRuntime(50000, plan, { connection, signal: controller.signal, timeout: 30_000 });
  controller.abort(new Error('cancel while starting'));
  await assert.rejects(runtime, /cancel while starting/);
  assert.equal(connection.closed, true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('Cancellation after activation reports runtime loss and close removes the abort listener', async () => {
  const controller = new AbortController(), connection = new AbortConnection();
  const runtime = await startRuntime(50000, plan, { connection, signal: controller.signal, timeout: 500 });
  try {
    assert.equal(runtime.sessionId, 'primary');
    assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
    controller.abort(new Error('cancel running session'));
    assert.match((await runtime.lost).message, /cancel running session/);
  } finally { runtime.close(); }
  assert.equal(connection.closed, true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('A verified secondary window survives closure of the original window', async () => {
  const connection = new AbortConnection();
  const runtime = await startRuntime(50000, plan, { connection, timeout: 500 });
  try {
    connection.attach('secondary');
    await nextTurn();
    assert.equal(runtime.sessionId, 'primary');
    assert.equal(connection.commands.some(call => call.session === 'secondary' && call.method === 'Fetch.fulfillRequest'), true);
    connection.emit('Target.detachedFromTarget', { sessionId: 'primary' });
    assert.equal(runtime.sessionId, 'secondary');
    assert.deepEqual(await runtime.evaluate('({url:location.href,ready:document.readyState})'),
      { url: 'app://-/index.html', ready: 'complete' });
  } finally { runtime.close(); }
});

test('External tabs and workers resume without being mistaken for native windows', async () => {
  const connection = new AbortConnection();
  const runtime = await startRuntime(50000, plan, { connection, timeout: 500 });
  try {
    connection.attach('external', 'https://example.com/');
    connection.attach('worker', 'app://-/worker.js', 'worker');
    await nextTurn();
    for (const id of ['external', 'worker']) {
      assert.equal(connection.commands.some(call => call.session === id && call.method === 'Runtime.runIfWaitingForDebugger'), true);
      assert.equal(connection.commands.some(call => call.session === id && call.method === 'Fetch.enable'), false);
    }
    assert.equal(runtime.sessionId, 'primary');
  } finally { runtime.close(); }
});

// A fresh Node worker can replace ESM imports without touching a real app or the
// parent test runner's signal handlers. All app/process operations below are fakes.
const execFile = promisify(execFileCallback);
const projectDirectory = fileURLToPath(new URL('../', import.meta.url));
async function launcherScenario(scenario) {
  const script = `
    import { mock } from 'node:test';
    import { pathToFileURL } from 'node:url';
    import { join } from 'node:path';
    const root = ${JSON.stringify(projectDirectory)}, scenario = ${JSON.stringify(scenario)};
    const state = { stops:0, closes:0, graceful:0, launched:0 };
    const moduleUrl = name => pathToFileURL(join(root, 'src', name)).href;
    mock.module(moduleUrl('platform.mjs'), { namedExports: {
      discoverApp: async()=>({version:'fake',platform:'win32',asarPath:'never-read'}),
      assertAppIdle: async()=>{},
      launchApp: async()=> { state.launched++; return {
        waitForExit: ()=>scenario==='monitor-error'?Promise.reject(Error('monitor failed')):new Promise(()=>{}),
        stop: async()=>{state.stops++;if(scenario==='cleanup-error')throw Error('cleanup failed')}
      }}
    }});
    mock.module(moduleUrl('preflight.mjs'), { namedExports: { inspectArchive:()=>({sha256:'fake-hash'}) }});
    mock.module(moduleUrl('asar.mjs'), { namedExports: { openAsar:()=>({fingerprint:()=>({sha256:'fake-hash'}),close:()=>{}}) }});
    mock.module(moduleUrl('runtime.mjs'), { namedExports: { startRuntime: async(port,plan,{signal})=>{
      if(scenario==='startup-abort'||scenario==='cleanup-error'){
        process.emit('SIGINT'); throw signal.reason;
      }
      let resolveLost;
      const lost = new Promise(resolve=>resolveLost=resolve);
      signal.addEventListener('abort',()=>resolveLost(signal.reason),{once:true});
      if(scenario==='active-abort')setImmediate(()=>process.emit('SIGINT'));
      return {lost,closeApp:async()=>{state.graceful++},close:()=>{state.closes++}};
    }}});
    const {runLauncher}=await import(moduleUrl('launch.mjs'));
    const beforeInt=process.listenerCount('SIGINT'),beforeTerm=process.listenerCount('SIGTERM');
    try {state.code=await runLauncher({log:()=>{}})}
    catch(error){state.error=error.message;state.errorType=error.constructor.name}
    state.signalListenersRestored=process.listenerCount('SIGINT')===beforeInt&&process.listenerCount('SIGTERM')===beforeTerm;
    console.log(JSON.stringify(state));
  `;
  const { stdout } = await execFile(process.execPath,
    ['--experimental-test-module-mocks', '--input-type=module', '-e', script],
    { timeout: 5000, windowsHide: true });
  return JSON.parse(stdout.trim());
}

test('Launcher Ctrl+C during startup cleans its owned app and returns cancellation status', async () => {
  const result = await launcherScenario('startup-abort');
  assert.equal(result.launched, 1);
  assert.equal(result.stops, 1);
  assert.equal(result.code, 130);
  assert.equal(result.signalListenersRestored, true);
});

test('Launcher never hides failed startup cleanup as a successful cancellation', async () => {
  const result = await launcherScenario('cleanup-error');
  assert.equal(result.code, undefined);
  assert.equal(result.errorType, 'AggregateError');
  assert.match(result.error, /cleanup needs attention/);
  assert.equal(result.signalListenersRestored, true);
});

test('Launcher active cancellation closes the app once and tears down the runtime', async () => {
  const result = await launcherScenario('active-abort');
  assert.equal(result.code, 130);
  assert.equal(result.stops, 1);
  assert.equal(result.graceful, 1);
  assert.equal(result.closes, 1);
  assert.equal(result.signalListenersRestored, true);
});

test('A monitoring error still stops the owned app before releasing interception', async () => {
  const result = await launcherScenario('monitor-error');
  assert.match(result.error, /monitor failed/);
  assert.equal(result.stops, 1);
  assert.equal(result.closes, 1);
  assert.equal(result.signalListenersRestored, true);
});
