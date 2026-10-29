import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyMockRequest, startMockRelay } from '../src/mock-relay.mjs';

const prompt = token => `CODEX_SPEED_UI_${token}. Local speed verification. Reply briefly. Do not use tools.\n`;
const message = text => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const metadata = (source = 'user', trigger = 'composer') => ({
  'x-codex-turn-metadata': JSON.stringify({ request_kind: 'turn', thread_source: source, turn_trigger: trigger }),
});

test('dummy request classification uses exact core purpose metadata rather than the model or prompt keywords', () => {
  const composer = { model: 'gpt-6.1-sol', input: [message(prompt('STANDARD_1'))],
    client_metadata: metadata(), instructions: 'Titles, summaries and unrelated text are allowed here.' };
  assert.deepEqual(classifyMockRequest(composer), {
    requestKind: 'user-turn', diagnosticTokens: ['CODEX_SPEED_UI_STANDARD_1'],
  });
  assert.equal(classifyMockRequest({ ...composer, model: 'gpt-6.1-sol-fast' }).requestKind, 'user-turn');
  assert.equal(classifyMockRequest({ ...composer, client_metadata: metadata('thread_title', 'thread_title') }).requestKind,
    'auxiliary-title');
  for (const client_metadata of [undefined, metadata('thread_title', 'composer'),
    { 'x-codex-turn-metadata': '{invalid' }, metadata('user', 'thread_title')]) {
    assert.equal(classifyMockRequest({ ...composer, client_metadata }).requestKind, 'response');
  }
});

test('only exact diagnostic user messages supply correlation tokens, including the current final turn', () => {
  const result = classifyMockRequest({ client_metadata: metadata(), input: [
    { ...message(prompt('FAST')), role: 'developer' },
    message(`Create a title for this prompt: ${prompt('FAST')}`),
    message(prompt('STANDARD_1')), message(prompt('STANDARD_1')), message(prompt('FAST')),
  ] });
  assert.deepEqual(result.diagnosticTokens, ['CODEX_SPEED_UI_STANDARD_1', 'CODEX_SPEED_UI_FAST']);
});

test('loopback mock retains only minimal tier and purpose evidence while serving a generated response', async () => {
  const relay = await startMockRelay();
  try {
    const response = await fetch(`${relay.url}/responses`, { method: 'POST', headers: {
      'Content-Type': 'application/json', Authorization: 'Bearer must-not-be-recorded',
    }, body: JSON.stringify({ model: 'gpt-6.1-sol', service_tier: 'priority',
      input: [message(prompt('FAST'))], client_metadata: metadata(), instructions: 'private dummy instructions' }) });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /SPEED_TEST_OK/);
    assert.deepEqual(relay.captures, [{ model: 'gpt-6.1-sol', serviceTier: 'priority',
      requestKind: 'user-turn', diagnosticTokens: ['CODEX_SPEED_UI_FAST'] }]);
  } finally { await relay.close(); }
});
