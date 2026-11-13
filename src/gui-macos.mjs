import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function runMacGui(options = {}) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const helper = options.macWindowPath ?? join(root, 'native', 'macos', 'CodexSpeedLauncher');
  try { await access(helper, constants.X_OK); }
  catch { throw new Error('The native macOS window has not been built. Open the .app release, or build the macOS app first.'); }
  const child = spawn(helper, ['--launcher-root', root], {
    stdio: 'inherit',
    env: { ...process.env, ...(options.appPath ? { CODEX_SPEED_APP_PATH: options.appPath } : {}) },
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(0) : reject(new Error('The native macOS window exited unexpectedly.')));
  });
}
