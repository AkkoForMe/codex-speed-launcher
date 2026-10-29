import { setTimeout as sleep } from 'node:timers/promises';
import { sha256 } from './asar.mjs';
import { CdpConnection } from './cdp.mjs';

export function resourceForUrl(resourceUrl, resources, expectedOrigin) {
  try {
    const url = new URL(resourceUrl);
    const origin = `${url.protocol}//${url.host}`;
    if (url.protocol !== 'app:' || origin !== expectedOrigin) return null;
    const path = decodeURIComponent(url.pathname).replace(/^\//, '');
    return resources.find(item => path === item.runtimePath || path === item.archivePath) ?? null;
  } catch { return null; }
}

export async function fulfillPatchedResource(cdp, params, sessionId, resource) {
  if (params.responseErrorReason || params.responseStatusCode !== 200) {
    throw new Error(`Codex resource did not load: ${resource.runtimePath}`);
  }
  const result = await cdp.send('Fetch.getResponseBody', { requestId: params.requestId }, sessionId);
  const bytes = Buffer.from(result.body, result.base64Encoded ? 'base64' : 'utf8');
  const hash = sha256(bytes);
  if (hash !== resource.sourceHash && hash !== resource.patchedHash) {
    throw new Error(`Codex resource changed since inspection: ${resource.runtimePath}`);
  }
  if (sha256(resource.content) !== resource.patchedHash) throw new Error('Patch plan content integrity mismatch.');
  const headers = (params.responseHeaders ?? []).filter(header =>
    !['content-length', 'content-encoding', 'transfer-encoding', 'etag'].includes(header.name.toLowerCase()));
  await cdp.send('Fetch.fulfillRequest', {
    requestId: params.requestId, responseCode: 200,
    responseHeaders: headers, body: Buffer.from(resource.content).toString('base64')
  }, sessionId);
  return resource.ids;
}

export async function startRuntime(port, plan, { timeout = 45_000, log = () => {}, connection, signal } = {}) {
  signal?.throwIfAborted();
  const cdp = connection ?? await CdpConnection.connect(port, { signal });
  const sessions = new Map();
  const observed = new Set();
  let closed = false;
  let fatalError;
  let mainSession;
  let resolveLost;
  let rendererGoneAt;
  const lost = new Promise(resolve => { resolveLost = resolve; });
  const fail = error => {
    if (closed || fatalError) return;
    fatalError = error instanceof Error ? error : new Error(String(error));
    resolveLost(fatalError);
  };
  const onAbort = () => fail(signal.reason ?? new Error('Launch cancelled.'));
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  cdp.on('disconnected', fail);
  cdp.on('Fetch.requestPaused', (params, sessionId) => {
    const sourceSession = sessions.get(sessionId);
    const task = async () => {
      const session = sessions.get(sessionId);
      const resource = session && resourceForUrl(params.request.url, plan.resources, session.origin);
      if (!resource) {
        await cdp.send('Fetch.continueRequest', { requestId: params.requestId }, sessionId);
        return;
      }
      try {
        const ids = await fulfillPatchedResource(cdp, params, sessionId, resource);
        for (const id of ids) { observed.add(id); session.observed.add(id); }
      } catch (error) {
        await cdp.send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'BlockedByClient' }, sessionId).catch(() => {});
        throw error;
      }
    };
    task().catch(error => {
      if (sourceSession && sessions.get(sessionId) === sourceSession && !closed) fail(error);
    });
  });

  async function evaluate(expression, sessionId = mainSession, { awaitPromise = true } = {}) {
    if (!sessionId) throw new Error('Codex renderer not ready.');
    const result = await cdp.send('Runtime.evaluate', {
      expression, awaitPromise, returnByValue: true, userGesture: true
    }, sessionId, 15_000);
    if (result.exceptionDetails) throw new Error(`Renderer evaluation failed: ${result.exceptionDetails.text ?? 'exception'}`);
    return result.result?.value;
  }

  cdp.on('Target.attachedToTarget', params => {
    const setup = async () => {
      const { sessionId, targetInfo, waitingForDebugger } = params;
      if (targetInfo.type !== 'page') {
        if (waitingForDebugger) await cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId);
        return;
      }
      let origin;
      if (targetInfo.url.startsWith('app://')) {
        const parsed = new URL(targetInfo.url);
        origin = `app://${parsed.host}`;
      } else if (waitingForDebugger && (!targetInfo.url || targetInfo.url === 'about:blank')) {
        origin = 'app://-';
      } else {
        if (waitingForDebugger) await cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId);
        return;
      }
      if (sessions.has(sessionId)) return;
      const session = { origin, observed: new Set(), ready: false };
      sessions.set(sessionId, session);
      log('Attaching native Codex renderer.');
      await cdp.send('Fetch.enable', { patterns: [
        { urlPattern: `${origin}/assets/*.js`, requestStage: 'Response' },
        { urlPattern: `${origin}/webview/assets/*.js`, requestStage: 'Response' }
      ] }, sessionId);
      if (sessions.get(sessionId) !== session || closed) return;
      if (waitingForDebugger) await cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId);
      await cdp.send('Page.enable', {}, sessionId);
      if (!waitingForDebugger) await cdp.send('Page.reload', { ignoreCache: true }, sessionId);
      // Wait for the new execution context, then preload every checked resource.
      // This verifies lazy resources without executing their modules ourselves.
      for (let attempt = 0; attempt < 100; attempt++) {
        if (fatalError || closed || sessions.get(sessionId) !== session) return;
        try {
          const here = await evaluate('({url:location.href,ready:document.readyState})', sessionId);
          if (here?.url.startsWith(`${origin}/`) && here.ready !== 'loading') break;
        } catch { /* execution context is recreated by reload */ }
        await sleep(100);
      }
      const urls = plan.resources.map(resource => `${origin}/${resource.runtimePath}`);
      if (sessions.get(sessionId) !== session || closed) return;
      await evaluate(`Promise.all(${JSON.stringify(urls)}.map(async url=>{const r=await fetch(url,{cache:'reload'});if(!r.ok)throw Error('Preload failed');await r.text();return r.status}))`, sessionId);
      if (sessions.get(sessionId) !== session || closed) return;
      if (!plan.requiredIds.every(id => session.observed.has(id))) throw new Error('Not all checked patches were observed in this renderer.');
      session.ready = true;
      mainSession ??= sessionId;
      rendererGoneAt = undefined;
    };
    setup().catch(error => {
      if (sessions.has(params.sessionId) && !closed) fail(error);
    });
  });
  cdp.on('Target.detachedFromTarget', ({ sessionId }) => {
    sessions.delete(sessionId);
    if (mainSession === sessionId) mainSession = [...sessions].find(([, value]) => value.ready)?.[0];
    if (![...sessions.values()].some(value => value.ready)) rendererGoneAt ??= Date.now();
  });

  let heartbeat;
  try {
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    const deadline = Date.now() + timeout;
    while (!fatalError && ![...sessions.values()].some(s => s.ready) && Date.now() < deadline) await sleep(50);
    if (fatalError) throw fatalError;
    if (!plan.requiredIds.every(id => observed.has(id)) || ![...sessions.values()].some(s => s.ready)) {
      throw new Error('Timed out verifying all runtime patches. App will close.');
    }
    mainSession = [...sessions].find(([, value]) => value.ready)[0];
    heartbeat = setInterval(() => {
      cdp.send('Browser.getVersion', {}, undefined, 2500).catch(fail);
      if (rendererGoneAt && Date.now() - rendererGoneAt > 8000) {
        fail(new Error('Codex renderer closed and no verified replacement appeared.'));
      }
    }, 4000);
    return {
      cdp, lost, observed: [...observed], evaluate,
      get sessionId() { return mainSession; },
      async closeApp() { await cdp.send('Browser.close', {}, undefined, 3000).catch(() => {}); },
      close() { closed = true; clearInterval(heartbeat); signal?.removeEventListener('abort', onAbort); cdp.close(); }
    };
  } catch (error) { closed = true; clearInterval(heartbeat); signal?.removeEventListener('abort', onAbort); cdp.close(); throw error; }
}
