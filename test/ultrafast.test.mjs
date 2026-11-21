import assert from 'node:assert/strict';
import http from 'node:http';
import { resolve } from 'node:path';
import test from 'node:test';
import { inspectUltrafast } from '../src/ultrafast.mjs';

const model = 'gpt-6.2-sol';
const version = '0.171.0-alpha.13';
const readVersion = async () => version;
const tier = id => ({ id, name: id, description: '' });
const catalog = (...tiers) => ({ models: [{ slug: model, visibility: 'list', supported_in_api: true,
  service_tiers: tiers.map(tier), additional_speed_tiers: ['ultrafast'] }] });

function providerConfig(base, catalogUrl = `${base}/codex/models`) {
  return `model = "${model}"
model_provider = 'relay.test'
[model_providers.'relay.test']
base_url = '${base}/v1'
model_catalog_url = '${catalogUrl}'
experimental_bearer_token = 'sk-pinned-test'
query_params = { route = 'test group' }
[model_providers.'relay.test'.http_headers]
User-Agent = 'preflight-fixture'
[model_providers.'relay.test'.env_http_headers]
X-Key-Test = 'PREFLIGHT_FIXTURE_HEADER'
`;
}

async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('provider catalog preflight uses the active key and exact model, and distinguishes Fast from Ultrafast', async t => {
  const requests = [];
  let body = catalog('priority');
  const origin = await listen(t, (request, response) => {
    requests.push(request);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(body));
  });
  const source = providerConfig(origin, `${origin}/codex/models?group=direct`);
  const check = () => inspectUltrafast(source, { readVersion, env: { PREFLIGHT_FIXTURE_HEADER: 'test-header' } });
  const fast = await check();
  assert.equal(fast.ultrafastAvailable, false);
  assert.match(fast.ultrafastDetail, /未提供 Ultrafast/);
  body = catalog('priority', 'ultrafast');
  assert.equal((await check()).ultrafastAvailable, true);
  body.models[0].slug = 'gpt-6.2-astra';
  assert.match((await check()).ultrafastDetail, /没有当前模型/);
  body = { data: [{ id: model, service_tiers: [tier('ultrafast')] }] };
  assert.match((await check()).ultrafastDetail, /无法识别/);
  assert.equal(requests.length, 4);
  for (const request of requests) {
    assert.equal(request.method, 'GET');
    assert.equal(request.url, `/codex/models?group=direct&route=test+group&client_version=${version}`);
    assert.equal(request.headers.authorization, 'Bearer sk-pinned-test');
    assert.equal(request.headers['x-key-test'], 'test-header');
    assert.equal(request.headers['user-agent'], 'preflight-fixture');
  }
  assert.doesNotMatch(JSON.stringify(fast), /sk-pinned-test|127\.0\.0\.1/);
});

test('cross-origin catalogs and redirect targets never receive the configured key', async t => {
  let targetHits = 0;
  const target = await listen(t, (_, response) => { targetHits++; response.end(JSON.stringify(catalog('ultrafast'))); });
  const origin = await listen(t, (_, response) => { response.writeHead(302, { Location: `${target}/models` }); response.end(); });
  assert.match((await inspectUltrafast(providerConfig(origin, `${target}/models`), { readVersion })).ultrafastDetail, /同源/);
  assert.match((await inspectUltrafast(providerConfig(origin), { readVersion })).ultrafastDetail, /刷新重试/);
  assert.equal(targetHits, 0);
});

test('a provider that uses the Codex login file can check a saved API Key without using OAuth tokens', async t => {
  const authHeaders = [];
  const base = await listen(t, (request, response) => {
    authHeaders.push(request.headers.authorization);
    response.end(JSON.stringify(catalog('priority', 'ultrafast')));
  });
  const source = providerConfig(base).replace(/^experimental_bearer_token.*$/m, 'requires_openai_auth = true');
  const home = resolve('fixture-codex-home');
  let auth = { OPENAI_API_KEY: 'sk-saved-fixture' };
  const read = async path => {
    assert.equal(path, resolve(home, 'auth.json'));
    return JSON.stringify(auth);
  };
  const options = { home, read, readVersion, env: {} };
  assert.equal((await inspectUltrafast(source, options)).ultrafastAvailable, true);
  auth = { auth_mode: 'chatgpt', tokens: { access_token: 'never-use-this' }, ...auth };
  assert.match((await inspectUltrafast(source, options)).ultrafastDetail, /登录方式/);
  assert.deepEqual(authHeaders, ['Bearer sk-saved-fixture']);
});

test('failed or stalled catalogs explain unavailability without exposing provider diagnostics', async t => {
  const origin = await listen(t, (request, response) => {
    if (request.url.startsWith('/stall')) return;
    response.writeHead(401);
    response.end(`unauthorized: ${request.headers.authorization}`);
  });
  const failure = await inspectUltrafast(providerConfig(origin), { readVersion });
  assert.deepEqual(failure, { model, ultrafastDetail: '暂时无法读取模型目录，可刷新重试。', ultrafastAvailable: false });
  const stalled = await inspectUltrafast(providerConfig(origin, `${origin}/stall`), { readVersion, timeoutMs: 35 });
  assert.deepEqual(stalled, failure);
});

test('explicit local catalog takes priority and configured feature switches explain why Ultrafast is disabled', async () => {
  const base = 'https://provider.example';
  const source = providerConfig(base);
  const home = resolve('fixture-codex-home');
  const read = async path => {
    assert.equal(path, resolve(home, 'model-catalog.json'));
    return JSON.stringify(catalog('priority', 'ultrafast'));
  };
  const request = async () => assert.fail('Preflight should not issue a network request');
  const options = { home, read, request, readVersion };
  assert.equal((await inspectUltrafast(`model_catalog_json = 'model-catalog.json'\n${source}`, options)).ultrafastAvailable, true);
  assert.match((await inspectUltrafast(`${source}\n[features]\nultrafast_mode = false`, options)).ultrafastDetail, /已关闭 Ultrafast/);
  assert.match((await inspectUltrafast(`${source}\n[features]\napi_key_model_discovery = false`, options)).ultrafastDetail, /已关闭模型目录/);
  const missingCatalog = source.replace(/^model_catalog_url.*$/m, '');
  assert.match((await inspectUltrafast(missingCatalog, options)).ultrafastDetail, /未配置 Codex 模型目录/);
});
