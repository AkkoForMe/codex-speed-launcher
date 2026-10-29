import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { validateMockConfig } from './backend-verify.mjs';

const MODEL = 'gpt-6.1-sol';
const MARKER = 'SPEED_TEST_OK';
const DUMMY_KEY = 'local-verification-dummy-key';
const FAST = '[role="menuitemcheckbox"][data-fast-mode-enabled]';

function safeError(error) {
  return String(error?.message ?? error).replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 800);
}

function within(parent, child) {
  const path = relative(resolve(parent), resolve(child));
  return path !== '' && path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    && !isAbsolute(path);
}

// These are DOM interactions only. No React state, entitlement, model metadata,
// configuration or service-tier cache is changed by renderer evaluation.
function pageState() {
  const composer = document.querySelector('[data-codex-composer="true"]');
  const text = document.body.innerText;
  return {
    app: location.protocol === 'app:',
    composerCount: document.querySelectorAll('[data-codex-composer="true"]').length,
    composerText: composer?.innerText?.trim() ?? null,
    composerEditable: !!composer?.isContentEditable && composer.getClientRects().length > 0
      && !composer.closest('[aria-disabled="true"],[disabled],[inert],[hidden],[aria-hidden="true"]'),
    composerFocused: !!composer && (document.activeElement === composer || composer.contains(document.activeElement)),
    menuOpen: [...document.querySelectorAll('[role="menu"]')].some(menu =>
      menu.getClientRects().length > 0 && menu.getAttribute('data-state') !== 'closed'),
    markerCount: text.split('SPEED_TEST_OK').length - 1,
    stopping: [...document.querySelectorAll('button')].some(button =>
      /^(Stop|Stop generating|停止|停止生成)$/i.test(button.getAttribute('aria-label') ?? '')),
    modelLabel: [...document.querySelectorAll('button,[role="button"]')]
      .filter(button => !button.closest('[role="menu"]'))
      .map(button => button.innerText.trim()).find(label => /^6\.1 Sol(?:\s|$)/.test(label)) ?? null,
    prompts: [...text.matchAll(/CODEX_SPEED_UI_(?:STANDARD_1|FAST|STANDARD_2)/g)].map(match => match[0]),
  };
}

function fastState() {
  const items = [...document.querySelectorAll('[role="menuitemcheckbox"][data-fast-mode-enabled]')];
  if (items.length !== 1) return null;
  const item = items[0];
  if (item.getClientRects().length === 0 || (typeof item.checkVisibility === 'function'
    && !item.checkVisibility({ opacityProperty: true, visibilityProperty: true }))) return null;
  return { checked: item.getAttribute('aria-checked') === 'true',
    disabled: item.getAttribute('aria-disabled') === 'true' || item.hasAttribute('disabled')
      || item.hasAttribute('data-disabled') };
}

function modelMenu() {
  const buttons = [...document.querySelectorAll('button,[role="button"]')].filter(button =>
    !button.closest('[role="menu"]') && /^6\.1 Sol(?:\s|$)/.test(button.innerText.trim()));
  if (buttons.length !== 1) throw Error('The native 6.1 Sol model control is missing or ambiguous.');
  const button = buttons[0];
  if (button.disabled || button.getAttribute('aria-disabled') === 'true') throw Error('The native model control is disabled.');
  button.click();
  return true;
}

function focusComposer() {
  const items = [...document.querySelectorAll('[data-codex-composer="true"]')];
  if (items.length !== 1 || items[0].innerText.trim()) throw Error('The diagnostic composer is missing, ambiguous or nonempty.');
  if (!items[0].isContentEditable || items[0].closest('[aria-disabled="true"],[disabled],[inert],[hidden],[aria-hidden="true"]')) return false;
  items[0].focus();
  return document.activeElement === items[0] || items[0].contains(document.activeElement);
}

function sendComposer() {
  const buttons = [...document.querySelectorAll('button')].filter(button =>
    /^(Send|发送)$/i.test(button.getAttribute('aria-label') ?? ''));
  if (buttons.length !== 1 || buttons[0].disabled || buttons[0].getAttribute('aria-disabled') === 'true') {
    throw Error('The native Send control is missing, ambiguous or disabled.');
  }
  buttons[0].click();
  return true;
}

/** Verify the rendered native menu and outgoing requests in a generated profile. */
export async function verifyNativeMenu(runtime, {
  captures, directory, codexHome = directory && join(directory, 'codex-home'),
  work = directory && join(directory, 'workspace'), log = () => {},
  timeoutMs = 45_000, readinessTimeoutMs = 90_000, pollMs = 100, signal, system = {},
} = {}) {
  signal?.throwIfAborted();
  if (!Array.isArray(captures)) throw new Error('Native UI verification requires local mock captures.');
  if (![directory, codexHome, work].every(path => typeof path === 'string' && isAbsolute(path))
    || !within(directory, codexHome) || !within(directory, work)) {
    throw new Error('Native UI verification requires generated absolute home and workspace paths inside its artifact directory.');
  }
  const io = { readFile: path => readFile(path, 'utf8'), writeFile, sleep, ...system };
  const configSource = await io.readFile(join(codexHome, 'config.toml'));
  signal?.throwIfAborted();
  validateMockConfig(configSource, { CODEX_SPEED_MOCK_KEY: DUMMY_KEY });
  const auth = JSON.parse(await io.readFile(join(codexHome, 'auth.json')));
  signal?.throwIfAborted();
  if (Object.keys(auth).length !== 1 || auth.OPENAI_API_KEY !== DUMMY_KEY) {
    throw new Error('Native UI verification requires the generated dummy auth file.');
  }
  const desktop = configSource.match(/^\[desktop\]\s*\r?\n([^]*?)(?=^\[|$(?![^]))/m)?.[1];
  const configuredWork = desktop?.match(/^projectlessWorkspaceRoot\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*$/m)?.[1];
  let workPath;
  try { workPath = configuredWork?.startsWith('"') ? JSON.parse(configuredWork) : configuredWork?.slice(1, -1); }
  catch { /* invalid values fail below */ }
  if (!workPath || resolve(workPath) !== resolve(work)) {
    throw new Error('Native UI verification requires desktop.projectlessWorkspaceRoot to be the generated workspace.');
  }
  const report = { ok: false, model: MODEL, localOnly: true, dummyCredentials: true,
    sameModel: false, sameThread: false, nativeMenu: true, rows: [], screenshots: [], auxiliaryRequests: [] };
  const verificationCaptureStart = captures.length;
  const evaluateSource = async source => {
    signal?.throwIfAborted();
    const value = await runtime.evaluate(source);
    signal?.throwIfAborted();
    return value;
  };
  const evaluate = fn => evaluateSource(`(${fn.toString()})()`);
  const send = async (method, params) => {
    signal?.throwIfAborted();
    const value = await runtime.cdp.send(method, params, runtime.sessionId);
    signal?.throwIfAborted();
    return value;
  };
  const waitFor = async (read, label, limit = timeoutMs) => {
    const deadline = Date.now() + limit;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const value = await read();
      signal?.throwIfAborted();
      if (value) return value;
      await io.sleep(pollMs, undefined, { signal });
    }
    signal?.throwIfAborted();
    throw new Error(`Native UI verification timed out: ${label}.`);
  };
  const screenshot = async (name, { menuChecked } = {}) => {
    // DOM state can commit before the native menu's animation reaches the
    // compositor. Let that paint settle without changing any application state.
    signal?.throwIfAborted();
    await io.sleep(200, undefined, { signal });
    signal?.throwIfAborted();
    if (menuChecked !== undefined) {
      const state = await evaluate(fastState);
      if (!state || state.disabled || state.checked !== menuChecked) {
        throw new Error('The rendered native Fast menu changed before its screenshot.');
      }
    }
    const image = await send('Page.captureScreenshot', { format: 'png' });
    signal?.throwIfAborted();
    await io.writeFile(join(directory, name), Buffer.from(image.data, 'base64'));
    signal?.throwIfAborted();
    report.screenshots.push(name);
  };
  const closeMenu = async () => {
    for (const type of ['keyDown', 'keyUp']) {
      await send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    }
  };
  try {
    log('Checking the rendered native speed menu against the local dummy relay.');
    await closeMenu();
    const initial = await waitFor(async () => {
      const state = await evaluate(pageState);
      return state?.app && state.composerCount === 1 && state.composerEditable && state.modelLabel ? state : null;
    }, 'native editable 6.1 Sol composer', readinessTimeoutMs);
    if (initial.composerText || initial.stopping) throw new Error('The isolated native composer is not idle and empty.');
    await screenshot('native-ui-before.png');
    for (const [label, checked, token] of [
      ['Standard', false, 'STANDARD_1'], ['Fast', true, 'FAST'], ['Standard', false, 'STANDARD_2'],
    ]) {
      await closeMenu();
      await evaluate(modelMenu);
      let toggle = await waitFor(() => evaluate(fastState), 'native Fast menu item');
      if (toggle.disabled) throw new Error('The native Fast control is disabled.');
      if (toggle.checked !== checked) {
        await evaluateSource(`(()=>{const item=document.querySelector(${JSON.stringify(FAST)});if(!item)throw Error('Native Fast control disappeared');item.click();return true})()`);
        // The native menu may close after selection. Reopen it to read the
        // committed rendered state before sending, without changing the tier.
        await closeMenu();
        await waitFor(async () => (await evaluate(pageState)).modelLabel, 'model control after speed selection');
        await evaluate(modelMenu);
        toggle = await waitFor(async () => {
          const state = await evaluate(fastState);
          return state && state.checked === checked ? state : null;
        }, `${label} menu selection`);
      }
      await screenshot(`native-ui-menu-${token.toLowerCase()}.png`, { menuChecked: checked });
      await closeMenu();
      const before = await evaluate(pageState);
      if (before.modelLabel !== initial.modelLabel) throw new Error('The diagnostic model changed while switching speed.');
      const captureStart = captures.length;
      await waitFor(async () => {
        const state = await evaluate(pageState);
        if (!state.composerEditable || state.menuOpen || state.stopping) return false;
        if (state.composerText) throw new Error('The diagnostic composer is unexpectedly nonempty.');
        if (state.composerFocused) return true;
        await evaluate(focusComposer);
        return false;
      }, 'native editable composer focus', readinessTimeoutMs);
      const prompt = `CODEX_SPEED_UI_${token}. Local speed verification. Reply briefly. Do not use tools.`;
      await send('Input.insertText', { text: prompt });
      await waitFor(async () => (await evaluate(pageState)).composerText === prompt, 'native composer input');
      await evaluate(sendComposer);
      await waitFor(() => captures.length > captureStart, `${label} local request`);
      const completed = await waitFor(async () => {
        const state = await evaluate(pageState);
        return state.markerCount === before.markerCount + 1 && !state.stopping && !state.composerText ? state : null;
      }, `${label} native answer completion`);
      const intervalRequests = captures.slice(captureStart);
      // Desktop title generation uses a separate model and is explicitly tagged
      // by the bundled core. Keep it visible in the report while checking the
      // actual composer turn independently; never filter by model name.
      const requests = intervalRequests.filter(request => request.requestKind !== 'auxiliary-title');
      const capturedTier = requests[0]?.serviceTier ?? null;
      const expectedTier = checked ? 'priority' : null;
      const tierMatches = checked ? capturedTier === 'priority' : [null, 'default', 'standard'].includes(capturedTier);
      const row = { label, menuChecked: toggle.checked, model: requests[0]?.model ?? null,
        expectedTier, capturedTier, requestCount: requests.length,
        auxiliaryRequestCount: intervalRequests.length - requests.length,
        answerOK: completed.markerCount === before.markerCount + 1,
        sameModel: requests.every(request => request.model === MODEL),
        diagnosticTokenMatches: requests.length === 1 && requests[0].requestKind === 'user-turn'
          && requests[0].diagnosticTokens?.at(-1) === `CODEX_SPEED_UI_${token}`,
        ok: requests.length === 1 && requests[0].model === MODEL && tierMatches
          && requests[0].requestKind === 'user-turn' && requests[0].diagnosticTokens?.at(-1) === `CODEX_SPEED_UI_${token}`
          && completed.modelLabel === initial.modelLabel };
      report.rows.push(row);
      if (!row.ok) throw new Error(`${label} native request failed: requests=${row.requestCount}, tier=${capturedTier}.`);
      await screenshot(`native-ui-answer-${token.toLowerCase()}.png`);
      log(`Native menu ${label}: ${capturedTier ?? 'default'}; same model; ${MARKER}.`);
    }
    const final = await evaluate(pageState);
    report.sameThread = ['STANDARD_1', 'FAST', 'STANDARD_2'].every(token => final.prompts.includes(`CODEX_SPEED_UI_${token}`));
    report.sameModel = report.rows.every(row => row.sameModel);
    report.ok = report.rows.length === 3 && report.rows.every(row => row.ok) && report.sameThread && report.sameModel;
    if (!report.sameThread) report.error = 'The three diagnostic prompts were not retained in the same rendered chat.';
  } catch (error) {
    signal?.throwIfAborted();
    report.error = safeError(error);
    await screenshot('native-ui-failure.png').catch(() => {});
  }
  signal?.throwIfAborted();
  report.auxiliaryRequests = captures.slice(verificationCaptureStart)
    .filter(request => request.requestKind === 'auxiliary-title')
    .map(request => ({ kind: request.requestKind, model: request.model ?? null, serviceTier: request.serviceTier ?? null }));
  return report;
}
