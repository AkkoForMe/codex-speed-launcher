// The audited webpack renderers repeat these modules in lazy chunks. This
// adapter is selected only for an audited archive fingerprint in preflight.
// Handwritten fixtures exercise the semantic contracts; no app code is shipped.
import { apiKeySpeedAccess } from './speed-patches.mjs';

const ID = String.raw`[A-Za-z_$][\w$]*`;
const MEMBER = String.raw`${ID}\.${ID}`;
const marker = id => `/*codex-speed-launcher:${id}*/`;
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const WEBPACK_PROFILE = Object.freeze({
  version: '26.1106.6628.0',
  sha256: '54b74a9131680fc9eead711ed5d9f718f6127c22222ca60d2e3b577a707e2485',
  counts: Object.freeze({ 'api-key-service-tier-access': 7, 'api-key-request-tier-access': 8 }),
});

export const WINDOWS_261111_WEBPACK_PROFILE = Object.freeze({
  version: '26.1111.2228.0',
  sha256: '2551cba1057a05cdc5cf5d75b146fac4092bff4ce77a10c43e3286c88d24c82d',
  counts: Object.freeze({ 'api-key-service-tier-access': 8, 'api-key-request-tier-access': 6 }),
});

export const WINDOWS_261117_WEBPACK_PROFILE = Object.freeze({
  version: '26.1117.3838.0',
  sha256: '2334574abbf17086f34f60c228d2a32fc18ddb4044477771db6763023299a871',
  counts: Object.freeze({ 'api-key-service-tier-access': 12, 'api-key-request-tier-access': 14 }),
});

export const WINDOWS_261117_4957_WEBPACK_PROFILE = Object.freeze({
  version: '26.1117.4957.0',
  sha256: '8a437aad94098770c1bf5fd5385c204e162b62c6d7917f688741d74e05babe90',
  counts: Object.freeze({ 'api-key-service-tier-access': 12, 'api-key-request-tier-access': 14 }),
});

// Read-only inspection of the official macOS 26.1111.21308 (build 27194)
// archive found the same two semantic contracts with a different chunk layout.
// Never reuse another platform's counts or accept an unknown archive hash.
export const MACOS_WEBPACK_PROFILE = Object.freeze({
  version: '26.1111.21308',
  name: 'webpack-macos-26.1111.21308',
  sha256: '64782f30d783c24eb483e92f9a2e884ada6d24dc105fc27659ba16e073da145c',
  counts: Object.freeze({ 'api-key-service-tier-access': 8, 'api-key-request-tier-access': 6 }),
});

export const WEBPACK_PROFILES = Object.freeze([
  WEBPACK_PROFILE, WINDOWS_261111_WEBPACK_PROFILE, WINDOWS_261117_WEBPACK_PROFILE, MACOS_WEBPACK_PROFILE,
  WINDOWS_261117_4957_WEBPACK_PROFILE,
]);

const hookPrefix = String.raw`(?<prefix>(?<account>${ID})=\(0,${MEMBER}\)\((?<host>${ID})\),` +
  String.raw`(?<managed>${ID})=\k<account>\?\.authMethod==="chatgpt"\|\|\k<account>\?\.authMethod==="personalAccessToken"\|\|\k<account>\?\.authMethod==="amazonBedrock",` +
  String.raw`(?<mode>${ID})=\k<account>\?\.authMethod\?\?null;` +
  String.raw`(?<cache>${ID})\[0\]!==\k<host>\|\|\k<cache>\[1\]!==\k<mode>\?\((?<query>${ID})=\{authMethod:\k<mode>,hostId:\k<host>\},` +
  String.raw`\k<cache>\[0\]=\k<host>,\k<cache>\[1\]=\k<mode>,\k<cache>\[2\]=\k<query>\):\k<query>=\k<cache>\[2\];` +
  String.raw`let\{data:(?<data>${ID}),isPending:(?<pending>${ID})\}=\(0,${MEMBER}\)\(${MEMBER},\k<query>\),` +
  String.raw`(?<loading>${ID})=!!\k<account>\?\.isLoading\|\|\k<managed>&&\k<pending>;)`;
const hookTail = String.raw`,\k<cache>\[3\]=\k<data>,\k<cache>\[4\]=\k<loading>,\k<cache>\[5\]=`;
const hookEnd = String.raw`,\k<cache>\[6\]=\k<result>\):\k<result>=\k<cache>\[6\]` +
  String.raw`(?=;let (?<alias>${ID})=\k<result>;return \k<cache>\[7\]!==\k<loading>\|\|\k<cache>\[8\]!==\k<alias>\?\(${ID}=\{serviceTierAccess:\k<alias>,isLoading:\k<loading>\})`;
const hookGuarded = hookPrefix +
  String.raw`\k<cache>\[3\]!==\k<data>\|\|\k<cache>\[4\]!==\k<loading>\|\|\k<cache>\[5\]!==\k<managed>\?\((?<result>${ID})=` +
  String.raw`\k<managed>&&!\k<loading>&&null!=\k<data>\?(?<normalize>\(0,${MEMBER}\))\(\k<data>\):null` +
  hookTail + String.raw`\k<managed>` + hookEnd;
const hookPatched = access => hookPrefix +
  String.raw`\k<cache>\[3\]!==\k<data>\|\|\k<cache>\[4\]!==\k<loading>\|\|\k<cache>\[5\]!==\k<mode>\?\((?<result>${ID})=` +
  escape(marker('api-key-service-tier-access')) +
  String.raw`\(!\k<loading>&&\(\k<mode>==null\|\|\k<mode>==="apikey"\)\?` + escape(access) +
  String.raw`:\k<managed>&&!\k<loading>&&null!=\k<data>\?(?<normalize>\(0,${MEMBER}\))\(\k<data>\):null\)` +
  hookTail + String.raw`\k<mode>` + hookEnd;

const requestPrefix = String.raw`(?<prefix>async function\((?<store>${ID}),(?<host>${ID})\)\{let (?<auth>${ID})=await \(0,${MEMBER}\)\(\k<store>,\k<host>\);)`;
const requestBody = String.raw`if\("chatgpt"!==\k<auth>&&"personalAccessToken"!==\k<auth>&&"amazonBedrock"!==\k<auth>\)return null;` +
  String.raw`let (?<data>${ID})=await (?<read>\(0,${MEMBER}\))\(\k<store>,\k<host>,\{priority:"critical"\}\);` +
  String.raw`return \k<store>\.query\.setData\((?<query>${MEMBER}),\{authMethod:\k<auth>,hostId:\k<host>\},\k<data>\),` +
  String.raw`(?<normalize>\(0,${MEMBER}\))\(\k<data>\)\}\(\k<store>,\k<host>\)`;
const targets = [
  { id: 'api-key-service-tier-access', label: 'API key native speed controls', needle: 'serviceTierAccess:', guarded: hookGuarded, patched: hookPatched,
    replace(g, _matched, access) {
      return `${g.prefix}${g.cache}[3]!==${g.data}||${g.cache}[4]!==${g.loading}||${g.cache}[5]!==${g.mode}?(${g.result}=` +
        `${marker(this.id)}(!${g.loading}&&(${g.mode}==null||${g.mode}==="apikey")?${access}:` +
        `${g.managed}&&!${g.loading}&&null!=${g.data}?${g.normalize}(${g.data}):null),` +
        `${g.cache}[3]=${g.data},${g.cache}[4]=${g.loading},${g.cache}[5]=${g.mode},${g.cache}[6]=${g.result}):${g.result}=${g.cache}[6]`;
    } },
  { id: 'api-key-request-tier-access', label: 'API key request service tier', needle: 'Failed to read service tier for request', guarded: requestPrefix + requestBody,
    patched: access => requestPrefix + escape(marker('api-key-request-tier-access')) +
      String.raw`if\(\k<auth>==null\|\|\k<auth>==="apikey"\)return ` + escape(access) + ';' + requestBody,
    replace(g, matched, access) {
      return matched.replace(g.prefix, `${g.prefix}${marker(this.id)}if(${g.auth}==null||${g.auth}==="apikey")return ${access};`);
    } },
];

export function inspectWebpackSource(source, { ultrafast = false } = {}) {
  const access = apiKeySpeedAccess(ultrafast);
  return targets.filter(target => source.includes(target.needle)).map(target => {
    const guardedCount = [...source.matchAll(new RegExp(target.guarded, 'g'))].length;
    const patchedCount = [...source.matchAll(new RegExp(target.patched(access), 'g'))].length;
    const count = guardedCount + patchedCount;
    const markerCount = source.split(marker(target.id)).length - 1;
    return { id: target.id, label: target.label, count, guardedCount, patchedCount, markerCount,
      state: count !== 1 || markerCount !== patchedCount ? 'ambiguous' : patchedCount ? 'patched' : 'guarded' };
  }).filter(({ count, markerCount }) => count || markerCount);
}

export function patchWebpackSource(source, { ultrafast = false } = {}) {
  const access = apiKeySpeedAccess(ultrafast);
  const found = inspectWebpackSource(source, { ultrafast });
  // Archive-wide expected counts are checked before this plan may be used.
  for (const item of found) if (item.state === 'ambiguous') throw new Error(`Ambiguous webpack speed signature: ${item.id}`);
  let content = source;
  for (const target of targets) {
    if (!found.some(item => item.id === target.id && item.state === 'guarded')) continue;
    content = content.replace(new RegExp(target.guarded, 'g'), (...args) => target.replace(args.at(-1), args[0], access));
    if (inspectWebpackSource(content, { ultrafast }).find(item => item.id === target.id)?.state !== 'patched') {
      throw new Error(`Webpack speed replacement verification failed: ${target.id}`);
    }
  }
  return { content, ids: found.map(item => item.id), labels: found.map(item => item.label) };
}
