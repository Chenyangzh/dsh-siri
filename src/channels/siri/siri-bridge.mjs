// siri-bridge.mjs — the wire-level pieces of the Siri (iPhone 快捷指令) bridge.
//
// A spoken request is an ordinary direct message as far as the Session is
// concerned: same bot workspace, same Session binding, therefore the same
// history and memory. What it cannot be is an ordinary channel turn — the caller
// has to receive the answer as text synchronously, while the Session still keeps a
// complete transcript. This module holds the parts of that contract that need no
// runtime: what a prompt may be, how long the caller waits, and how an answer is
// made readable out loud.

/** How long the HTTP caller waits before the bridge answers "still working". */
export const SIRI_REPLY_BUDGET_MS = 26_000;

/** Longest prompt accepted from the Shortcut; longer text is truncated. */
export const SIRI_MAX_PROMPT_CHARS = 4_000;

/** A spoken answer longer than this is cut at a sentence boundary. */
export const SIRI_MAX_SPEECH_CHARS = 1_200;

/** Sentinel result: the turn outlived the caller's budget. */
export const SIRI_PENDING = Symbol('siri-pending');

/** Spoken answer when the turn is still running. */
export const SIRI_PENDING_REPLY = '这个任务还在处理，稍后对我说“刚才的结果”就能听到。';

/** Spoken answer when a finished turn produced no prose at all. */
export const SIRI_EMPTY_REPLY = '这一轮已经处理完了，没有需要念出来的内容。';

/** Spoken answer when the turn failed; the log carries the detail. */
export const SIRI_FAILURE_REPLY = '抱歉，这次没能处理成功，请稍后再试。';

/** Spoken answer to a recall when no turn has run yet. */
export const SIRI_NO_LAST_REPLY = '还没有可以念的结果。';

/** Spoken answer to a recall while the latest turn is still running. */
export const SIRI_STILL_RUNNING_REPLY = '刚才的任务还在处理，请再等一会儿。';

/**
 * Spoken text for each error code the endpoint returns. The Shortcut only reads
 * `reply` out of the response, so an error without one would leave Siri silent.
 */
export const SIRI_ERROR_REPLIES = Object.freeze({
  'not-found': '接口地址不对，请检查快捷指令里的地址是否以 /siri 结尾。',
  'method-not-allowed': '接口地址不对，请检查快捷指令里的地址。',
  'forbidden-address': '这台设备的地址不在允许范围内，请在 Siri 语音设置里放行。',
  unauthorized: '密钥不对，请在 DSH 设置的 Siri 语音页重新复制密钥。',
  'bad-request': '请求格式不对，请检查快捷指令。',
  'payload-too-large': '这句话太长了，请说短一点。',
  'empty-text': '没有听清，请再说一次。',
  'invalid-text': '没有听清，请再说一次。',
  'ds-bot-not-found': '没有找到这个 DS Bot，请检查名称。',
  'ds-bot-unavailable': 'DS Bot 暂时不可用，请检查 DS Bot 插件是否已启用。',
  'rate-limited': '请求太频繁了，请稍后再试。',
});

/** Courtesy words and punctuation a recall may carry around its core phrase. */
const RECALL_NOISE = /[\s。，,.!！?？、~～…]|请|麻烦|帮我|给我|告诉我|说一?下|念一?下|读一?下|看一?下|一下/gu;
const RECALL_PATTERN = /^(?:(?:刚才|刚刚|上一?次|上一个|之前)的?(?:结果|回答|答案|回复)(?:呢|是什么|出来了吗|好了吗|怎么样了)?|(?:结果|答案)(?:呢|出来了吗|好了吗))$/u;

/**
 * Whether the caller asks for the previous turn's answer ("刚才的结果") instead
 * of starting a new turn. This is what the pending reply tells them to say.
 */
export function isRecallRequest(prompt) {
  if (typeof prompt !== 'string' || prompt.length > 40) return false;
  return RECALL_PATTERN.test(prompt.replace(RECALL_NOISE, ''));
}

/** What to say for a `last()` snapshot. */
export function spokenLast(last) {
  if (last?.status === 'done') return last.reply || SIRI_EMPTY_REPLY;
  if (last?.status === 'running') return SIRI_STILL_RUNNING_REPLY;
  if (last?.status === 'failed') return SIRI_FAILURE_REPLY;
  return SIRI_NO_LAST_REPLY;
}

/** Emoji, pictographs, regional flags and the invisible joiners that build them. */
const EMOJI_PATTERN = /[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{2122}\u{2139}\u{E0020}-\u{E007F}]/gu;

/** A markdown link or image target: balanced one level of parentheses at most. */
const LINK_TARGET = String.raw`\((?:[^()\s]|\([^()]*\))*\)`;

/**
 * Normalise the spoken prompt.
 *
 * Returns null when nothing is left to ask, which the caller reports as an empty
 * request instead of spending a turn on whitespace.
 */
export function normalizeSiriPrompt(value) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\r\n?/gu, '\n').trim();
  if (!text) return null;
  return text.length > SIRI_MAX_PROMPT_CHARS ? text.slice(0, SIRI_MAX_PROMPT_CHARS) : text;
}

/**
 * Turn a channel answer into text that reads well aloud.
 *
 * Siri speaks the string, so the shape of a chat reply is wrong here: code
 * blocks are formatting rather than content, links keep their label, and emoji
 * are noise in speech. The result is plain prose, cut at a sentence when it is
 * too long to listen to.
 */
export function toSpeechText(value) {
  if (typeof value !== 'string') return '';
  let text = value.replace(/\r\n?/gu, '\n');
  // A code block is dropped whole: its indentation and symbols carry the meaning.
  text = text.replace(/```[^\n]*\n?[\s\S]*?```/gu, ' ');
  text = text.replace(/~~~[^\n]*\n?[\s\S]*?~~~/gu, ' ');
  text = text.replace(/`([^`\n]*)`/gu, '$1');
  text = text.replace(new RegExp(`!\\[[^\\]]*\\]${LINK_TARGET}`, 'gu'), ' ');
  text = text.replace(new RegExp(`\\[([^\\]]*)\\]${LINK_TARGET}`, 'gu'), '$1');
  text = text.replace(/^\s{0,3}#{1,6}\s+/gmu, '');
  text = text.replace(/^\s{0,3}>\s?/gmu, '');
  text = text.replace(/^\s{0,3}(?:[-*+•]|\d{1,3}[.)])\s+/gmu, '');
  // A markdown table's rule line and pipes are separators, not words.
  text = text.replace(/^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/gmu, ' ');
  text = text.replace(/\|/gu, ' ');
  text = text.replace(/\*\*|__|~~|[*_]/gu, '');
  text = text.replace(EMOJI_PATTERN, '');
  text = text.replace(/[ \t\u00a0]+/gu, ' ');
  text = text.replace(/[ ]*\n(?:[ ]*\n)*[ ]*/gu, '\n');
  text = text.trim();
  if (!text) return '';
  return clipAtSentence(text, SIRI_MAX_SPEECH_CHARS);
}

/** Cut at the last sentence break when one is near the end, else hard-cut. */
function clipAtSentence(text, limit) {
  if (text.length <= limit) return text;
  const window = text.slice(0, limit);
  const cut = Math.max(
    window.lastIndexOf('。'), window.lastIndexOf('，'), window.lastIndexOf('！'),
    window.lastIndexOf('？'), window.lastIndexOf('；'), window.lastIndexOf(';'),
    window.lastIndexOf('.'), window.lastIndexOf('!'), window.lastIndexOf('?'),
    window.lastIndexOf('\n'),
  );
  if (cut > limit / 3) return window.slice(0, cut + 1).trim();
  return `${window.trim()}…`;
}
