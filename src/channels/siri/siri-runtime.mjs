// siri-runtime.mjs — one Siri entry point: an HTTP listener plus the Session it talks to.
//
// A request is an ordinary direct conversation with the configured workspace:
// the same Session binding, therefore the same history, memory and model every
// time. Unlike a chat channel there is nobody to push to, so a turn that
// outlives the caller's budget is kept and can be fetched with GET /siri/last.

import { askInWorkspaceSession } from '../shared/workspace-session.mjs';
import { createSiriHttpHandler, listenSiriHttp } from './siri-http.mjs';
import { SIRI_CONVERSATION_KEY } from './config-store.mjs';
import {
  SIRI_EMPTY_REPLY,
  SIRI_FAILURE_REPLY,
  SIRI_PENDING,
  SIRI_PENDING_REPLY,
  SIRI_REPLY_BUDGET_MS,
  isRecallRequest,
  normalizeSiriPrompt,
  spokenLast,
  toSpeechText,
} from './siri-bridge.mjs';

/** Harness Session ids the switch endpoint accepts. */
export const SESSION_ID_PATTERN = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export class SiriRuntime {
  #config;
  #getApiKey;
  #harness;
  #state;
  #replyTimeoutMs;
  #conversationFor;
  #questions;
  #logger;
  #server = null;
  #turns = Promise.resolve();
  #recent = [];
  #turnId = 0;
  #last = { status: 'none' };
  #status = { ready: false, listening: false, port: null, error: null };

  constructor({
    config, getApiKey, harness, state, conversationFor, questions, replyTimeoutMs = 600_000, logger = console,
  }) {
    this.#conversationFor = conversationFor;
    this.#questions = questions;
    this.#config = config;
    this.#getApiKey = getApiKey;
    this.#harness = harness;
    this.#state = state;
    this.#replyTimeoutMs = replyTimeoutMs;
    this.#logger = logger;
  }

  get status() { return structuredClone(this.#status); }
  get failureReply() { return SIRI_FAILURE_REPLY; }

  async start() {
    if (this.#server) return this.status;
    const handler = createSiriHttpHandler({
      runtime: this, getApiKey: this.#getApiKey, logger: this.#logger,
      getAllowedAddresses: () => this.#config.allowedAddresses ?? [],
    });
    try {
      this.#server = await listenSiriHttp({
        handler, host: this.#config.host, port: this.#config.port, logger: this.#logger,
      });
    } catch (error) {
      this.#status = {
        ready: false, listening: false, port: this.#config.port,
        error: error?.code === 'EADDRINUSE' ? 'port-in-use' : (error?.code ?? 'listen-failed'),
      };
      throw error;
    }
    this.#status = { ready: true, listening: true, port: this.#config.port, error: null };
    this.#logger.info?.(`Siri endpoint listening on http://${this.#config.host}:${this.#config.port}/siri`);
    return this.status;
  }

  async stop() {
    const server = this.#server;
    this.#server = null;
    this.#status = { ...this.#status, ready: false, listening: false };
    if (!server) return;
    await new Promise((resolve) => {
      try { server.close(() => resolve()); server.closeIdleConnections?.(); } catch { resolve(); }
    });
  }

  /** The Session the next spoken turn continues in, or null before the first turn. */
  get sessionId() {
    return this.#state.sessionFor(SIRI_CONVERSATION_KEY) ?? null;
  }

  /**
   * Continue in an existing Session instead of the current one. The binding is
   * kept in the state store (memory + state.json), so a switch applies to the
   * next request without restarting the plugin.
   */
  async setSession(sessionId) {
    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
      throw Object.assign(new TypeError('Invalid Siri session id'), { code: 'session-id-invalid' });
    }
    await this.#state.setSession(SIRI_CONVERSATION_KEY, sessionId);
    return this.sessionId;
  }

  /** Forget the binding so the next spoken turn starts a fresh Session. */
  async clearSession() {
    await this.#state.clearSession(SIRI_CONVERSATION_KEY);
    return null;
  }

  /** The latest turn, with `reply` always set so the Shortcut has something to read aloud. */
  last() {
    return { ...structuredClone(this.#last), reply: spokenLast(this.#last) };
  }

  /** Run one spoken turn; returns the speech-ready answer or a "still working" notice. */
  async talk({ text, timeoutMs, bot } = {}) {
    const prompt = normalizeSiriPrompt(text);
    if (!prompt) {
      const error = new TypeError('The Siri bridge needs a non-empty prompt');
      error.code = 'invalid-text';
      throw error;
    }
    // "刚才的结果" reads back the previous answer instead of starting a turn.
    if (isRecallRequest(prompt)) return spokenLast(this.#last);
    const budget = Number.isSafeInteger(timeoutMs ?? this.#config.timeoutMs) && (timeoutMs ?? this.#config.timeoutMs) > 0
      ? Math.min(timeoutMs ?? this.#config.timeoutMs, 120_000)
      : SIRI_REPLY_BUDGET_MS;
    const limit = this.#config.rateLimitPerMinute;
    if (limit > 0) {
      const now = Date.now();
      this.#recent = this.#recent.filter((at) => now - at < 60_000);
      if (this.#recent.length >= limit) {
        const error = new Error('Too many Siri requests');
        error.code = 'rate-limited';
        throw error;
      }
      this.#recent.push(now);
    }
    // A request that names a DS Bot runs in that Bot's own conversation.
    let conversationKey = SIRI_CONVERSATION_KEY;
    if (typeof bot === 'string' && bot.trim()) {
      if (typeof this.#conversationFor !== 'function') {
        const error = new Error('DS Bot is unavailable');
        error.code = 'ds-bot-unavailable';
        throw error;
      }
      conversationKey = await this.#conversationFor(bot);
    }
    const guidance = typeof this.#config.guidance === 'string' ? this.#config.guidance.trim() : '';
    const framed = guidance ? `${guidance}\n\n${prompt}` : prompt;
    const startedAt = new Date().toISOString();
    const turnId = ++this.#turnId;
    this.#last = { status: 'running', prompt, startedAt };
    // Only the latest request owns `last`: an older queued turn finishing must not hide it.
    const record = (value) => { if (turnId === this.#turnId) this.#last = value; };

    // Spoken turns serialise, so one request cannot overtake another.
    const turn = this.#turns.catch(() => undefined).then(async () => {
      // A DS Bot waiting on an ask_user card takes what is said next as the answer.
      const open = await this.#questions?.pending(conversationKey);
      if (open) {
        const followUp = await this.#questions.answer(open, prompt, { waitMs: this.#replyTimeoutMs });
        if (followUp !== null) return followUp;
      }
      let notice = '';
      const { answer } = await askInWorkspaceSession({
        harness: this.#harness,
        state: this.#state,
        key: conversationKey,
        text: framed,
        askOptions: { timeoutMs: this.#replyTimeoutMs },
        // The bound Session was archived or deleted and a fresh one was started:
        // say so once, so the caller knows the history did not carry over.
        onNotice: (message) => { notice = message; },
      });
      const reply = [notice, typeof answer === 'string' ? answer : ''].filter(Boolean).join('\n\n');
      // ask_user ends the Bot's turn with a card; read it out after what the Bot said.
      const next = await this.#questions?.pending(conversationKey);
      return next ? [reply, this.#questions.speak(next.card)].filter(Boolean).join('\n\n') : reply;
    });
    this.#turns = turn;
    const settle = turn.then(
      (answer) => {
        record({
          status: 'done', prompt, startedAt, finishedAt: new Date().toISOString(),
          reply: toSpeechText(answer) || SIRI_EMPTY_REPLY,
        });
      },
      (error) => {
        record({
          status: 'failed', prompt, startedAt, finishedAt: new Date().toISOString(),
          error: { code: typeof error?.code === 'string' && error.code ? error.code : 'siri-failed' },
        });
      },
    );

    let timer = null;
    let outcome;
    try {
      outcome = await Promise.race([
        turn.then((answer) => ({ answer }), (error) => ({ error })),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(SIRI_PENDING), budget);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    void settle;
    if (outcome === SIRI_PENDING) return SIRI_PENDING_REPLY;
    if (outcome.error) throw outcome.error;
    return toSpeechText(outcome.answer) || SIRI_EMPTY_REPLY;
  }
}
