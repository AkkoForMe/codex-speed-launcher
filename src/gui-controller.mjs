import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { discoverApp, listAppProcesses } from './platform.mjs';
import { inspectArchive } from './preflight.mjs';
import { launchSession } from './launch.mjs';

export function safeGuiError(error) {
  return String(error?.message ?? error).replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 600);
}

// Only the root model name is displayed. Provider sections, URLs and credentials
// never enter the UI state, and no configuration is written by this module.
export function configuredModel(source) {
  const root = String(source).split(/^\s*\[/m, 1)[0];
  const literal = root.match(/^\s*model\s*=\s*("(?:[^"\\]|\\.)*"|'[^'\r\n]*')\s*(?:#.*)?$/m)?.[1];
  if (!literal) return '未读取';
  try {
    const value = literal.startsWith('"') ? JSON.parse(literal) : literal.slice(1, -1);
    return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/.test(value) ? value : '未读取';
  } catch { return '未读取'; }
}

export function createGuiController(options = {}) {
  const io = {
    discover: () => discoverApp({ appPath: options.appPath }),
    inspect: app => inspectArchive(app.asarPath),
    processes: app => listAppProcesses(app),
    launch: args => launchSession(args),
    readConfig: () => readFile(join(options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml'), 'utf8'),
    sleep, ...options.system,
  };
  let app, session, operation, stopGate, disposed = false;
  const requestedQuits = new WeakSet();
  let state = { title: 'Codex Speed Launcher', version: '—', model: '未读取',
    phase: 'checking', status: '正在检查 Codex…', detail: '', busy: true,
    compatible: false, externalRunning: false, managed: false, closed: false };
  const snapshot = () => ({ ...state });
  const update = fields => { state = { ...state, ...fields }; options.onState?.(snapshot()); };
  const idle = fields => update({ busy: false, ...fields });

  async function inspect() {
    update({ phase: 'checking', status: '正在检查 Codex…', detail: '', busy: true });
    try {
      app = await io.discover();
      const [model, plan, processes] = await Promise.all([
        io.readConfig().then(configuredModel, () => '未读取'), io.inspect(app), io.processes(app),
      ]);
      if (!plan) throw new Error('Compatibility inspection returned no patch plan.');
      idle({ version: app.version, model, compatible: true, externalRunning: processes.length > 0,
        phase: 'ready', status: processes.length ? '请先退出正在运行的 Codex' : '已就绪',
        detail: processes.length ? '保存工作并从 Codex 菜单退出，再点击刷新。' : '启动后，在 Codex 原生菜单选择 Standard / Fast。' });
    } catch (error) {
      idle({ phase: 'error', status: '兼容性检查未通过', compatible: false, detail: safeGuiError(error) });
    }
  }

  function watch(owned) {
    Promise.race([
      owned.child.waitForExit().then(code => ({ code })),
      owned.runtime.lost.then(error => ({ error })),
    ]).catch(error => ({ error })).then(async outcome => {
      // Browser.close also disconnects CDP. A deliberate quit must get its
      // graceful exit window before the loss monitor considers forced cleanup.
      if (stopGate?.session === owned) await stopGate.promise;
      if (session !== owned || disposed) return;
      if (outcome.error && requestedQuits.has(owned)) {
        // A requested quit may disconnect CDP before Electron finishes exiting.
        // Even after the UI timeout, leave the user time to close it normally.
        await owned.child.waitForExit();
        outcome.error = undefined;
      }
      if (outcome.error) {
        // Keep the existing fail-closed runtime behavior when adaptation is lost.
        try { await owned.child.stop(); }
        catch (error) {
          owned.runtime.close();
          idle({ managed: true, phase: 'error', status: '本次 Codex 尚未退出',
            detail: `请手动退出 Codex，或再次点击退出。${safeGuiError(error)}` });
          return;
        }
      }
      if (session !== owned || disposed) return;
      session = undefined;
      owned.runtime.close();
      idle({ managed: false, phase: outcome.error ? 'error' : 'ready',
        status: outcome.error ? '运行连接已中断' : 'Codex 已退出',
        detail: outcome.error ? safeGuiError(outcome.error) : '可再次启动。' });
    }).catch(error => {
      if (session === owned) idle({ phase: 'error', status: '无法确认 Codex 状态', detail: safeGuiError(error) });
    });
  }

  async function start() {
    if (!state.compatible) throw new Error('请先完成兼容性检查。');
    if (state.externalRunning && !session) throw new Error('请先退出正在运行的 Codex，再刷新状态。');
    update({ phase: 'starting', busy: true, status: '正在启动 Codex…', detail: '' });
    // A provider switcher may have updated the model since this window opened.
    update({ model: await io.readConfig().then(configuredModel, () => '未读取') });
    const owned = await io.launch({ app, appPath: options.appPath,
      ...(options.launchOptions ?? {}), log: () => {} });
    session = owned;
    idle({ managed: true, externalRunning: false, phase: 'running', status: '速度菜单已启用',
      detail: '在 Codex 原生菜单选择 Standard / Fast。费用以服务端为准。' });
    watch(owned);
  }

  async function stop() {
    const owned = session;
    if (!owned) return;
    // Browser.close asks Electron to quit normally. Never kill an unrelated app
    // or force a normal restart past a window that declined to close.
    update({ phase: 'stopping', busy: true, status: '正在退出 Codex…', detail: '' });
    requestedQuits.add(owned);
    let release;
    stopGate = { session: owned, promise: new Promise(resolve => { release = resolve; }) };
    try {
      await owned.runtime.closeApp();
      const exited = await Promise.race([
        owned.child.waitForExit().then(() => true), io.sleep(8000, undefined, { ref: false }).then(() => false),
      ]);
      if (!exited) throw new Error('Codex 尚未退出。请在 Codex 中保存工作并退出，再操作。');
      if (session === owned) session = undefined;
      owned.runtime.close();
      update({ managed: false });
    } finally { stopGate = undefined; release(); }
  }

  async function perform(action) {
    if (action === 'refresh') { if (session) return; await inspect(); }
    else if (action === 'start') { if (!session) await start(); }
    else if (action === 'restart') { if (!session) throw new Error('只能重启由本工具启动的 Codex。'); await stop(); await start(); }
    else if (action === 'quit') {
      await stop(); disposed = true;
      idle({ phase: 'closed', managed: false, status: '已退出', closed: true });
    } else throw new Error('未知操作。');
  }

  return {
    snapshot,
    async initialize() { await inspect(); return snapshot(); },
    dispatch(action) {
      if (!['refresh', 'start', 'restart', 'quit'].includes(action)) throw new Error('未知操作。');
      if (disposed || state.closed) throw new Error('启动器已退出。');
      if (operation || state.busy) throw new Error('正在处理，请稍候。');
      if (session && ['refresh', 'start'].includes(action)) throw new Error('本次 Codex 已在运行。');
      update({ busy: true });
      operation = perform(action).catch(error => {
        idle({ managed: !!session, phase: 'error', status: '操作未完成', detail: safeGuiError(error) });
      }).finally(() => { operation = undefined; });
      return operation;
    },
    async dispose() {
      if (operation) await operation;
      try { await stop(); }
      catch (error) {
        // The window crashed or was externally killed. Keep the same ownership
        // checks as CLI cleanup rather than leaving a detached patch runtime.
        await session?.child.stop();
        throw error;
      }
      finally { disposed = true; session?.runtime.close(); }
    },
  };
}
