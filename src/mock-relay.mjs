import http from 'node:http';
import { randomUUID } from 'node:crypto';

/** Classify generated desktop diagnostics without consulting the model name. */
export function classifyMockRequest(body) {
  let metadata;
  try { metadata = JSON.parse(body.client_metadata?.['x-codex-turn-metadata']); } catch { /* unknown stays a response */ }
  const title = metadata?.request_kind === 'turn' && metadata.thread_source === 'thread_title'
    && metadata.turn_trigger === 'thread_title';
  const composer = metadata?.request_kind === 'turn' && metadata.thread_source === 'user'
    && metadata.turn_trigger === 'composer';
  const tokens = [];
  for (const item of Array.isArray(body.input) ? body.input : []) {
    if (item?.type !== 'message' || item.role !== 'user' || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (content?.type !== 'input_text' || typeof content.text !== 'string') continue;
      const match = content.text.match(/^(CODEX_SPEED_UI_(?:STANDARD_1|FAST|STANDARD_2))\. Local speed verification\. Reply briefly\. Do not use tools\.\s*$/);
      if (match) tokens.push(match[1]);
    }
  }
  return { requestKind: title ? 'auxiliary-title' : composer ? 'user-turn' : 'response',
    diagnosticTokens: [...new Set(tokens)] };
}

/** Generated dummy traffic only. Deliberately never records Authorization. */
export async function startMockRelay({ onRequest } = {}) {
  const captures = [];
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && /\/models(?:\?|$)/.test(req.url)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-6.1-sol', object: 'model', owned_by: 'local-mock' }] }));
        return;
      }
      if (req.method !== 'POST' || !req.url.endsWith('/responses')) {
        res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{}'); return;
      }
      const buffers = []; let size = 0;
      for await (const part of req) {
        size += part.length;
        if (size > 8 * 1024 * 1024) throw new Error('Mock request too large.');
        buffers.push(part);
      }
      const body = JSON.parse(Buffer.concat(buffers).toString());
      await onRequest?.(body);
      captures.push({ model: body.model, serviceTier: body.service_tier ?? null,
        // Dummy-only diagnostic metadata; never the Authorization header, full
        // prompt, installation id, session id or raw desktop metadata.
        ...classifyMockRequest(body) });
      const item = { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'SPEED_TEST_OK', annotations: [] }] };
      const response = { id: `resp_${randomUUID()}`, object: 'response', created_at: Math.floor(Date.now() / 1000),
        status: 'completed', model: body.model, service_tier: body.service_tier ?? 'default', output: [item],
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } };
      const events = [
        { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
        { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
        { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'SPEED_TEST_OK' },
        { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: 'SPEED_TEST_OK' },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response }
      ];
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.end(events.map((event, i) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: i })}\n\n`).join(''));
    } catch { res.writeHead(400); res.end('{"error":{"message":"Invalid mock request"}}'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}/v1`, captures,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}
