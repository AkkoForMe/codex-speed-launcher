import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CdpConnection } from '../src/cdp.mjs';

class Socket extends EventTarget {
  sent = [];
  closed = false;
  send(text) { this.sent.push(JSON.parse(text)); }
  receive(data) { this.dispatchEvent(new MessageEvent('message', { data: typeof data === 'string' ? data : JSON.stringify(data) })); }
  close() { this.closed = true; this.dispatchEvent(new Event('close')); }
}

test('CDP routes out-of-order results and preserves the renderer session', async () => {
  const socket = new Socket();
  const cdp = new CdpConnection(socket);
  try {
    const first = cdp.send('Runtime.evaluate', { expression: '1' }, 'renderer-a');
    const second = cdp.send('Browser.getVersion');
    assert.equal(socket.sent[0].sessionId, 'renderer-a');
    socket.receive({ id: socket.sent[1].id, result: { product: 'test' } });
    socket.receive({ id: socket.sent[0].id, result: { result: { value: 1 } } });
    assert.equal((await first).result.value, 1);
    assert.equal((await second).product, 'test');
  } finally { cdp.close(); }
});

test('CDP dispatches Fetch events with their session id and rejects remote command errors', async () => {
  const socket = new Socket();
  const cdp = new CdpConnection(socket);
  try {
    const event = new Promise(resolve => cdp.once('Fetch.requestPaused', (params, session) => resolve({ params, session })));
    socket.receive({ method: 'Fetch.requestPaused', params: { requestId: 'request-1' }, sessionId: 'renderer-a' });
    assert.deepEqual(await event, { params: { requestId: 'request-1' }, session: 'renderer-a' });
    const command = cdp.send('Fetch.getResponseBody', {}, 'renderer-a');
    socket.receive({ id: socket.sent.at(-1).id, error: { message: 'No resource' } });
    await assert.rejects(command, /Fetch.getResponseBody: No resource/);
  } finally { cdp.close(); }
});

test('closed or malformed CDP connections settle all pending operations once', async () => {
  for (const malformed of [false, true]) {
    const socket = new Socket();
    const cdp = new CdpConnection(socket);
    let disconnects = 0;
    cdp.on('disconnected', () => disconnects++);
    const one = cdp.send('Runtime.evaluate');
    const two = cdp.send('Browser.getVersion');
    const rejected = Promise.all([assert.rejects(one), assert.rejects(two)]);
    if (malformed) socket.receive('not-json'); else socket.close();
    await rejected;
    await assert.rejects(cdp.send('Browser.getVersion'), /closed/);
    cdp.close();
    assert.equal(disconnects, 1);
  }
});

test('CDP command timeout does not prevent subsequent commands from completing', async () => {
  const socket = new Socket();
  const cdp = new CdpConnection(socket);
  try {
    await assert.rejects(cdp.send('Runtime.evaluate', {}, 'renderer-a', 5), /timed out/);
    const command = cdp.send('Browser.getVersion');
    socket.receive({ id: socket.sent.at(-1).id, result: { product: 'still-connected' } });
    assert.equal((await command).product, 'still-connected');
  } finally { cdp.close(); }
});
