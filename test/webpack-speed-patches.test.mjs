import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { inspectWebpackSource, patchWebpackSource, WEBPACK_PROFILE, MACOS_WEBPACK_PROFILE, WEBPACK_PROFILES } from '../src/webpack-speed-patches.mjs';
import { inspectOpenArchive } from '../src/preflight.mjs';
import { sha256 } from '../src/asar.mjs';

// Handwritten helper contracts, not extracted application code or credentials.
const HOOK = 'function hook(host){let cache=readCache(),query,result,output,account=(0,accounts.read)(host),managed=account?.authMethod==="chatgpt"||account?.authMethod==="personalAccessToken"||account?.authMethod==="amazonBedrock",mode=account?.authMethod??null;cache[0]!==host||cache[1]!==mode?(query={authMethod:mode,hostId:host},cache[0]=host,cache[1]=mode,cache[2]=query):query=cache[2];let{data:requirements,isPending:pending}=(0,queries.use)(queries.access,query),loading=!!account?.isLoading||managed&&pending;cache[3]!==requirements||cache[4]!==loading||cache[5]!==managed?(result=managed&&!loading&&null!=requirements?(0,requirementsApi.normalize)(requirements):null,cache[3]=requirements,cache[4]=loading,cache[5]=managed,cache[6]=result):result=cache[6];let alias=result;return cache[7]!==loading||cache[8]!==alias?(output={serviceTierAccess:alias,isLoading:loading},cache[7]=loading,cache[8]=alias,cache[9]=output):output=cache[9],output}';
const REQUEST = 'async function requestAccess(store,host){try{let result=await async function(store,host){let auth=await (0,accounts.mode)(store,host);if("chatgpt"!==auth&&"personalAccessToken"!==auth&&"amazonBedrock"!==auth)return null;let requirements=await (0,requirementsApi.read)(store,host,{priority:"critical"});return store.query.setData(queries.access,{authMethod:auth,hostId:host},requirements),(0,requirementsApi.normalize)(requirements)}(store,host);return result}catch(error){throw Error("Failed to read service tier for request")}}';
const SOURCE = `${HOOK};${REQUEST}`;

function harness({ mode = 'apikey', loading = false, pending = false, requirements = {} } = {}, patched = true) {
  const calls = [], cache = [];
  const context = vm.createContext({ readCache: () => cache,
    accounts: { read: () => ({ authMethod: mode, isLoading: loading }), mode: async () => mode },
    queries: { access: {}, use: () => ({ data: requirements, isPending: pending }) },
    requirementsApi: { read: async (...args) => { calls.push(args); return requirements; },
      normalize: requirements => ({ fast: requirements.fast !== false, ultrafast: requirements.ultrafast !== false }) },
  });
  vm.runInContext(patched ? patchWebpackSource(SOURCE).content : SOURCE, context);
  const store = { query: { setData: (...args) => calls.push(args) } };
  return { access: () => context.hook('local'), request: () => context.requestAccess(store, 'local'), calls,
    setMode(value) { mode = value; }, setLoading(value) { loading = value; } };
}

test('webpack helper pair is exact and idempotent despite arbitrary minified symbols', () => {
  const found = inspectWebpackSource(SOURCE);
  assert.deepEqual(found.map(item => item.id), Object.keys(WEBPACK_PROFILE.counts));
  assert.ok(found.every(item => item.state === 'guarded' && item.count === 1));
  const first = patchWebpackSource(SOURCE), again = patchWebpackSource(first.content);
  assert.equal(again.content, first.content);
  assert.ok(inspectWebpackSource(first.content).every(item => item.state === 'patched'));
});

test('webpack API key and null custom provider get Fast in UI and request paths without remote requirements', async () => {
  const old = harness({}, false);
  assert.equal(old.access().serviceTierAccess, null);
  assert.equal(await old.request(), null);
  for (const mode of ['apikey', null]) {
    const current = harness({ mode });
    assert.equal(current.access().serviceTierAccess.fast, true);
    assert.equal(current.access().serviceTierAccess.ultrafast, false);
    assert.equal((await current.request()).fast, true);
    assert.equal((await current.request()).ultrafast, false);
    assert.deepEqual(current.calls, []);
  }
});

test('webpack unknown auth modes stay denied and managed modes retain their requirement flags', async () => {
  for (const mode of ['copilot', 'unknownFutureAuth']) {
    const current = harness({ mode });
    assert.equal(current.access().serviceTierAccess, null);
    assert.equal(await current.request(), null);
    assert.deepEqual(current.calls, []);
  }
  for (const mode of ['chatgpt', 'personalAccessToken', 'amazonBedrock']) {
    const current = harness({ mode, requirements: { fast: false, ultrafast: false } });
    assert.equal(current.access().serviceTierAccess.fast, false);
    assert.equal((await current.request()).fast, false);
    assert.equal(current.calls.length, 2);
    assert.equal(harness({ mode, requirements: {} }).access().serviceTierAccess.fast, true);
  }
});

test('webpack memo invalidates between unmanaged auth modes and authentication pending stays denied', () => {
  const current = harness({ mode: 'copilot' });
  assert.equal(current.access().serviceTierAccess, null);
  current.setMode('apikey');
  const access = current.access().serviceTierAccess;
  assert.equal(access.fast, true);
  assert.equal(current.access().serviceTierAccess, access);
  current.setMode('copilot');
  assert.equal(current.access().serviceTierAccess, null);
  current.setMode(null);
  assert.equal(current.access().serviceTierAccess.fast, true);
  current.setLoading(true);
  assert.equal(current.access().serviceTierAccess, null);
  assert.equal(harness({ mode: 'chatgpt', pending: true }).access().serviceTierAccess, null);
});

test('webpack duplicate helpers, altered access markers and changed semantic context fail closed', () => {
  assert.throws(() => patchWebpackSource(`${SOURCE};${SOURCE}`), /Ambiguous/);
  const patched = patchWebpackSource(SOURCE).content;
  for (const modified of [patched.replace('{fast:!0,ultrafast:!1}', '{fast:!0,ultrafast:!0}'),
    patched.replace('cache[5]!==mode', 'cache[5]!==managed')]) {
    assert.throws(() => patchWebpackSource(modified), /Ambiguous/);
  }
  for (const modified of [HOOK.replaceAll('amazonBedrock', 'unrecognizedAuth'), HOOK.replace('hostId:host', 'hostId:other'),
    HOOK.replace('serviceTierAccess:alias,isLoading:loading', 'serviceTierAccess:unrelated,isLoading:loading')]) {
    assert.deepEqual(inspectWebpackSource(modified), []);
    assert.equal(patchWebpackSource(modified).content, modified);
  }
});

function archiveFixture({ sha = WEBPACK_PROFILE.sha256, hookCount = 7, requestCount = 8, duplicate = false } = {}) {
  const files = [];
  for (let index = 0; index < hookCount; index++) files.push({ path: `webview/assets/async/hook-${index}.js`, source: index === 0 && duplicate ? `${HOOK};${HOOK}` : HOOK });
  for (let index = 0; index < requestCount; index++) files.push({ path: `webview/assets/async/request-${index}.js`, source: REQUEST });
  return { files, read: entry => Buffer.from(entry.source), fingerprint: () => ({ sha256: sha, size: 100 }) };
}

test('preflight permits repeated webpack helpers only for the pinned archive and exact 7/8 count', () => {
  const plan = inspectOpenArchive(archiveFixture());
  assert.equal(plan.rendererProfile, `webpack-${WEBPACK_PROFILE.version}`);
  assert.equal(plan.resources.length, 15);
  assert.equal(plan.resources.filter(item => item.ids.includes('api-key-service-tier-access')).length, 7);
  for (const resource of plan.resources) {
    assert.ok(resource.runtimePath.startsWith('assets/async/'));
    assert.equal(resource.patchedHash, sha256(resource.content));
    assert.notEqual(resource.sourceHash, resource.patchedHash);
  }
  assert.throws(() => inspectOpenArchive(archiveFixture({ sha: '0'.repeat(64) })), /matched 0 times \(expected 1\)/);
  assert.throws(() => inspectOpenArchive(archiveFixture({ hookCount: 6 })), /matched 6 times \(expected 7\)/);
  assert.throws(() => inspectOpenArchive(archiveFixture({ requestCount: 9 })), /matched 9 times \(expected 8\)/);
  assert.throws(() => inspectOpenArchive(archiveFixture({ duplicate: true })), /Ambiguous/);
});

test('preflight refuses a changed archive and invalid patched webpack syntax', () => {
  const changed = archiveFixture();
  let first = true;
  changed.fingerprint = () => ({ sha256: first ? (first = false, WEBPACK_PROFILE.sha256) : 'f'.repeat(64) });
  assert.throws(() => inspectOpenArchive(changed), /changed during inspection/);
  const invalid = archiveFixture();
  invalid.files[0].source += ';const invalid = ;';
  assert.throws(() => inspectOpenArchive(invalid), /syntax validation/);
});

test('macOS webpack profile requires its own audited hash and exact 8/6 resource layout', () => {
  const mac = { sha: MACOS_WEBPACK_PROFILE.sha256, hookCount: 8, requestCount: 6 };
  const plan = inspectOpenArchive(archiveFixture(mac));
  assert.equal(plan.rendererProfile, MACOS_WEBPACK_PROFILE.name);
  assert.equal(plan.resources.length, 14);
  assert.equal(plan.resources.filter(item => item.ids.includes('api-key-service-tier-access')).length, 8);
  assert.equal(plan.resources.filter(item => item.ids.includes('api-key-request-tier-access')).length, 6);
  assert.equal(new Set(WEBPACK_PROFILES.map(profile => profile.sha256)).size, WEBPACK_PROFILES.length);
  assert.ok(Object.isFrozen(MACOS_WEBPACK_PROFILE.counts));
  assert.throws(() => inspectOpenArchive(archiveFixture({ ...mac, sha: 'b'.repeat(64) })), /matched 0 times \(expected 1\)/);
  assert.throws(() => inspectOpenArchive(archiveFixture({ ...mac, sha: WEBPACK_PROFILE.sha256 })), /matched 8 times \(expected 7\)/);
  assert.throws(() => inspectOpenArchive(archiveFixture({ sha: MACOS_WEBPACK_PROFILE.sha256 })), /matched 7 times \(expected 8\)/);
  assert.throws(() => inspectOpenArchive(archiveFixture({ ...mac, requestCount: 7 })), /matched 7 times \(expected 6\)/);
});
