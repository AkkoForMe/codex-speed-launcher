import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { REQUIRED_IDS, inspectSource, patchSource } from '../src/speed-patches.mjs';

const PATH = 'webview/assets/example-build-hash.js';

// Handwritten small fixtures with the service-tier helper contract. These are
// not extracted application files. Minified symbol names are intentionally not
// copied from a particular Codex build.
const HOOK = 'function hook(host){let cache=readCache(),auth=readAuth(host),managed=auth?.authMethod===`chatgpt`||auth?.authMethod===`personalAccessToken`||auth?.authMethod===`amazonBedrock`,mode=auth?.authMethod??null;let{data:requirements,isPending:pending}=readRequirements(mode),loading=!!auth?.isLoading||managed&&pending,result;cache[3]!==requirements||cache[4]!==loading||cache[5]!==managed?(result=managed&&!loading&&requirements!=null?normalize(requirements):null,cache[3]=requirements,cache[4]=loading,cache[5]=managed,cache[6]=result):result=cache[6];return{serviceTierAccess:result,isLoading:loading}}';
const REQUEST = 'async function requestAccess(store,host){let auth=await readMode(store,host);if(auth!==`chatgpt`&&auth!==`personalAccessToken`&&auth!==`amazonBedrock`)return null;let requirements=await requestRequirements(store,host,{priority:`critical`});return store.query.setData(requirementsQuery,{authMethod:auth,hostId:host},requirements),normalize(requirements)}';
const DIAGNOSTIC = 'const diagnostic=`Failed to read service tier for request`;';
const SOURCE = `${HOOK}\n${DIAGNOSTIC}\n${REQUEST}`;

function normalize(requirements) {
  return {
    fast: requirements?.requirements?.featureRequirements?.fast_mode !== false,
    ultrafast: requirements?.requirements?.featureRequirements?.ultrafast_mode !== false,
  };
}

function harness({ authMethod = 'apikey', isLoading = false, pending = false, requirements = {} } = {}, patched = true) {
  const calls = [];
  const cache = [];
  const context = vm.createContext({
    readCache: () => cache,
    readAuth: () => ({ authMethod, isLoading }),
    readMode: async () => authMethod,
    readRequirements: () => ({ data: requirements, isPending: pending }),
    requestRequirements: async (...args) => { calls.push(args); return requirements; },
    requirementsQuery: {},
    normalize,
  });
  vm.runInContext(patched ? patchSource(PATH, SOURCE).content : SOURCE, context);
  const store = { query: { setData: (...args) => calls.push(args) } };
  return {
    access: () => context.hook('local'),
    requestAccess: () => context.requestAccess(store, 'local'),
    setAuthMethod: value => { authMethod = value; },
    calls,
  };
}

// Model capabilities stay authoritative. The launcher never adds a Fast model
// or invents model catalog entries. This is the request contract downstream of
// the patched access helpers, including explicit Standard and unsupported tiers.
function resolvedTier(model, selected, access) {
  const id = selected === 'fast' ? model?.serviceTiers?.find((tier) =>
    tier.id === 'priority' || tier.id === 'fast')?.id : selected;
  if (id == null || id === 'default') return null;
  if (id === 'ultrafast' && access?.ultrafast !== true) return null;
  if ((id === 'priority' || id === 'fast') && access?.fast === true) return id;
  return null;
}
const MODEL = { model: 'test-model', serviceTiers: [{ id: 'priority', name: 'Fast' }] };

test('current helper pair is complete, independent of asset hash and idempotent', () => {
  assert.equal(REQUIRED_IDS.length, 2);
  const matches = inspectSource(PATH, SOURCE);
  assert.deepEqual(matches.map(({ id }) => id), REQUIRED_IDS);
  assert.ok(matches.every(({ count, state }) => count === 1 && state === 'guarded'));
  const first = patchSource(PATH, SOURCE);
  assert.deepEqual(first.ids, REQUIRED_IDS);
  assert.deepEqual(first.appliedIds, REQUIRED_IDS);
  const second = patchSource('app://-/assets/another-hash.js', first.content);
  assert.equal(second.content, first.content);
  assert.deepEqual(second.appliedIds, []);
  assert.deepEqual(second.alreadyPatchedIds, REQUIRED_IDS);
});

test('API key receives native Fast access from both paths without a managed-auth fetch', async () => {
  const original = harness({}, false);
  assert.equal(original.access().serviceTierAccess, null);
  assert.equal(await original.requestAccess(), null);
  const fixed = harness();
  assert.equal(fixed.access().serviceTierAccess.fast, true);
  assert.equal(fixed.access().serviceTierAccess.ultrafast, false);
  assert.equal((await fixed.requestAccess()).fast, true);
  assert.deepEqual(fixed.calls, []);
});

test('null auth used by a custom provider gets Fast access but unrecognized auth does not', async () => {
  const custom = harness({ authMethod: null });
  assert.equal(custom.access().serviceTierAccess.fast, true);
  assert.equal((await custom.requestAccess()).fast, true);
  for (const authMethod of ['copilot', 'futureAuthMode']) {
    const unknown = harness({ authMethod });
    assert.equal(unknown.access().serviceTierAccess, null);
    assert.equal(await unknown.requestAccess(), null);
  }
});

test('React memo access refreshes when changing between non-managed auth methods', () => {
  const fixed = harness({ authMethod: 'copilot' });
  assert.equal(fixed.access().serviceTierAccess, null);
  fixed.setAuthMethod('apikey');
  assert.equal(fixed.access().serviceTierAccess.fast, true);
  const cached = fixed.access().serviceTierAccess;
  assert.equal(fixed.access().serviceTierAccess, cached);
  fixed.setAuthMethod('copilot');
  assert.equal(fixed.access().serviceTierAccess, null);
  fixed.setAuthMethod(null);
  assert.equal(fixed.access().serviceTierAccess.fast, true);
});

test('pending authentication cannot expose native speed controls', () => {
  assert.equal(harness({ isLoading: true }).access().serviceTierAccess, null);
  assert.equal(harness({ authMethod: 'chatgpt', pending: true }).access().serviceTierAccess, null);
});

test('ChatGPT, PAT and Bedrock keep their original feature requirements', async () => {
  const denied = { requirements: { featureRequirements: { fast_mode: false, ultrafast_mode: false } } };
  for (const authMethod of ['chatgpt', 'personalAccessToken', 'amazonBedrock']) {
    const fixed = harness({ authMethod, requirements: denied });
    assert.equal(fixed.access().serviceTierAccess.fast, false);
    assert.equal((await fixed.requestAccess()).fast, false);
    assert.equal(fixed.calls.length, 2);
    const allowed = harness({ authMethod, requirements: {} });
    assert.equal(allowed.access().serviceTierAccess.fast, true);
    assert.equal((await allowed.requestAccess()).fast, true);
  }
});

test('Standard / Fast / Standard changes the outgoing tier with the same model', async () => {
  const fixed = harness();
  const access = fixed.access().serviceTierAccess;
  assert.deepEqual(['default', 'fast', 'default'].map((tier) => ({
    model: MODEL.model,
    service_tier: resolvedTier(MODEL, tier, access),
  })), [
    { model: 'test-model', service_tier: null },
    { model: 'test-model', service_tier: 'priority' },
    { model: 'test-model', service_tier: null },
  ]);
  // Stop/edit/resend helpers use the separate async access path.
  assert.equal(resolvedTier(MODEL, 'fast', await fixed.requestAccess()), 'priority');
  assert.equal(resolvedTier(MODEL, 'default', await fixed.requestAccess()), null);
  assert.equal(resolvedTier(MODEL, 'ultrafast', access), null);
  assert.equal(resolvedTier({ model: 'no-tiers' }, 'fast', access), null);
});

test('explicit thread settings and pending choices are preserved when reopening chats', () => {
  // Existing native precedence: pending UI choice, explicit thread choice,
  // remembered thread tier, then default for an unconfigured/new chat.
  const fixture = 'function choose(conversation,threadTier,remembered,configured,pending){let tier=conversation!=null&&threadTier!==void 0?threadTier:conversation!=null&&remembered!==void 0?remembered:configured;pending!=null&&(tier=pending.serviceTier);return tier}';
  const patched = patchSource(PATH, `${SOURCE};${fixture}`).content;
  assert.ok(patched.includes(fixture));
  const context = vm.createContext();
  vm.runInContext(fixture, context);
  assert.equal(context.choose('existing', 'default', 'priority', 'priority', null), 'default');
  assert.equal(context.choose('existing', 'priority', 'default', 'default', null), 'priority');
  assert.equal(context.choose('existing', 'priority', 'priority', 'default', { serviceTier: 'default' }), 'default');
  assert.equal(context.choose(null, undefined, undefined, 'priority', null), 'priority');
});

test('ambiguous signatures, tampered markers and external pages fail safely', () => {
  assert.throws(() => patchSource(PATH, `${SOURCE};${SOURCE}`), /Ambiguous/);
  const first = patchSource(PATH, SOURCE).content;
  const tampered = first.replace('{fast:!0,ultrafast:!1}', '{fast:!0,ultrafast:!0}');
  assert.equal(inspectSource(PATH, tampered)[0].state, 'ambiguous');
  assert.throws(() => patchSource(PATH, tampered), /Ambiguous/);
  for (const path of ['https://example.com/assets/page.js', 'file:///assets/page.js', '.vite/build/main.js']) {
    assert.deepEqual(inspectSource(path, SOURCE), []);
    assert.equal(patchSource(path, SOURCE).content, SOURCE);
  }
});

test('a moved signature stays missing rather than broadly patching a similar expression', () => {
  const changed = SOURCE.replace('amazonBedrock', 'unrecognizedFutureAuth');
  assert.ok(!inspectSource(PATH, changed).some(({ id }) => id === 'api-key-service-tier-access'));
  assert.equal(patchSource(PATH, changed).content.includes(HOOK), false);
});
