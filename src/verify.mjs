import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { discoverApp } from './platform.mjs';
import { launchSession, assertArchiveUnchanged } from './launch.mjs';
import { publicInspection } from './preflight.mjs';
import { startMockRelay } from './mock-relay.mjs';
import { verifyBackend } from './backend-verify.mjs';
import { verifyNativeMenu } from './verify-ui.mjs';

export async function prepareVerification({ appPath, artifacts } = {}) {
  const app = await discoverApp({ appPath });
  const base = artifacts ? resolve(artifacts) : tmpdir();
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'codex-speed-verify-'));
  const codexHome = join(directory, 'codex-home'), electronHome = join(directory, 'electron-profile');
  const work = join(directory, 'workspace');
  await Promise.all([codexHome, electronHome, work].map(path => mkdir(path)));
  const relay = await startMockRelay();
  const env = { ...process.env,
    CODEX_SPEED_MOCK_KEY: 'local-verification-dummy-key',
    OPENAI_API_KEY: 'local-verification-dummy-key',
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy',
    'CODEX_AUTHAPI_BASE_URL', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID',
    'CODEX_APP_RUNTIME_CLI_PATH', 'CODEX_APP_TOOLS_PIPE_PATH', 'CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY']) delete env[name];
  await writeFile(join(codexHome, 'config.toml'), `model = "gpt-6.1-sol"
model_provider = "speed_mock"
model_reasoning_effort = "low"
service_tier = "default"
approval_policy = "never"
sandbox_mode = "read-only"
web_search = "disabled"
[features]
fast_mode = true
ultrafast_mode = false
apps = false
remote_plugin = false
multi_agent = false
memories = false
shell_tool = false
hooks = false
[model_providers.speed_mock]
name = "Isolated local speed test"
base_url = "${relay.url}"
wire_api = "responses"
requires_openai_auth = false
env_key = "CODEX_SPEED_MOCK_KEY"
supports_websockets = false
[desktop]
projectlessWorkspaceRoot = ${JSON.stringify(work.replaceAll('\\', '/'))}
[windows]
sandbox = "unelevated"
`, { mode: 0o600 });
  await writeFile(join(codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'local-verification-dummy-key' }), { mode: 0o600 });
  // Only the newly generated test profile skips first-run welcome/import screens.
  // No account entitlements, speed choices, existing profiles or models are seeded.
  await writeFile(join(codexHome, '.codex-global-state.json'), JSON.stringify({ 'electron-persisted-atom-state': {
    'electron:onboarding-projectless-completed': true,
    'electron:onboarding-hide-first-new-thread-promos': true,
    'electron:onboarding-welcome-v2-role-state': {
      completedConversationalOnboarding: true, completedConversationalOnboardingTaskId: null,
      completedConversationalOnboardingTaskSnapshot: null, conversationalOnboardingSkipped: true,
      onboardingCreditRewardWarningShown: false, roles: [], personalizedSuggestionsEnabled: false, workMode: 'coding'
    },
    'home-composer-mode-v1': 'work', last_completed_onboarding: Math.floor(Date.now() / 1000)
  } }), { mode: 0o600 });
  return { app, directory, codexHome, electronHome, work, relay, env };
}

export async function verifyInstalledApp({ appPath, artifacts, log = console.log, system = {} } = {}) {
  const io = { prepareVerification, verifyBackend, launchSession, verifyNativeMenu, assertArchiveUnchanged, writeFile, ...system };
  const test = await io.prepareVerification({ appPath, artifacts });
  const controller = new AbortController();
  const onSignal = () => controller.abort(new Error('Verification cancelled.'));
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  let session;
  const report = { ok: false, directory: test.directory, realCredentialsUsed: false, realUpstreamRequests: 0,
    macOSStatus: test.app.platform === 'darwin' ? 'experimental; local verification cannot establish other Mac versions' : undefined };
  try {
    // The core query must precede desktop startup: an unconfigured Windows
    // desktop can otherwise start sandbox provisioning during first launch.
    report.backend = await io.verifyBackend(test.app, { codexHome: test.codexHome, cwd: test.work,
      env: test.env, captures: test.relay.captures, signal: controller.signal, log });
    if (!report.backend.ok || !report.backend.coreStopped) {
      throw new Error(report.backend.error || report.backend.cleanupError || 'Bundled core verification did not complete.');
    }
    if (!report.backend.guiPreflightReady) {
      throw new Error(`Windows sandbox is ${report.backend.sandboxReadiness}; native UI verification was skipped. Complete normal Codex setup before retrying.`);
    }
    controller.signal.throwIfAborted();
    log('Starting a separate Codex profile and local mock relay.');
    session = await io.launchSession({ app: test.app, isolatedDir: test.electronHome,
      codexHome: test.codexHome, env: test.env, signal: controller.signal, log });
    report.inspection = publicInspection(test.app, session.plan);
    report.runtimePatches = session.runtime.observed;
    report.rendererText = await session.runtime.evaluate('document.body.innerText.slice(0,12000)');
    // The native-menu verification is separate from the core transport test.
    // It never treats a visible icon as evidence of an upstream speed guarantee.
    report.nativeMenu = await io.verifyNativeMenu(session.runtime, { captures: test.relay.captures, directory: test.directory,
      work: test.work, codexHome: test.codexHome, signal: controller.signal, log });
    io.assertArchiveUnchanged(test.app, session.plan);
    report.appUnchanged = true;
    report.ok = report.backend.ok && report.nativeMenu.ok;
  } catch (error) { report.error = error.message; }
  finally {
    if (session) {
      await session.runtime.closeApp();
      session.runtime.close();
      try { await session.child.stop(); report.testAppStopped = true; }
      catch (error) { report.cleanupError = error.message; report.ok = false; }
    }
    await test.relay.close();
    process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
    await io.writeFile(join(test.directory, 'report.json'), JSON.stringify(report, null, 2));
  }
  return report;
}
