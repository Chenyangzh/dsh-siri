import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  SIRI_ERROR_REPLIES, SIRI_NO_LAST_REPLY, SIRI_PENDING_REPLY, SIRI_STILL_RUNNING_REPLY,
  isRecallRequest, toSpeechText,
} from '../src/channels/siri/siri-bridge.mjs';
import { addressAllowed, createSiriHttpHandler, listenSiriHttp } from '../src/channels/siri/siri-http.mjs';
import { lanAddresses } from '../src/channels/siri/siri-controller.mjs';
import { parseSpokenAnswer } from '../src/channels/siri/question-flow.mjs';
import { SiriRuntime } from '../src/channels/siri/siri-runtime.mjs';
import { askInWorkspaceSession } from '../src/channels/shared/workspace-session.mjs';

test('toSpeechText drops code, links, markup and emoji', () => {
  const text = toSpeechText('## 标题\n\n- **加粗** 👍 [链接](https://x.y/(a))\n\n```js\nconst a = 1;\n```\n`行内`');
  assert.equal(text, '标题\n加粗 链接\n行内');
});

test('toSpeechText cuts a long answer at a sentence', () => {
  const text = toSpeechText('这是一句话。'.repeat(400));
  assert.ok(text.length <= 1_200);
  assert.ok(text.endsWith('。'));
});

test('isRecallRequest matches the phrase the pending reply suggests, and only that', () => {
  for (const said of ['刚才的结果', '刚才的结果。', '请告诉我刚才的结果', '上一次的回答呢？', '结果出来了吗', '念一下刚刚的答案']) {
    assert.ok(isRecallRequest(said), said);
  }
  for (const said of ['刚才的结果为什么不对', '帮我查一下明天的天气', '结果', '']) {
    assert.ok(!isRecallRequest(said), said);
  }
});

test('parseSpokenAnswer reads option numbers and labels', () => {
  const card = { options: [{ label: '苹果' }, { label: '香蕉' }, { label: '橙子' }], multiSelect: true };
  assert.deepEqual(parseSpokenAnswer(card, '第二个'), { selected: ['香蕉'] });
  assert.deepEqual(parseSpokenAnswer(card, '一和三'), { selected: ['苹果', '橙子'] });
  assert.deepEqual(parseSpokenAnswer(card, '我要橙子'), { selected: ['橙子'] });
  assert.deepEqual(parseSpokenAnswer(card, '都不要'), { selected: [], custom: '都不要' });
});

test('addressAllowed honours CIDR blocks and rejects bad prefixes', () => {
  assert.ok(addressAllowed('1.2.3.4', []));
  assert.ok(addressAllowed('::ffff:192.168.1.20', ['192.168.1.0/24']));
  assert.ok(addressAllowed('127.0.0.1', ['10.0.0.1']));
  assert.ok(!addressAllowed('192.168.2.20', ['192.168.1.0/24']));
  assert.ok(!addressAllowed('192.168.1.20', ['192.168.1.0/33']));
});

test('lanAddresses puts the home network before Tailscale and skips loopback', () => {
  const found = lanAddresses({
    lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    utun4: [{ family: 'IPv4', address: '100.101.1.2', internal: false }],
    en0: [{ family: 'IPv4', address: '192.168.1.8', internal: false }, { family: 'IPv6', address: 'fe80::1', internal: false }],
    en5: [{ family: 'IPv4', address: '169.254.3.3', internal: false }],
  });
  assert.deepEqual(found, ['192.168.1.8', '100.101.1.2']);
});

async function withServer(runtime, run) {
  const handler = createSiriHttpHandler({ runtime, getApiKey: () => 'secret', logger: { error() {} } });
  const server = await listenSiriHttp({ handler, host: '127.0.0.1', port: 0, logger: { error() {} } });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'POST', body, key = 'secret' } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    await run(call);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('every error response carries a spoken reply', async () => {
  const runtime = {
    failureReply: 'failed',
    last: () => ({ status: 'none', reply: SIRI_NO_LAST_REPLY }),
    async talk({ text }) {
      if (text === 'busy') throw Object.assign(new Error('busy'), { code: 'rate-limited' });
      if (text === 'boom') throw new Error('boom');
      return `echo ${text}`;
    },
  };
  await withServer(runtime, async (call) => {
    assert.deepEqual(await call('/siri', { body: { text: 'hi' } }).then((r) => [r.status, r.body.reply]), [200, 'echo hi']);
    const wrongPath = await call('/');
    assert.equal(wrongPath.status, 404);
    assert.equal(wrongPath.body.reply, SIRI_ERROR_REPLIES['not-found']);
    const badKey = await call('/siri', { body: { text: 'hi' }, key: 'nope' });
    assert.equal(badKey.status, 401);
    assert.equal(badKey.body.reply, SIRI_ERROR_REPLIES.unauthorized);
    const empty = await call('/siri', { body: { text: '  ' } });
    assert.equal(empty.body.reply, SIRI_ERROR_REPLIES['empty-text']);
    const limited = await call('/siri', { body: { text: 'busy' } });
    assert.equal(limited.status, 429);
    assert.equal(limited.body.reply, SIRI_ERROR_REPLIES['rate-limited']);
    const failed = await call('/siri', { body: { text: 'boom' } });
    assert.deepEqual([failed.status, failed.body.reply], [200, 'failed']);
    const last = await call('/siri/last', { method: 'GET' });
    assert.equal(last.body.reply, SIRI_NO_LAST_REPLY);
  });
});

/** A runtime whose turns are DS Bot follow-ups the test settles by hand. */
function controllableRuntime() {
  const turns = [];
  const questions = {
    pending: async () => ({ card: {} }),
    answer: (_open, prompt) => new Promise((resolve) => turns.push({ prompt, resolve })),
    speak: () => '',
  };
  const runtime = new SiriRuntime({
    config: { timeoutMs: 1_000, rateLimitPerMinute: 0 }, questions, logger: {},
  });
  const nextTurn = async () => {
    while (turns.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    return turns.shift();
  };
  return { runtime, nextTurn };
}

test('saying 刚才的结果 reads back a turn that outlived the caller', async () => {
  const { runtime, nextTurn } = controllableRuntime();
  assert.equal(await runtime.talk({ text: '刚才的结果' }), SIRI_NO_LAST_REPLY);
  const slow = runtime.talk({ text: '写一首诗', timeoutMs: 20 });
  const turn = await nextTurn();
  assert.equal(await slow, SIRI_PENDING_REPLY);
  assert.equal(await runtime.talk({ text: '刚才的结果' }), SIRI_STILL_RUNNING_REPLY);
  turn.resolve('**床前明月光**');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await runtime.talk({ text: '刚才的结果。' }), '床前明月光');
  assert.equal(runtime.last().reply, '床前明月光');
});

test('an older queued turn finishing does not replace the latest one', async () => {
  const { runtime, nextTurn } = controllableRuntime();
  const first = runtime.talk({ text: '第一件事', timeoutMs: 20 });
  const firstTurn = await nextTurn();
  const second = runtime.talk({ text: '第二件事', timeoutMs: 20 });
  assert.equal(await first, SIRI_PENDING_REPLY);
  assert.equal(await second, SIRI_PENDING_REPLY);
  firstTurn.resolve('第一件的答案');
  const secondTurn = await nextTurn();
  assert.equal(runtime.last().status, 'running');
  assert.equal(runtime.last().prompt, '第二件事');
  secondTurn.resolve('第二件的答案');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.last().reply, '第二件的答案');
});

test('the stored API key survives a restart', async () => {
  const { SiriController } = await import('../src/channels/siri/siri-controller.mjs');
  // Shaped like the Host's credential store: resolve() returns `{ value }`.
  const saved = new Map();
  const credentials = {
    async resolve(ref) { return saved.has(ref) ? { value: saved.get(ref) } : null; },
    async set(ref, value) { saved.set(ref, value); },
  };
  const config = { enabled: true, port: 0, name: 'Siri', apiKeyRef: 'DSH_SIRI_API_KEY', allowedAddresses: [] };
  const boot = async () => {
    const controller = new SiriController({
      credentials, env: {}, logger: {}, getLanAddresses: () => [],
      configStore: { get: () => structuredClone(config) },
      createRuntime: async () => ({ status: { ready: true }, async start() {}, async stop() {} }),
    });
    await controller.initialize();
    const key = controller.status().bots[0].apiKey;
    await controller.close();
    return key;
  };
  const first = await boot();
  assert.match(first, /^siri_/u);
  assert.equal(await boot(), first);
});

test('the runtime reports, switches and clears the Session the next turn uses', async () => {
  const sessions = new Map();
  const runtime = new SiriRuntime({
    config: { timeoutMs: 1_000, rateLimitPerMinute: 0 },
    state: {
      sessionFor: (key) => sessions.get(key) ?? null,
      setSession: async (key, id) => { sessions.set(key, id); },
      clearSession: async (key) => { sessions.delete(key); },
    },
    logger: {},
  });
  const id = 'session-11111111-2222-3333-4444-555555555555';
  assert.equal(runtime.sessionId, null);
  assert.equal(await runtime.setSession(id), id);
  assert.equal(runtime.sessionId, id);
  await assert.rejects(() => runtime.setSession('../../etc/passwd'), { code: 'session-id-invalid' });
  assert.equal(await runtime.clearSession(), null);
  assert.equal(runtime.sessionId, null);
});

test('an archived binding starts a fresh Session and says so', async () => {
  const archivedId = 'session-11111111-2222-3333-4444-555555555555';
  const freshId = 'session-99999999-8888-7777-6666-555555555555';
  const asked = [];
  const notices = [];
  let bound = archivedId;
  const result = await askInWorkspaceSession({
    harness: {
      sessionArchived: async (id) => id === archivedId,
      sessionExists: async () => true,
      createSession: async () => freshId,
      ask: async (id, prompt) => { asked.push([id, prompt]); return '收到'; },
    },
    state: {
      sessionFor: () => bound,
      setSession: async (_key, id) => { bound = id; return true; },
      clearSession: async () => { bound = null; },
    },
    key: 'direct:siri',
    text: '你好',
    onNotice: (message) => notices.push(message),
  });
  assert.equal(result.answer, '收到');
  assert.equal(bound, freshId);
  assert.deepEqual(asked, [[freshId, '你好']]);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /归档/u);
});

test('a live binding is reused without creating a Session', async () => {
  const liveId = 'session-77777777-8888-9999-aaaa-bbbbbbbbbbbb';
  let created = 0;
  const asked = [];
  const result = await askInWorkspaceSession({
    harness: {
      sessionArchived: async () => false,
      sessionExists: async () => true,
      createSession: async () => { created += 1; return 'session-should-not-exist'; },
      ask: async (id, prompt) => { asked.push([id, prompt]); return '好'; },
    },
    state: {
      sessionFor: () => liveId,
      setSession: async () => true,
      clearSession: async () => {},
    },
    key: 'direct:siri',
    text: '继续',
  });
  assert.equal(result.answer, '好');
  assert.equal(created, 0);
  assert.deepEqual(asked, [[liveId, '继续']]);
});
