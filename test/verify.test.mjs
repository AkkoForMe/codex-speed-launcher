import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyInstalledApp } from '../src/verify.mjs';

function fixture(backend = { ok: true, coreStopped: true, guiPreflightReady: true, sandboxReadiness: 'ready' }) {
  const calls = [];
  let saved;
  const state = { calls, get saved() { return saved; } };
  const generated = {
    app: { platform: 'win32', version: 'test' }, directory: 'test-report',
    codexHome: 'dummy-home', electronHome: 'dummy-electron', work: 'dummy-work', env: {},
    relay: { captures: [], async close() { calls.push('relay.close'); } },
  };
  state.system = {
    async prepareVerification() { calls.push('prepare'); return generated; },
    async verifyBackend() { calls.push('backend'); return backend; },
    async launchSession() {
      calls.push('gui.launch');
      return { plan: { resources: [] }, runtime: {
        observed: ['test'], evaluate: async () => 'dummy renderer',
        async closeApp() { calls.push('gui.closeApp'); }, close() { calls.push('gui.close'); },
      }, child: { async stop() { calls.push('gui.stop'); } } };
    },
    async verifyNativeMenu() { calls.push('nativeMenu'); return { ok: true }; },
    assertArchiveUnchanged() { calls.push('archive.check'); },
    async writeFile(path, source) { calls.push('report.save'); saved = JSON.parse(source); },
  };
  return state;
}

test('Unready Windows sandbox prevents any desktop startup and retains the backend result', async () => {
  for (const status of ['notConfigured', 'updateRequired']) {
    const state = fixture({ ok: true, coreStopped: true, guiPreflightReady: false, sandboxReadiness: status });
    const report = await verifyInstalledApp({ log() {}, system: state.system });
    assert.equal(report.ok, false);
    assert.match(report.error, /native UI verification was skipped/);
    assert.equal(report.backend.sandboxReadiness, status);
    assert.deepEqual(state.calls, ['prepare', 'backend', 'relay.close', 'report.save']);
    assert.equal(state.saved.ok, false);
  }
});

test('Backend failure or incomplete core cleanup prevents GUI verification', async () => {
  for (const backend of [
    { ok: false, coreStopped: true, error: 'Fast metadata unavailable' },
    { ok: true, coreStopped: false, cleanupError: 'Core still alive' },
  ]) {
    const state = fixture(backend);
    const report = await verifyInstalledApp({ log() {}, system: state.system });
    assert.equal(report.ok, false);
    assert.equal(report.error, backend.error || backend.cleanupError);
    assert.equal(state.calls.includes('gui.launch'), false);
    assert.equal(state.calls.includes('relay.close'), true);
  }
});

test('Ready core finishes before GUI, and successful verification stops only its test app', async () => {
  const state = fixture();
  const report = await verifyInstalledApp({ log() {}, system: state.system });
  assert.equal(report.ok, true);
  assert.equal(report.testAppStopped, true);
  assert.equal(report.appUnchanged, true);
  assert.deepEqual(state.calls, ['prepare', 'backend', 'gui.launch', 'nativeMenu', 'archive.check',
    'gui.closeApp', 'gui.close', 'gui.stop', 'relay.close', 'report.save']);
});
