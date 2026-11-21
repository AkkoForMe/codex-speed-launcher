import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { bundledCorePath } from './platform.mjs';
import { parse } from './vendor/smol-toml.mjs';

const run = promisify(execFile);
const maxCatalogBytes = 8 * 1024 * 1024;

function safeModel(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/.test(value)
    && !value.startsWith('sk-') ? value : '未读取';
}

async function coreVersion(app) {
  const { stdout } = await run(bundledCorePath(app), ['--version'], { timeout: 2000, windowsHide: true, maxBuffer: 4096 });
  const version = stdout.trim().match(/^codex-cli (\d+\.\d+\.\d+(?:-[\w.-]+)?)$/)?.[1];
  if (!version) throw new Error('Codex core version unavailable');
  return version;
}

function catalogAddress(provider) {
  const base = new URL(provider.base_url);
  const url = new URL(provider.model_catalog_url);
  const loopback = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (base.origin !== url.origin || (url.protocol !== 'https:' && !loopback)
      || base.username || base.password || url.username || url.password || url.hash) return null;
  return url;
}

function catalogHeaders(provider, env) {
  const headers = new Headers({ accept: 'application/json' });
  for (const [name, value] of Object.entries(provider.http_headers ?? {})) headers.set(name, value);
  for (const [name, variable] of Object.entries(provider.env_http_headers ?? {})) {
    const value = env[variable]?.trim();
    if (value) headers.set(name, value);
  }
  // The catalog endpoint must use its own URL's authority and an ordinary GET.
  for (const name of ['host', 'proxy-authorization', 'content-length', 'transfer-encoding', 'upgrade']) {
    if (headers.has(name)) throw new Error('Unsupported catalog request header');
  }
  return headers;
}

async function readResponse(response) {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('Model catalog request failed');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maxCatalogBytes) throw new Error('Model catalog is too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// This probe only checks model metadata. Keep the response, credentials and
// provider details out of the GUI bridge, including on network or parse errors.
export async function inspectUltrafast(source, {
  app, home, env = process.env, read = readFile, request = fetch, readVersion = coreVersion, timeoutMs = 4500,
} = {}) {
  let model = '未读取';
  const result = (ultrafastDetail, ultrafastAvailable = false) => ({ model, ultrafastDetail, ultrafastAvailable });
  let config;
  try { config = parse(source.replace(/^\uFEFF/, '')); }
  catch { return result('暂时无法读取 Codex 配置。'); }

  const profile = config.profiles?.[config.profile];
  model = safeModel(profile?.model ?? config.model);
  if (config.profile && !profile) return result('无法确认当前 Codex 配置。');
  if (model === '未读取') return result('未读到配置模型。');
  const features = { ...config.features, ...profile?.features };
  if (features.ultrafast_mode === false) return result('Codex 配置已关闭 Ultrafast。');

  let catalog;
  try {
    const catalogFile = profile?.model_catalog_json ?? config.model_catalog_json;
    const providerId = profile?.model_provider ?? config.model_provider ?? 'openai';
    const provider = config.model_providers?.[providerId];
    if (catalogFile) {
      catalog = JSON.parse(await read(resolve(home, catalogFile), 'utf8'));
    } else {
      if (providerId === 'openai') return result('OpenAI 直连请在 Codex 速度菜单查看。');
      if (!provider?.model_catalog_url) return result('当前供应商未配置 Codex 模型目录。');
      if (features.api_key_model_discovery === false) return result('Codex 配置已关闭模型目录发现。');
      if (provider.auth || provider.gateway_oauth) {
        return result('当前登录方式无法在启动前检查。');
      }
      const url = catalogAddress(provider);
      if (!url) return result('模型目录需使用与供应商同源的地址。');
      const headers = catalogHeaders(provider, env);
      let key = (provider.env_key ? env[provider.env_key] : provider.experimental_bearer_token)?.trim();
      if (provider.env_key && !key) return result('未读到当前供应商的 API Key。');
      if (!key && provider.requires_openai_auth) {
        const store = profile?.cli_auth_credentials_store ?? config.cli_auth_credentials_store ?? 'file';
        const loginMethod = profile?.forced_login_method ?? config.forced_login_method;
        if (store !== 'file' || env.CODEX_ACCESS_TOKEN?.trim() || loginMethod === 'chatgpt') {
          return result('当前登录方式无法在启动前检查。');
        }
        const saved = JSON.parse(await read(resolve(home, 'auth.json'), 'utf8'));
        key = saved?.OPENAI_API_KEY?.trim();
        if (!key || (saved.auth_mode && saved.auth_mode !== 'apikey')) {
          return result('当前登录方式无法在启动前检查。');
        }
      }
      if (key) headers.set('authorization', `Bearer ${key}`);
      for (const [name, value] of Object.entries(provider.query_params ?? {})) url.searchParams.append(name, value);
      url.searchParams.append('client_version', await readVersion(app));
      catalog = await readResponse(await request(url, {
        method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      }));
    }
  } catch { return result('暂时无法读取模型目录，可刷新重试。'); }

  if (!Array.isArray(catalog?.models)) return result('无法识别 Codex 模型目录。');
  const entry = catalog.models.find(item => item?.slug === model);
  if (!entry) return result('模型目录中没有当前模型。');
  if (entry.visibility !== 'list' || entry.supported_in_api !== true) {
    return result('模型目录未向 API Key 开放当前模型。');
  }
  const tiers = entry.service_tiers;
  const hasUltrafast = Array.isArray(tiers) && tiers.some(tier => tier?.id === 'ultrafast'
    && typeof tier.name === 'string' && typeof tier.description === 'string');
  return hasUltrafast ? result('目录已提供，勾选后启动或重启生效。', true) : result('当前模型目录未提供 Ultrafast。');
}
