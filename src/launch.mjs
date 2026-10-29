import net from 'node:net';
import { discoverApp, assertAppIdle, launchApp } from './platform.mjs';
import { inspectArchive } from './preflight.mjs';
import { openAsar } from './asar.mjs';
import { startRuntime } from './runtime.mjs';

export async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

export function assertArchiveUnchanged(app, plan) {
  const archive = openAsar(app.asarPath);
  try {
    if (archive.fingerprint().sha256 !== plan.sha256) throw new Error('Codex changed after inspection. Start the launcher again.');
  } finally { archive.close(); }
}

export async function launchSession({ app: supplied, appPath, isolatedDir, codexHome, env, signal, log = () => {} } = {}) {
  const app = supplied ?? await discoverApp({ appPath });
  if (!isolatedDir) await assertAppIdle(app);
  log(`Inspecting Codex ${app.version} (${app.platform})...`);
  const plan = inspectArchive(app.asarPath);
  signal?.throwIfAborted();
  const port = await availablePort();
  assertArchiveUnchanged(app, plan);
  const child = await launchApp(app, { port, isolatedDir, codexHome, env });
  let runtime;
  try {
    runtime = await startRuntime(port, plan, { log, signal });
    assertArchiveUnchanged(app, plan);
    return { app, plan, port, child, runtime };
  } catch (error) {
    runtime?.close();
    try { await child.stop(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Launch failed and child cleanup needs attention.'); }
    throw error;
  }
}

export async function runLauncher(options = {}) {
  const log = options.log ?? console.log;
  const controller = new AbortController();
  const onSignal = () => controller.abort(new Error('Launch cancelled.'));
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  let session;
  try {
    session = await launchSession({ ...options, log, signal: controller.signal });
    log('Native Fast controls and request tier are active.');
    log('Keep this launcher open. Quit Codex to finish. Ctrl+C closes this launched Codex session.');
    const outcome = await Promise.race([
      session.child.waitForExit().then(code => ({ type: 'exit', code })),
      session.runtime.lost.then(error => ({ type: 'lost', error }))
    ]);
    if (outcome.type !== 'exit') {
      if (controller.signal.aborted) await session.runtime.closeApp();
      await session.child.stop();
    }
    if (controller.signal.aborted) return 130;
    if (outcome.type === 'lost') throw outcome.error;
    return outcome.code ?? 0;
  } catch (error) {
    try { await session?.child.stop(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Session failed and child cleanup needs attention.'); }
    if (controller.signal.aborted && !(error instanceof AggregateError)) return 130;
    throw error;
  } finally {
    process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
    session?.runtime.close();
  }
}
