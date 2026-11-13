import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createGuiController, safeGuiError } from './gui-controller.mjs';
import { startGuiBridge } from './gui.mjs';

// Test mode is an explicit executable argument. It never reads a user's Codex
// installation, home directory, credentials, or configuration.
export function createMacSelfTestController() {
  const stats = { inspections: 0, launches: 0, closes: 0, forcedStops: 0 };
  const controller = createGuiController({ system: {
    discover: async () => { stats.inspections++; return { version: 'Mock 1.0', asarPath: 'mock-only' }; },
    inspect: () => ({ requiredIds: ['mock'] }), processes: async () => [],
    readConfig: async () => 'model="gpt-6.1-sol"',
    sleep: async () => {},
    launch: async () => {
      stats.launches++;
      let exit;
      const exited = new Promise(resolveExit => { exit = resolveExit; });
      return {
        child: { waitForExit: () => exited, stop: async () => { stats.forcedStops++; exit(0); } },
        runtime: { lost: new Promise(() => {}), close() {}, closeApp: async () => {
          stats.closes++;
          // First close deliberately times out, exercising the real retention
          // path. The next deliberate close succeeds without forced cleanup.
          if (stats.closes > 1) exit(0);
        } },
      };
    },
  } });
  return { ...controller, snapshot: () => ({ ...controller.snapshot(), selfTestStats: { ...stats } }) };
}

export async function runMacBackend({ selfTest = false, input = process.stdin, output = process.stdout,
  controller = selfTest ? createMacSelfTestController() : createGuiController({ appPath: process.env.CODEX_SPEED_APP_PATH }),
  onError = error => { console.error(safeGuiError(error)); process.exitCode = 1; },
} = {}) {
  const bridge = await startGuiBridge(controller);
  let finishing;
  const finish = () => finishing ??= (async () => {
    try { await controller.dispose(); }
    finally { await bridge.close(); }
  })();
  // Parent .app owns this private pipe. Never copy the handshake to logs,
  // command-line arguments, reports, preferences, or an on-disk file.
  output.write(`${JSON.stringify({ endpoint: bridge.endpoint, token: bridge.token })}\n`);
  const parentClosed = () => { finish().catch(onError); };
  input.once('end', parentClosed);
  input.once('error', parentClosed);
  input.resume();
  const terminate = () => { input.destroy(); parentClosed(); };
  process.once('SIGTERM', terminate);
  process.once('SIGINT', terminate);
  await controller.initialize();
  return { controller, bridge, close: async () => {
    input.removeListener('end', parentClosed);
    input.removeListener('error', parentClosed);
    process.removeListener('SIGTERM', terminate);
    process.removeListener('SIGINT', terminate);
    input.pause();
    await finish();
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== '--self-test')) {
    console.error('Unknown backend argument.'); process.exitCode = 1;
  } else runMacBackend({ selfTest: args[0] === '--self-test' }).catch(error => {
    console.error(safeGuiError(error)); process.exitCode = 1;
  });
}
