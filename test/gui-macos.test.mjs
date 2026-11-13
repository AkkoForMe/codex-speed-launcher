import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createMacSelfTestController, runMacBackend } from '../src/gui-macos-backend.mjs';

test('macOS native mock runs the real controller with graceful timeout and recovery without reading real Codex', async () => {
  const controller = createMacSelfTestController();
  await controller.initialize();
  assert.equal(controller.snapshot().version, 'Mock 1.0');
  await controller.dispatch('refresh');
  assert.equal(controller.snapshot().selfTestStats.inspections, 2);
  await controller.dispatch('start');
  assert.equal(controller.snapshot().selfTestStats.launches, 1);
  await controller.dispatch('restart');
  assert.equal(controller.snapshot().managed, true);
  assert.equal(controller.snapshot().selfTestStats.forcedStops, 0);
  assert.match(controller.snapshot().detail, /尚未退出/);
  await controller.dispatch('restart');
  assert.equal(controller.snapshot().managed, true);
  assert.equal(controller.snapshot().selfTestStats.launches, 2);
  await controller.dispatch('quit');
  assert.equal(controller.snapshot().closed, true);
  assert.deepEqual(controller.snapshot().selfTestStats, { inspections: 2, launches: 2, closes: 3, forcedStops: 0 });
});

test('macOS backend privately hands off loopback credentials and preserves the normal bridge authorization', async () => {
  const input = new PassThrough(); const output = new PassThrough(); let handshake = '';
  output.on('data', data => { handshake += data; });
  const backend = await runMacBackend({ selfTest: true, input, output });
  try {
    const hello = JSON.parse(handshake);
    assert.match(hello.endpoint, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.match(hello.token, /^[a-f0-9]{64}$/);
    assert.equal((await fetch(`${hello.endpoint}/state`)).status, 403);
    const state = await (await fetch(`${hello.endpoint}/state`, { headers: { Authorization: `Bearer ${hello.token}` } })).json();
    assert.equal(state.version, 'Mock 1.0');
    assert.equal(JSON.stringify(state).includes(hello.token), false);
    assert.equal(handshake.split('\n').filter(Boolean).length, 1);
  } finally { await backend.close(); input.destroy(); output.destroy(); }
});

test('closing the macOS parent pipe cleans up only its owned mock session and closes the bridge', async () => {
  const input = new PassThrough(); const output = new PassThrough(); output.resume();
  const controller = createMacSelfTestController();
  const errors = [];
  const backend = await runMacBackend({ input, output, controller, onError: error => errors.push(error) });
  await controller.dispatch('start');
  // Parent death follows the existing disposal fallback when the owned process
  // refuses graceful close; ordinary native close uses /action quit instead.
  input.end();
  await nextTurn(); await nextTurn();
  assert.equal(controller.snapshot().selfTestStats.forcedStops, 1);
  await assert.rejects(fetch(`${backend.bridge.endpoint}/state`));
  assert.match(errors[0].message, /尚未退出/);
  input.destroy(); output.destroy();
});

test('the standalone macOS backend exits after a normal native parent pipe closes', { timeout: 10000 }, async t => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/gui-macos-backend.mjs', import.meta.url)), '--self-test'],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => { if (child.exitCode == null) child.kill(); });
  const exited = once(child, 'exit');
  let pending = '';
  const hello = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.on('data', chunk => {
      pending += chunk;
      if (pending.includes('\n')) resolve(JSON.parse(pending.slice(0, pending.indexOf('\n'))));
    });
  });
  const headers = { Authorization: `Bearer ${hello.token}` };
  const waitState = async predicate => {
    for (let i = 0; i < 100; i++) {
      const state = await (await fetch(`${hello.endpoint}/state`, { headers })).json();
      if (predicate(state)) return state;
      await nextTurn();
    }
    assert.fail('Backend did not reach the expected lifecycle state.');
  };
  const action = async body => {
    assert.equal((await fetch(`${hello.endpoint}/action`, { method: 'POST', headers, body })).status, 202);
  };
  let state = await waitState(state => !state.busy);
  assert.equal(state.compatible, true);
  await action('start');
  await waitState(state => state.managed && !state.busy);
  await action('restart');
  state = await waitState(state => state.phase === 'error' && !state.busy);
  assert.equal(state.managed, true);
  await action('restart');
  await waitState(state => state.selfTestStats.launches === 2 && !state.busy);
  await action('quit');
  state = await waitState(state => state.closed);
  assert.equal(state.closed, true);
  assert.deepEqual(state.selfTestStats, { inspections: 1, launches: 2, closes: 3, forcedStops: 0 });
  child.stdin.end();
  const [code, signal] = await exited;
  assert.equal(code, 0);
  assert.equal(signal, null);
});
