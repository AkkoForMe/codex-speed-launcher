import { assertModuleSyntax } from './syntax-check.mjs';
import { openAsar, sha256 } from './asar.mjs';
import { inspectSource, patchSource, REQUIRED_IDS } from './speed-patches.mjs';
import { inspectWebpackSource, patchWebpackSource, WEBPACK_PROFILE } from './webpack-speed-patches.mjs';

// Kept separate from file opening so archive contracts can be checked against
// handwritten fixtures. The live path always uses the read-only ASAR reader.
export function inspectOpenArchive(archive, { checkSyntax = true } = {}) {
  const fingerprint = archive.fingerprint();
  const webpack = fingerprint.sha256 === WEBPACK_PROFILE.sha256;
  const expectedCounts = webpack ? WEBPACK_PROFILE.counts : Object.fromEntries(REQUIRED_IDS.map(id => [id, 1]));
  const matches = new Map(REQUIRED_IDS.map(id => [id, []]));
  const resources = [];
  const allowedPath = webpack ? /^webview\/assets\/async\/[^/]+\.js$/ : /^webview\/assets\/[^/]+\.js$/;
  for (const entry of archive.files) {
    if (!allowedPath.test(entry.path)) continue;
    const source = archive.read(entry).toString('utf8');
    const found = webpack ? inspectWebpackSource(source) : inspectSource(entry.path, source);
    if (!found.length) continue;
    for (const item of found) {
      if (!matches.has(item.id)) throw new Error(`Unknown patch id: ${item.id}`);
      for (let i = 0; i < item.count; i++) matches.get(item.id).push(entry.path);
    }
    const patched = webpack ? patchWebpackSource(source) : patchSource(entry.path, source);
    if (!patched.ids.length || patched.content === source) throw new Error(`No replacement for ${entry.path}.`);
    if (checkSyntax) {
      try { assertModuleSyntax(patched.content); }
      catch (error) { throw new Error(`Patched JavaScript failed syntax validation: ${entry.path}`, { cause: error }); }
    }
    resources.push({
      archivePath: entry.path,
      runtimePath: entry.path.replace(/^webview\//, ''),
      ids: patched.ids, labels: patched.labels,
      sourceHash: sha256(source), patchedHash: sha256(patched.content),
      content: patched.content
    });
  }
  for (const [id, paths] of matches) {
    if (paths.length !== expectedCounts[id]) {
      throw new Error(`Unsupported Codex build: ${id} matched ${paths.length} times (expected ${expectedCounts[id]}). App unchanged.`);
    }
  }
  const finalFingerprint = archive.fingerprint();
  if (finalFingerprint.sha256 !== fingerprint.sha256) throw new Error('Codex changed during inspection. App unchanged.');
  return { ...finalFingerprint, resources, requiredIds: [...REQUIRED_IDS],
    rendererProfile: webpack ? `webpack-${WEBPACK_PROFILE.version}` : 'service-tier-26.1023' };
}

export function inspectArchive(asarPath, options) {
  const archive = openAsar(asarPath);
  try { return inspectOpenArchive(archive, options); }
  finally { archive.close(); }
}

export function publicInspection(app, plan) {
  return {
    version: app.version, platform: app.platform, executable: app.executable,
    asarPath: app.asarPath, asarSha256: plan.sha256,
    compatibility: 'signature-compatible',
    rendererProfile: plan.rendererProfile,
    macOSStatus: app.platform === 'darwin' ? 'experimental; no real Mac validation' : undefined,
    patches: plan.resources.map(({ archivePath, ids, labels, sourceHash, patchedHash }) => ({ archivePath, ids, labels, sourceHash, patchedHash }))
  };
}
