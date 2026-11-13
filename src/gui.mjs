import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { win32 } from 'node:path';
import { createGuiController, safeGuiError } from './gui-controller.mjs';
import { windowsGuiScript } from './gui-window.mjs';

// A GUI-subsystem EXE has no console for startup failures. Keep the fallback
// script fixed and pass the redacted message as data, never as PowerShell code.
export async function showGuiFailure(error, { run = promisify(execFile), env = process.env } = {}) {
  const file = win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = "Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show($env:CODEX_SPEED_GUI_ERROR, 'Codex Speed Launcher', 'OK', 'Error')";
  await run(file, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden',
    '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    windowsHide: true, env: { ...env, CODEX_SPEED_GUI_ERROR: safeGuiError(error) },
  });
}

export async function startGuiBridge(controller) {
  const token = randomBytes(32).toString('hex');
  const credential = Buffer.from(`Bearer ${token}`);
  const server = http.createServer((request, response) => {
    const auth = Buffer.from(request.headers.authorization ?? '');
    const origin = request.headers.origin;
    const host = request.headers.host;
    const allowed = !origin && host === `127.0.0.1:${server.address().port}`
      && auth.length === credential.length && timingSafeEqual(auth, credential);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (!allowed) { response.writeHead(403); response.end('{}'); request.resume(); return; }
    if (request.method === 'GET' && request.url === '/state') { response.end(JSON.stringify(controller.snapshot())); return; }
    if (request.method !== 'POST' || request.url !== '/action') { response.writeHead(404); response.end('{}'); request.resume(); return; }
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; if (body.length > 32) request.destroy(); });
    request.on('end', () => {
      try { const operation = controller.dispatch(body); operation.catch(() => {}); response.writeHead(202); response.end('{}'); }
      catch { response.writeHead(409); response.end('{}'); }
    });
  });
  server.requestTimeout = 3000;
  server.headersTimeout = 3000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { token, endpoint: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}

export async function runGui(options = {}) {
  if (process.platform === 'darwin') {
    const { runMacGui } = await import('./gui-macos.mjs');
    return runMacGui(options);
  }
  if (process.platform !== 'win32') throw new Error('The compact window supports Windows and macOS.');
  const controller = createGuiController(options);
  const bridge = await startGuiBridge(controller);
  let child;
  try {
    const file = win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = Buffer.from(windowsGuiScript(), 'utf16le').toString('base64');
    child = spawn(file, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden', '-EncodedCommand', script], {
      windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, CODEX_SPEED_GUI_ENDPOINT: bridge.endpoint, CODEX_SPEED_GUI_TOKEN: bridge.token },
    });
    let stderr = '';
    child.stderr.on('data', part => { stderr = (stderr + part.toString()).slice(-2000); });
    const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code)); });
    // Register the rejection handler before doing the asynchronous inspection.
    exited.catch(() => {});
    await controller.initialize();
    const code = await exited;
    if (code) throw new Error(`Windows GUI failed (${code}). ${stderr}`);
    return 0;
  } finally {
    try { await controller.dispose(); }
    finally { await bridge.close(); }
  }
}
