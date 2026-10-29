import { assertModuleSyntax } from './syntax-check.mjs';
import { openAsar, sha256 } from './asar.mjs';
import { inspectSource, patchSource, REQUIRED_IDS } from './speed-patches.mjs';

export function inspectArchive(asarPath, { checkSyntax = true } = {}) {
  const archive = openAsar(asarPath);
  const matches = new Map(REQUIRED_IDS.map(id => [id, []]));
  const resources = [];
  try {
    for (const entry of archive.files) {
      if (!/^webview\/assets\/[^/]+\.js$/.test(entry.path)) continue;
      const source = archive.read(entry).toString('utf8');
      const found = inspectSource(entry.path, source);
      if (!found.length) continue;
      for (const item of found) {
        if (!matches.has(item.id)) throw new Error(`Unknown patch id: ${item.id}`);
        for (let i = 0; i < item.count; i++) matches.get(item.id).push(entry.path);
      }
      const patched = patchSource(entry.path, source);
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
      if (paths.length !== 1) {
        throw new Error(`Unsupported Codex build: ${id} matched ${paths.length} times (expected 1). App unchanged.`);
      }
    }
    return { ...archive.fingerprint(), resources, requiredIds: [...REQUIRED_IDS] };
  } finally { archive.close(); }
}

export function publicInspection(app, plan) {
  return {
    version: app.version, platform: app.platform, executable: app.executable,
    asarPath: app.asarPath, asarSha256: plan.sha256,
    compatibility: 'signature-compatible',
    macOSStatus: app.platform === 'darwin' ? 'experimental; no real Mac validation' : undefined,
    patches: plan.resources.map(({ archivePath, ids, labels, sourceHash, patchedHash }) => ({ archivePath, ids, labels, sourceHash, patchedHash }))
  };
}
