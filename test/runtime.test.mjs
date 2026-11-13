import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { resourceForUrl, fulfillPatchedResource, startRuntime } from '../src/runtime.mjs';
import { sha256 } from '../src/asar.mjs';

const RESOURCE = {
  runtimePath: 'assets/native-speed.js', archivePath: 'webview/assets/native-speed.js',
  sourceHash: sha256('original module'), patchedHash: sha256('patched module'),
  content: 'patched module', ids: ['speed-test'],
};
const PLAN = { requiredIds: ['speed-test'], resources: [RESOURCE] };

test('runtime binds resources to the native origin and exact approved path', () => {
  assert.equal(resourceForUrl('app://-/assets/native-speed.js', [RESOURCE], 'app://-'), RESOURCE);
  assert.equal(resourceForUrl('app://-/webview/assets/native-speed.js', [RESOURCE], 'app://-'), RESOURCE);
  for (const url of [
    'https://example.com/assets/native-speed.js',
    'app://other/assets/native-speed.js',
    'app://-/assets/other.js',
  ]) assert.equal(resourceForUrl(url, [RESOURCE], 'app://-'), null);
});

test('webpack lazy resources remain bound to exact audited async paths and native origin', () => {
  const lazy = { ...RESOURCE, runtimePath: 'assets/async/123.audited.js', archivePath: 'webview/assets/async/123.audited.js' };
  assert.equal(resourceForUrl('app://-/assets/async/123.audited.js', [lazy], 'app://-'), lazy);
  assert.equal(resourceForUrl('app://-/webview/assets/async/123.audited.js', [lazy], 'app://-'), lazy);
  assert.equal(resourceForUrl('app://-/assets/async/other.js', [lazy], 'app://-'), null);
  assert.equal(resourceForUrl('https://example.test/assets/async/123.audited.js', [lazy], 'app://-'), null);
});

test('runtime patch preserves security headers and removes stale compressed size metadata', async () => {
  const calls = [];
  const cdp = { async send(method, params, session) {
    calls.push({ method, params, session });
    return method === 'Fetch.getResponseBody' ? { body: Buffer.from('original module').toString('base64'), base64Encoded: true } : {};
  } };
  const ids = await fulfillPatchedResource(cdp, {
    requestId: 'resource-1', responseStatusCode: 200,
    responseHeaders: [
      { name: 'Content-Length', value: '999' },
      { name: 'Content-Encoding', value: 'gzip' },
      { name: 'Transfer-Encoding', value: 'chunked' },
      { name: 'ETag', value: 'old' },
      { name: 'Content-Type', value: 'application/javascript' },
      { name: 'Content-Security-Policy', value: "default-src 'self'" },
    ],
  }, 'renderer-a', RESOURCE);
  assert.deepEqual(ids, RESOURCE.ids);
  const fulfilled = calls.at(-1);
  assert.equal(fulfilled.method, 'Fetch.fulfillRequest');
  assert.equal(fulfilled.session, 'renderer-a');
  assert.equal(Buffer.from(fulfilled.params.body, 'base64').toString(), 'patched module');
  assert.deepEqual(fulfilled.params.responseHeaders.map(({ name }) => name), ['Content-Type', 'Content-Security-Policy']);
});

test('runtime refuses changed source, changed plan content and failed responses', async () => {
  const params = { requestId: 'resource-1', responseStatusCode: 200 };
  let fulfills = 0;
  const cdp = { async send(method) {
    if (method === 'Fetch.fulfillRequest') fulfills++;
    return { body: 'wrong resource', base64Encoded: false };
  } };
  await assert.rejects(fulfillPatchedResource(cdp, params, 'renderer-a', RESOURCE), /changed since inspection/);
  const expectedBody = { async send() { return { body: 'original module', base64Encoded: false }; } };
  await assert.rejects(fulfillPatchedResource(expectedBody, params, 'renderer-a', { ...RESOURCE, content: 'tampered' }), /content integrity/);
  await assert.rejects(fulfillPatchedResource(expectedBody, { ...params, responseStatusCode: 404 }, 'renderer-a', RESOURCE), /did not load/);
  assert.equal(fulfills, 0);
});

class RuntimeConnection extends EventEmitter {
  commands = [];
  active = new Set();
  requests = new Map();
  waiting = new Map();
  closed = false;
  replaced = false;
  constructor({ replaceDuringSetup = false, replaceDuringBody = false } = {}) {
    super(); this.replaceDuringSetup = replaceDuringSetup; this.replaceDuringBody = replaceDuringBody;
  }
  attach(session) {
    this.active.add(session);
    this.emit('Target.attachedToTarget', { sessionId: session, targetInfo: { type: 'page', url: 'app://-/index.html' }, waitingForDebugger: true });
  }
  async send(method, params = {}, session) {
    this.commands.push({ method, params, session });
    if (session && !this.active.has(session)) throw new Error('No session with given id');
    if (method === 'Target.setAutoAttach') { queueMicrotask(() => this.attach('first-renderer')); return {}; }
    if (method === 'Fetch.enable' && this.replaceDuringSetup && session === 'first-renderer' && !this.replaced) {
      this.replaced = true;
      await Promise.resolve();
      this.active.delete(session);
      this.emit('Target.detachedFromTarget', { sessionId: session });
      this.attach('replacement-renderer');
    }
    if (method === 'Runtime.evaluate') {
      if (params.expression.startsWith('({url:')) return { result: { value: { url: 'app://-/index.html', ready: 'complete' } } };
      if (params.expression.startsWith('Promise.all')) {
        const requestId = `preload-${session}`;
        this.requests.set(requestId, 'original module');
        const completed = new Promise(resolve => this.waiting.set(requestId, resolve));
        this.emit('Fetch.requestPaused', {
          requestId, request: { url: 'app://-/assets/native-speed.js' }, responseStatusCode: 200,
        }, session);
        await completed;
        return { result: { value: [200] } };
      }
    }
    if (method === 'Fetch.getResponseBody') {
      if (this.replaceDuringBody && session === 'first-renderer' && !this.replaced) {
        this.replaced = true;
        await Promise.resolve();
        this.active.delete(session);
        this.emit('Target.detachedFromTarget', { sessionId: session });
        this.attach('replacement-renderer');
        throw new Error('No session with given id');
      }
      return { body: this.requests.get(params.requestId), base64Encoded: false };
    }
    if (method === 'Fetch.fulfillRequest' || method === 'Fetch.failRequest') this.waiting.get(params.requestId)?.();
    return {};
  }
  close() {
    this.closed = true;
    for (const resolve of this.waiting.values()) resolve();
    this.emit('disconnected', new Error('test closed'));
  }
}

test('runtime verifies every required resource and leaves external resources untouched', async () => {
  const cdp = new RuntimeConnection();
  const runtime = await startRuntime(50000, PLAN, { timeout: 500, connection: cdp });
  try {
    assert.deepEqual(runtime.observed, PLAN.requiredIds);
    assert.deepEqual(runtime.observedResources, [RESOURCE.archivePath]);
    cdp.emit('Fetch.requestPaused', { requestId: 'external', request: { url: 'https://example.com/assets/native-speed.js' } }, runtime.sessionId);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(cdp.commands.some(({ method, params }) => method === 'Fetch.continueRequest' && params.requestId === 'external'));
    assert.ok(!cdp.commands.some(({ method, params }) => method === 'Fetch.getResponseBody' && params.requestId === 'external'));
    cdp.emit('disconnected', new Error('connection lost'));
    assert.match((await runtime.lost).message, /connection lost/);
  } finally { runtime.close(); }
  assert.equal(cdp.closed, true);
});

class RepeatedIdConnection extends EventEmitter {
  commands = [];
  bodies = new Map();
  waiting = new Map();
  closed = false;
  constructor(resources, { omit = [], secondRendererOmit = [] } = {}) {
    super(); this.resources = resources; this.omit = omit; this.secondRendererOmit = secondRendererOmit;
  }
  attach(sessionId) {
    this.emit('Target.attachedToTarget', { sessionId,
      targetInfo: { type: 'page', url: 'app://-/index.html' }, waitingForDebugger: true });
  }
  async send(method, params = {}, sessionId) {
    this.commands.push({ method, params, sessionId });
    if (method === 'Target.setAutoAttach') queueMicrotask(() => this.attach('initial'));
    if (method === 'Runtime.evaluate') {
      if (params.expression.startsWith('({url:')) return { result: { value: { url: 'app://-/index.html', ready: 'complete' } } };
      if (params.expression.startsWith('Promise.all')) {
        for (const resource of this.resources) {
          if ((sessionId === 'secondary' ? this.secondRendererOmit : this.omit).includes(resource.archivePath)) continue;
          const requestId = `${sessionId}-${resource.archivePath}`;
          this.bodies.set(requestId, resource.original);
          const completion = new Promise(resolve => this.waiting.set(requestId, resolve));
          this.emit('Fetch.requestPaused', { requestId, responseStatusCode: 200,
            request: { url: `app://-/${resource.runtimePath}` } }, sessionId);
          await completion;
        }
        // All fetches report HTTP 200 even if a resource bypassed interception.
        return { result: { value: this.resources.map(() => 200) } };
      }
    }
    if (method === 'Fetch.getResponseBody') return { body: this.bodies.get(params.requestId), base64Encoded: false };
    if (method === 'Fetch.fulfillRequest' || method === 'Fetch.failRequest') this.waiting.get(params.requestId)?.();
    return {};
  }
  close() { this.closed = true; for (const resolve of this.waiting.values()) resolve(); }
}

const REPEATED_RESOURCES = Array.from({ length: 15 }, (_, index) => ({
  archivePath: `webview/assets/async/audited-${index}.js`, runtimePath: `assets/async/audited-${index}.js`,
  original: `original ${index}`, sourceHash: sha256(`original ${index}`),
  content: `patched ${index}`, patchedHash: sha256(`patched ${index}`), ids: [index < 7 ? 'hook' : 'request'],
}));
const REPEATED_PLAN = { requiredIds: ['hook', 'request'], resources: REPEATED_RESOURCES };

test('runtime rejects an omitted duplicate resource even when both patch IDs and all fetches succeed', async () => {
  const omitted = REPEATED_RESOURCES[3].archivePath;
  const cdp = new RepeatedIdConnection(REPEATED_RESOURCES, { omit: [omitted] });
  await assert.rejects(startRuntime(50000, REPEATED_PLAN, { timeout: 500, connection: cdp }),
    error => /Not all checked resources/.test(error.message) && error.message.includes(omitted));
  assert.equal(cdp.closed, true);
  const fulfilled = cdp.commands.filter(command => command.method === 'Fetch.fulfillRequest');
  assert.equal(fulfilled.length, 14);
});

test('runtime verifies every exact lazy resource before accepting the 7/8 repeated patch profile', async () => {
  const cdp = new RepeatedIdConnection(REPEATED_RESOURCES);
  const runtime = await startRuntime(50000, REPEATED_PLAN, { timeout: 500, connection: cdp });
  try {
    assert.deepEqual(runtime.observed, ['hook', 'request']);
    assert.deepEqual(runtime.observedResources, REPEATED_RESOURCES.map(resource => resource.archivePath));
    assert.equal(cdp.commands.filter(command => command.method === 'Fetch.fulfillRequest').length, 15);
  } finally { runtime.close(); }
});

test('a new renderer must verify all repeated resources independently of an already ready renderer', async () => {
  const omitted = REPEATED_RESOURCES[9].archivePath;
  const cdp = new RepeatedIdConnection(REPEATED_RESOURCES, { secondRendererOmit: [omitted] });
  const runtime = await startRuntime(50000, REPEATED_PLAN, { timeout: 500, connection: cdp });
  try {
    cdp.attach('secondary');
    const error = await runtime.lost;
    assert.match(error.message, /Not all checked resources/);
    assert.ok(error.message.includes(omitted));
    assert.equal(runtime.sessionId, 'initial');
  } finally { runtime.close(); }
});

test('runtime handles a detached initializing renderer when its replacement verifies successfully', async () => {
  const cdp = new RuntimeConnection({ replaceDuringSetup: true });
  const runtime = await startRuntime(50000, PLAN, { timeout: 500, connection: cdp });
  try { assert.equal(runtime.sessionId, 'replacement-renderer'); }
  finally { runtime.close(); }
});

test('runtime tolerates an in-flight body request from a detached renderer', async () => {
  const cdp = new RuntimeConnection({ replaceDuringBody: true });
  const runtime = await startRuntime(50000, PLAN, { timeout: 500, connection: cdp });
  try { assert.equal(runtime.sessionId, 'replacement-renderer'); }
  finally { runtime.close(); }
});

test('native query and fragment variants cannot silently bypass the checked body', () => {
  assert.equal(resourceForUrl('app://-/assets/native-speed.js?v=1', [RESOURCE], 'app://-'), RESOURCE);
  assert.equal(resourceForUrl('app://-/assets/native-speed.js#module', [RESOURCE], 'app://-'), RESOURCE);
  assert.doesNotThrow(() => resourceForUrl('app://-/assets/native-speed.js%ZZ', [RESOURCE], 'app://-'));
});
