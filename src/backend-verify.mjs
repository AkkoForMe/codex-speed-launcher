import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { isAbsolute, join, posix, win32 } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const MODEL = 'gpt-6.1-sol';
const MARKER = 'SPEED_TEST_OK';
const DUMMY_KEY = 'local-verification-dummy-key';

function safeError(value) {
  return String(value || 'unknown error').replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 800);
}

/** This verifier is deliberately restricted to our generated dummy configuration. */
export function validateMockConfig(source, env) {
  const provider = source.match(/^model_provider\s*=\s*["']([^"']+)["']\s*$/m)?.[1];
  if (provider !== 'speed_mock') throw new Error('Backend verification requires the isolated speed_mock provider.');
  const table = source.match(/^\[model_providers\.speed_mock\]\s*\r?\n([^]*?)(?=^\[|$(?![^]))/m)?.[1];
  if (!table) throw new Error('The local verification provider table is missing.');
  const base = table.match(/^base_url\s*=\s*["']([^"']+)["']\s*$/m)?.[1];
  let url;
  try { url = new URL(base); } catch { throw new Error('The verification relay URL is invalid.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || !url.port) {
    throw new Error('Backend verification may only contact a numeric loopback mock relay.');
  }
  if (!/^env_key\s*=\s*["']CODEX_SPEED_MOCK_KEY["']\s*$/m.test(table)
    || env.CODEX_SPEED_MOCK_KEY !== DUMMY_KEY
    || !/^requires_openai_auth\s*=\s*false\s*$/m.test(table)) {
    throw new Error('Backend verification requires the generated dummy credential and API-key provider.');
  }
  return { provider, url: url.href };
}

class StdioRpc {
  constructor(child, { timeoutMs = 30_000 } = {}) {
    this.child = child; this.timeoutMs = timeoutMs; this.sequence = 0;
    this.pending = new Map(); this.notifications = []; this.waiters = new Set();
    this.buffer = ''; this.closed = false; this.deniedRequests = 0;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      this.buffer += chunk;
      if (this.buffer.length > 8 * 1024 * 1024) {
        this.fail(new Error('App-server diagnostic output exceeded its limit.')); return;
      }
      let newline;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        this.receive(message);
      }
    });
    // stderr is drained, but may contain local paths or provider information.
    // It is intentionally excluded from the distributable verification report.
    child.stderr?.resume();
    child.once('error', error => this.fail(new Error(`App-server failed to start: ${safeError(error.message)}`)));
    child.once('exit', () => this.fail(new Error('App-server exited before the diagnostic completed.')));
    child.stdin.on('error', error => this.fail(new Error(`App-server input failed: ${safeError(error.message)}`)));
  }

  write(message) {
    if (this.closed) throw new Error('App-server diagnostic transport is closed.');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  receive(message) {
    if (message.method && message.id != null) {
      // Never approve tools, filesystem actions or account operations requested
      // by the diagnostic server. The mock response itself contains no tools.
      this.deniedRequests++;
      this.write({ jsonrpc: '2.0', id: message.id,
        error: { code: -32601, message: 'Unsupported in isolated local verification.' } });
      return;
    }
    if (message.id != null) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`${pending.method}: ${safeError(message.error.message || message.error.code)}`));
      else pending.resolve(message.result);
      return;
    }
    this.notifications.push(message);
    if (this.notifications.length > 10_000) {
      this.fail(new Error('App-server emitted too many diagnostic notifications.')); return;
    }
    for (const waiter of [...this.waiters]) {
      if (waiter.predicate(message)) {
        this.waiters.delete(waiter); clearTimeout(waiter.timer); waiter.resolve(message);
      }
    }
  }

  request(method, params) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error(`${method} timed out after ${this.timeoutMs} ms.`));
      }, this.timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try { this.write({ jsonrpc: '2.0', id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  waitFor(predicate, fromIndex = 0) {
    const existing = this.notifications.slice(fromIndex).find(predicate);
    if (existing) return Promise.resolve(existing);
    if (this.closed) return Promise.reject(new Error('App-server diagnostic transport is closed.'));
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: undefined };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter); reject(new Error(`Turn completion timed out after ${this.timeoutMs} ms.`));
      }, this.timeoutMs);
      this.waiters.add(waiter);
    });
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    for (const waiter of this.waiters) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.pending.clear(); this.waiters.clear();
  }
}

function fastMetadata(model) {
  return /(?:priority|fast)/i.test(JSON.stringify([model.serviceTiers, model.additionalSpeedTiers]));
}

function backendEnvironment(env, codexHome) {
  const result = { ...env, CODEX_HOME: codexHome,
    NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1',
    OTEL_SDK_DISABLED: 'true' };
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy',
    'CODEX_AUTHAPI_BASE_URL', 'CODEX_ACCESS_TOKEN', 'CODEX_API_KEY', 'OPENAI_BASE_URL',
    'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'CODEX_WINDOWS_REGISTERED_CORE']) delete result[name];
  // Avoid an inherited official API credential even if core auth changes later.
  result.OPENAI_API_KEY = DUMMY_KEY;
  return result;
}

/** Run only a fresh bundled core, against the generated loopback mock provider. */
export async function verifyBackend(app, {
  codexHome, cwd, env = process.env, captures, log = () => {},
  timeoutMs = 30_000, system = {}, signal,
} = {}) {
  signal?.throwIfAborted();
  if (!isAbsolute(codexHome || '') || !isAbsolute(cwd || '')) {
    throw new Error('Backend verification requires absolute isolated CODEX_HOME and workspace paths.');
  }
  if (!Array.isArray(captures)) throw new Error('Backend verification requires local mock captures.');
  const io = { spawn, readFile: path => readFile(path, 'utf8'), access, sleep, ...system };
  const source = await io.readFile(join(codexHome, 'config.toml'));
  signal?.throwIfAborted();
  const config = validateMockConfig(source, env);
  const paths = app.platform === 'win32' ? win32 : posix;
  const executable = app.platform === 'win32'
    ? paths.join(paths.dirname(app.executable), 'resources', 'codex.exe')
    : paths.join(app.root, 'Contents/Resources/codex');
  await io.access(executable);
  signal?.throwIfAborted();
  const child = io.spawn(executable, ['app-server', '--stdio'], {
    cwd, env: backendEnvironment(env, codexHome), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  let exited = false;
  const exit = new Promise(resolve => {
    child.once('exit', () => { exited = true; resolve(); });
    child.once('error', () => { exited = true; resolve(); });
  });
  const rpc = new StdioRpc(child, { timeoutMs });
  const onAbort = () => rpc.fail(signal.reason ?? new Error('Backend verification cancelled.'));
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const rows = [];
  const report = { ok: false, model: MODEL, sameThread: true, localOnly: true,
    dummyCredentials: true, marker: MARKER, rows };
  try {
    log('Checking the bundled Codex core against the local dummy relay.');
    const initialized = await rpc.request('initialize', {
      clientInfo: { name: 'codex_desktop', title: 'Codex Speed Launcher local verification', version: '0.1.1' },
      capabilities: { experimentalApi: true },
    });
    rpc.write({ jsonrpc: '2.0', method: 'initialized' });
    // Readiness is a query only. In particular, never call setupStart here: a
    // desktop with an unconfigured sandbox may auto-provision machine resources.
    // The caller must require ready before starting the Windows GUI verifier.
    if (app.platform === 'win32') {
      const readiness = await rpc.request('windowsSandbox/readiness');
      const status = readiness?.status;
      if (!['ready', 'notConfigured', 'updateRequired'].includes(status)) {
        throw new Error('The bundled core returned an unknown Windows sandbox readiness status.');
      }
      report.sandboxReadiness = status;
      report.guiPreflightReady = status === 'ready';
      log(`Windows sandbox readiness (query only): ${status}.`);
    } else {
      report.sandboxReadiness = 'notApplicable';
      report.guiPreflightReady = true;
    }
    const list = await rpc.request('model/list', { includeHidden: false });
    const model = (list.data || []).find(item => item.model === MODEL || item.id === MODEL);
    if (!model || !fastMetadata(model)) throw new Error('The bundled core does not advertise Fast for the diagnostic model.');
    const thread = await rpc.request('thread/start', {
      model: MODEL, modelProvider: config.provider, cwd, approvalPolicy: 'never',
      sandbox: 'read-only', ephemeral: true,
      config: { model_reasoning_effort: 'low', service_tier: 'default', web_search: 'disabled',
        'features.shell_tool': false, 'features.apps': false, 'features.hooks': false,
        'features.remote_plugin': false },
    });
    const threadId = thread.thread?.id;
    if (!threadId) throw new Error('The bundled core did not create a diagnostic thread.');
    for (const [label, requestedTier] of [['Standard', null], ['Fast', 'priority'], ['Standard', null]]) {
      const notificationStart = rpc.notifications.length, captureStart = captures.length;
      const started = await rpc.request('turn/start', {
        threadId, model: MODEL, serviceTier: requestedTier,
        input: [{ type: 'text', text: `Local speed test ${rows.length + 1}. Reply with ${MARKER} only. Do not use tools.` }],
      });
      const turnId = started.turn?.id;
      const completed = await rpc.waitFor(message => message.method === 'turn/completed'
        && message.params?.threadId === threadId
        && (!turnId || message.params?.turn?.id === turnId), notificationStart);
      const turn = completed.params?.turn;
      const answer = rpc.notifications.slice(notificationStart)
        .filter(message => message.method === 'item/completed' && message.params?.threadId === threadId)
        .map(message => message.params?.item).filter(item => item?.type === 'agentMessage')
        .map(item => item.text || '').join('');
      const requests = captures.slice(captureStart);
      const captured = requests[0];
      const tierMatches = requestedTier === 'priority' ? captured?.serviceTier === 'priority'
        : captured && [null, undefined, 'default', 'standard'].includes(captured.serviceTier);
      const row = { label, model: MODEL, requestedTier, capturedTier: captured?.serviceTier ?? null,
        requestCount: requests.length, turnStatus: turn?.status ?? null,
        answerOK: answer.trim() === MARKER, sameModel: requests.every(request => request.model === MODEL),
        ok: turn?.status === 'completed' && answer.trim() === MARKER && requests.length === 1
          && captured?.model === MODEL && tierMatches };
      rows.push(row);
      if (!row.ok) throw new Error(`${label} diagnostic failed: status=${row.turnStatus}, requests=${row.requestCount}, capturedTier=${row.capturedTier}.`);
      log(`Bundled core ${label}: ${captured.serviceTier ?? 'default'}; same model; ${MARKER}.`);
    }
    Object.assign(report, {
      ok: rows.every(row => row.ok), backendVersion: initialized.userAgent || initialized.serverInfo?.version || null,
      advertisedFast: true, serviceTiers: model.serviceTiers ?? null,
      additionalSpeedTiers: model.additionalSpeedTiers ?? null,
      deniedServerRequests: rpc.deniedRequests,
    });
  } catch (error) {
    report.error = safeError(error.message);
    report.deniedServerRequests = rpc.deniedRequests;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    rpc.fail(new Error('Backend verification finished.'));
    child.stdin.end();
    if (!exited) child.kill();
    await Promise.race([exit, io.sleep(2000)]);
    if (!exited) {
      child.kill('SIGKILL');
      await Promise.race([exit, io.sleep(500)]);
    }
    report.coreStopped = exited;
    if (!exited) {
      report.ok = false;
      report.cleanupError = 'The diagnostic core did not report exit after termination.';
    }
    // A core helper can briefly inherit stdio on Windows. Diagnostic listeners
    // no longer need these pipes after cleanup, so do not keep the launcher alive.
    child.stdin.destroy(); child.stdout.destroy(); child.stderr?.destroy();
    child.unref?.();
  }
  if (signal?.aborted) {
    if (report.cleanupError) {
      throw new AggregateError([signal.reason, new Error(report.cleanupError)],
        'Backend verification cancelled and core cleanup needs attention.');
    }
    signal.throwIfAborted();
  }
  return report;
}
