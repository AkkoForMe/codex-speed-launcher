import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';

export class CdpConnection extends EventEmitter {
  #socket;
  #sequence = 0;
  #pending = new Map();
  #closed = false;

  constructor(socket) {
    super();
    this.#socket = socket;
    socket.addEventListener('message', event => {
      try {
        const message = JSON.parse(event.data);
        if (message.id !== undefined) {
          const pending = this.#pending.get(message.id);
          if (!pending) return;
          this.#pending.delete(message.id);
          clearTimeout(pending.timer);
          if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
          else pending.resolve(message.result ?? {});
        } else if (message.method) {
          this.emit(message.method, message.params ?? {}, message.sessionId);
        }
      } catch (error) { this.#disconnect(error); }
    });
    socket.addEventListener('close', () => this.#disconnect(new Error('Local Codex debugging connection closed.')));
    socket.addEventListener('error', () => this.#disconnect(new Error('Local Codex debugging connection failed.')));
  }

  static async connect(port, { timeout = 15_000, signal } = {}) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local debug port.');
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
          redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(1000)]) : AbortSignal.timeout(1000)
        });
        if (!response.ok) throw new Error('Debug endpoint not ready.');
        const version = await response.json();
        const url = new URL(version.webSocketDebuggerUrl);
        if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
            Number(url.port) !== port || !url.pathname.startsWith('/devtools/browser/')) {
          throw new Error('Unexpected local debug WebSocket address.');
        }
        // Connect to the exact local interface selected by the launcher.
        url.hostname = '127.0.0.1';
        const socket = new WebSocket(url.href);
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { socket.close(); reject(new Error('WebSocket connection timed out.')); }, 2500);
          socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
          socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WebSocket connection failed.')); }, { once: true });
        });
        return new CdpConnection(socket);
      } catch (error) { signal?.throwIfAborted(); last = error; await sleep(100); }
    }
    throw new Error(`Codex local debug endpoint unavailable: ${last?.message ?? 'timeout'}`);
  }

  send(method, params = {}, sessionId, timeout = 10_000) {
    if (this.#closed) return Promise.reject(new Error('CDP connection is closed.'));
    const id = ++this.#sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, timeout);
      this.#pending.set(id, { resolve, reject, timer, method });
      try { this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch (error) { clearTimeout(timer); this.#pending.delete(id); reject(error); }
    });
  }

  #disconnect(error) {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.#pending.clear();
    this.#socket.close();
    this.emit('disconnected', error);
  }

  close() { this.#disconnect(new Error('Launcher connection closed.')); this.#socket.close(); }
}
