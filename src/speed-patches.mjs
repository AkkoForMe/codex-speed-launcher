/**
 * Narrow renderer adaptations for the 26.1023 service-tier architecture.
 *
 * No provider, model, credential, catalog, plugin or updater changes are made.
 * Callers must enforce archive-wide uniqueness, exact resource/body hashes and
 * required-target completeness before permitting a patched app to run.
 */

const ID = '[A-Za-z_$][\\w$]*';
const KEY_ACCESS = '{fast:!0,ultrafast:!1}';
const marker = (id) => `/*codex-speed-launcher:${id}*/`;
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const expression = (source) => new RegExp(source, 'g');

// Match the account-gated hook using its semantic fields and short bounded
// bridge, never a build-specific chunk hash or minifier-specific symbol name.
const hookContext =
  `(?<prefix>(?<account>${ID})=${ID}\\(${ID}\\),` +
  `(?<eligible>${ID})=\\k<account>\\?\\.authMethod===\u0060chatgpt\u0060\\|\\|` +
  `\\k<account>\\?\\.authMethod===\u0060personalAccessToken\u0060\\|\\|` +
  `\\k<account>\\?\\.authMethod===\u0060amazonBedrock\u0060,` +
  `(?:(?!function )[\\s\\S]){0,1000}?)`;

const hookDependencies =
  `(?<cache>${ID})\\[3\\]!==(?<data>${ID})\\|\\|\\k<cache>\\[4\\]!==(?<loading>${ID})` +
  `\\|\\|\\k<cache>\\[5\\]!==\\k<eligible>\\?\\((?<result>${ID})=`;
const hookPatchedDependencies =
  `(?<cache>${ID})\\[3\\]!==(?<data>${ID})\\|\\|\\k<cache>\\[4\\]!==(?<loading>${ID})` +
  `\\|\\|\\k<cache>\\[5\\]!==\\(\\k<account>\\?\\.authMethod\\?\\?null\\)\\?\\((?<result>${ID})=`;
const hookTail =
  `,\\k<cache>\\[3\\]=\\k<data>,\\k<cache>\\[4\\]=\\k<loading>,\\k<cache>\\[5\\]=\\k<eligible>,` +
  `\\k<cache>\\[6\\]=\\k<result>\\):\\k<result>=\\k<cache>\\[6\\]`;
const hookPatchedTail =
  `,\\k<cache>\\[3\\]=\\k<data>,\\k<cache>\\[4\\]=\\k<loading>,\\k<cache>\\[5\\]=` +
  `\\(\\k<account>\\?\\.authMethod\\?\\?null\\),\\k<cache>\\[6\\]=\\k<result>\\):` +
  `\\k<result>=\\k<cache>\\[6\\]`;

const hookGuard = hookContext + hookDependencies +
  `\\k<eligible>&&!\\k<loading>&&\\k<data>!=null\\?` +
  `(?<normalize>${ID})\\(\\k<data>\\):null` + hookTail;

const hookPatched = hookContext + hookPatchedDependencies +
  escapeRegExp(marker('api-key-service-tier-access')) +
  `\\(!\\k<loading>&&\\(\\k<account>\\?\\.authMethod==null\\|\\|` +
  `\\k<account>\\.authMethod===\u0060apikey\u0060\\)\\?` +
  escapeRegExp(KEY_ACCESS) +
  `:\\k<eligible>&&!\\k<loading>&&\\k<data>!=null\\?` +
  `(?<normalize>${ID})\\(\\k<data>\\):null\\)` + hookPatchedTail;

const requestPrefix =
  `(?<prefix>async function ${ID}\\((?<store>${ID}),(?<host>${ID})\\)\\{` +
  `let (?<auth>${ID})=await ${ID}\\(\\k<store>,\\k<host>\\);)`;
const requestBody =
  `if\\(\\k<auth>!==\u0060chatgpt\u0060&&` +
  `\\k<auth>!==\u0060personalAccessToken\u0060&&` +
  `\\k<auth>!==\u0060amazonBedrock\u0060\\)return null;` +
  `let (?<data>${ID})=await (?<read>${ID})\\(\\k<store>,\\k<host>,` +
  `\\{priority:\u0060critical\u0060\\}\\);return \\k<store>\\.query\\.setData\\(` +
  `(?<query>${ID}),\\{authMethod:\\k<auth>,hostId:\\k<host>\\},\\k<data>\\),` +
  `(?<normalize>${ID})\\(\\k<data>\\)\\}`;

const targets = [
  {
    id: 'api-key-service-tier-access',
    label: 'API key native speed controls',
    needle: 'serviceTierAccess:',
    guarded: hookGuard,
    patched: hookPatched,
    replace(g) {
      // The original dependency used only "managed auth or not". The new
      // expression distinguishes API keys from other non-managed auth modes;
      // use the auth method in that same cache slot to avoid a stale result
      // after changing authentication. No additional React cache slots are used.
      return `${g.prefix}${g.cache}[3]!==${g.data}||${g.cache}[4]!==${g.loading}||` +
        `${g.cache}[5]!==(${g.account}?.authMethod??null)?(${g.result}=${marker(this.id)}(!${g.loading}&&` +
        `(${g.account}?.authMethod==null||${g.account}.authMethod===\u0060apikey\u0060)` +
        `?${KEY_ACCESS}:${g.eligible}&&!${g.loading}&&${g.data}!=null?` +
        `${g.normalize}(${g.data}):null),${g.cache}[3]=${g.data},${g.cache}[4]=${g.loading},` +
        `${g.cache}[5]=(${g.account}?.authMethod??null),${g.cache}[6]=${g.result}):` +
        `${g.result}=${g.cache}[6]`;
    },
  },
  {
    id: 'api-key-request-tier-access',
    label: 'API key request service tier',
    needle: 'Failed to read service tier for request',
    guarded: requestPrefix + requestBody,
    patched: requestPrefix + escapeRegExp(marker('api-key-request-tier-access')) +
      `if\\(\\k<auth>==null\\|\\|\\k<auth>===\u0060apikey\u0060\\)return ` +
      escapeRegExp(KEY_ACCESS) + `;` + requestBody,
    replace(g) {
      return `${g.prefix}${marker(this.id)}if(${g.auth}==null||${g.auth}===\u0060apikey\u0060)` +
        `return ${KEY_ACCESS};if(${g.auth}!==\u0060chatgpt\u0060&&` +
        `${g.auth}!==\u0060personalAccessToken\u0060&&${g.auth}!==\u0060amazonBedrock\u0060)` +
        `return null;let ${g.data}=await ${g.read}(${g.store},${g.host},` +
        `{priority:\u0060critical\u0060});return ${g.store}.query.setData(${g.query},` +
        `{authMethod:${g.auth},hostId:${g.host}},${g.data}),${g.normalize}(${g.data})}`;
    },
  },
];

export const REQUIRED_IDS = Object.freeze(targets.map(({ id }) => id));

function eligibleResource(path) {
  // Paths supplied by the ASAR reader or the renderer's app:// resource URL.
  // A network page can never receive these transformations.
  const pathText = String(path);
  if (/^[a-z][a-z0-9+.-]*:/i.test(pathText) && !pathText.startsWith('app://')) return false;
  return /(?:^|\/)(?:webview\/)?assets\/[^/?#]+\.js(?:[?#].*)?$/.test(pathText);
}

function inspectTarget(target, source) {
  if (!source.includes(target.needle)) return null;
  const guardedCount = [...source.matchAll(expression(target.guarded))].length;
  const patchedCount = [...source.matchAll(expression(target.patched))].length;
  const count = guardedCount + patchedCount;
  const markerCount = source.split(marker(target.id)).length - 1;
  if (count === 0 && markerCount === 0) return null;
  return {
    id: target.id,
    label: target.label,
    count,
    guardedCount,
    patchedCount,
    state: count !== 1 || markerCount !== patchedCount ? 'ambiguous' :
      patchedCount === 1 ? 'patched' : 'guarded',
  };
}

/** Return local match counts. The caller must sum each id across the archive. */
export function inspectSource(path, source) {
  if (!eligibleResource(path)) return [];
  return targets.map((target) => inspectTarget(target, source)).filter(Boolean);
}

/** Patch only unambiguous complete signatures in a renderer JavaScript body. */
export function patchSource(path, source) {
  const matches = inspectSource(path, source);
  const ambiguous = matches.find(({ count, state }) => count !== 1 || state === 'ambiguous');
  if (ambiguous) throw new Error(`Ambiguous speed signature: ${ambiguous.id}`);
  let content = source;
  const appliedIds = [];
  for (const target of targets) {
    if (!matches.some(({ id, state }) => id === target.id && state === 'guarded')) continue;
    content = content.replace(expression(target.guarded), (...args) => target.replace(args.at(-1)));
    const after = inspectTarget(target, content);
    if (after?.count !== 1 || after?.state !== 'patched') {
      throw new Error(`Speed replacement verification failed: ${target.id}`);
    }
    appliedIds.push(target.id);
  }
  return {
    content,
    ids: matches.map(({ id }) => id),
    labels: matches.map(({ label }) => label),
    appliedIds,
    alreadyPatchedIds: matches.filter(({ state }) => state === 'patched').map(({ id }) => id),
  };
}
