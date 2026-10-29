#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { discoverApp } from './platform.mjs';
import { inspectArchive, publicInspection } from './preflight.mjs';
import { runLauncher } from './launch.mjs';

const help = `Codex Speed Launcher 0.1.1

  inspect [--app PATH] [--json]   Read-only compatibility check
  launch  [--app PATH]            Start native Fast controls using your existing config
  verify  [--app PATH] [--json]    Isolated local mock test; no real API key or usage

Windows x64: tested builds are listed in README.md.
macOS: experimental; requires matching renderer signatures and official app signing.
This launcher preserves config.toml, auth.json, models, and provider URLs.
Fully quit Codex before normal launch. No running app is automatically stopped.
`;

export async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    app: { type: 'string' }, json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' },
    artifacts: { type: 'string' }
  } });
  if (values.version) { console.log('0.1.1'); return 0; }
  if (values.help || !positionals.length) { console.log(help); return 0; }
  const [command, ...rest] = positionals;
  if (rest.length || !['inspect', 'launch', 'verify'].includes(command)) throw new Error('Unknown command. Use --help.');
  if (command === 'inspect') {
    const app = await discoverApp({ appPath: values.app });
    const result = publicInspection(app, inspectArchive(app.asarPath));
    if (values.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Codex ${result.version} (${result.platform}): signature-compatible`);
      for (const patch of result.patches) for (const label of patch.labels) console.log(`  OK ${label}`);
      console.log('Installed app and your settings were not changed.');
      if (result.macOSStatus) console.log(result.macOSStatus);
    }
    return 0;
  }
  if (command === 'verify') {
    const { verifyInstalledApp } = await import('./verify.mjs');
    const report = await verifyInstalledApp({ appPath: values.app, artifacts: values.artifacts,
      log: values.json ? () => {} : console.log });
    console.log(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  }
  if (values.json) throw new Error('--json is supported by inspect and verify only.');
  return runLauncher({ appPath: values.app });
}

// Kept importable for source and package tests.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }, error => {
    console.error(`Codex Speed Launcher: ${error.message}`);
    if (error instanceof AggregateError) for (const cause of error.errors) console.error(`  ${cause.message}`);
    process.exitCode = 1;
  });
}
