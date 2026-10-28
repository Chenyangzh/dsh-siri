// siri-http.mjs — the HTTP listener of the Siri channel.
//
// One POST /siri is one conversational turn: the answer goes back in the
// response for the iPhone Shortcut to read aloud. GET /siri/last returns the
// answer of a turn that outlived its caller; GET /siri/health checks the key.

import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

import { SIRI_ERROR_REPLIES } from './siri-bridge.mjs';

export const SIRI_ENDPOINT_PATH = '/siri';
export const SIRI_LAST_PATH = '/siri/last';
export const SIRI_HEALTH_PATH = '/siri/health';

const MAX_BODY_BYTES = 32 * 1024;

/** Turn errors the caller can act on; anything else is spoken as a generic failure. */
const TURN_ERROR_STATUS = Object.freeze({
  'ds-bot-not-found': 404,
  'ds-bot-unavailable': 503,
  'rate-limited': 429,
  'invalid-text': 400,
});

class SiriHttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function json(response, status, value, headers = {}) {
  if (response.destroyed || response.writableEnded) return;
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    ...headers,
  });
  response.end(body);
}

/** An error response; `reply` is what Siri says, since the Shortcut reads nothing else. */
function fail(response, status, code, headers) {
  const reply = Object.hasOwn(SIRI_ERROR_REPLIES, code) ? SIRI_ERROR_REPLIES[code] : '';
  json(response, status, { ...(reply ? { reply } : {}), error: { code } }, headers);
}

function ipv4ToInt(text) {
  const parts = text.split('.').map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) : null;
}

/**
 * Whether a peer address may call the endpoint. An empty list allows everyone;
 * a non-empty list allows loopback plus the listed IPv4 addresses, IPv4 CIDR
 * blocks and IPv6 addresses.
 */
export function addressAllowed(remote, allowed) {
  if (!Array.isArray(allowed) || allowed.length === 0) return true;
  const address = typeof remote === 'string' ? remote.replace(/^::ffff:/iu, '') : '';
  if (address === '127.0.0.1' || address === '::1') return true;
  const value = ipv4ToInt(address);
  return allowed.some((entry) => {
    if (typeof entry !== 'string') return false;
    const [base, bits] = entry.split('/');
    if (value === null || bits === undefined) return base.toLowerCase() === address.toLowerCase();
    const network = ipv4ToInt(base);
    const prefix = Number(bits);
    if (network === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return ((value & mask) >>> 0) === ((network & mask) >>> 0);
  });
}

/** Constant-time bearer check; the length test is separate because timingSafeEqual throws on a mismatch. */
function authorized(request, apiKey) {
  const header = request.headers?.authorization;
  if (typeof header !== 'string') return false;
  const match = /^Bearer[ ]+(.+)$/iu.exec(header.trim());
  if (!match) return false;
  const provided = Buffer.from(match[1].trim(), 'utf8');
  const expected = Buffer.from(apiKey, 'utf8');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

async function readJsonBody(request) {
  const declared = Number(request.headers?.['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new SiriHttpError(413, 'payload-too-large');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_BODY_BYTES) throw new SiriHttpError(413, 'payload-too-large');
    chunks.push(buffer);
  }
  if (length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw new SiriHttpError(400, 'bad-request');
  }
}

/**
 * Build the request handler. `runtime.talk` runs a turn; `runtime.last` returns the latest outcome.
 * `getApiKey` is read per request so a key reset takes effect without a restart.
 */
export function createSiriHttpHandler({
  runtime, getApiKey, getAllowedAddresses = () => [], logger = console,
} = {}) {
  if (!runtime || typeof runtime.talk !== 'function') {
    throw new TypeError('The Siri endpoint needs a runtime that answers turns');
  }
  if (typeof getApiKey !== 'function') throw new TypeError('The Siri endpoint needs an API key source');
  return async function handleSiriRequest(request, response) {
    let pathname;
    try {
      pathname = new URL(request.url ?? '/', 'http://siri.local').pathname;
    } catch {
      fail(response, 400, 'bad-request');
      return;
    }
    if (![SIRI_ENDPOINT_PATH, SIRI_LAST_PATH, SIRI_HEALTH_PATH].includes(pathname)) {
      fail(response, 404, 'not-found');
      return;
    }
    if (!addressAllowed(request.socket?.remoteAddress, getAllowedAddresses())) {
      fail(response, 403, 'forbidden-address');
      return;
    }
    const apiKey = getApiKey();
    if (!apiKey || !authorized(request, apiKey)) {
      fail(response, 401, 'unauthorized', { 'www-authenticate': 'Bearer' });
      return;
    }
    if (pathname !== SIRI_ENDPOINT_PATH) {
      if (request.method !== 'GET') {
        fail(response, 405, 'method-not-allowed', { allow: 'GET' });
        return;
      }
      json(response, 200, pathname === SIRI_HEALTH_PATH ? { ok: true } : runtime.last());
      return;
    }
    if (request.method !== 'POST') {
      fail(response, 405, 'method-not-allowed', { allow: 'POST' });
      return;
    }

    let payload;
    try {
      payload = await readJsonBody(request);
    } catch (error) {
      fail(response, error?.status ?? 400, error?.code ?? 'bad-request');
      return;
    }
    const text = typeof payload?.text === 'string' ? payload.text : '';
    if (!text.trim()) {
      fail(response, 400, 'empty-text');
      return;
    }
    const startedAt = Date.now();
    try {
      const bot = typeof payload?.bot === 'string' ? payload.bot.trim().slice(0, 128) : '';
      const reply = await runtime.talk({ text, bot });
      json(response, 200, { reply, elapsedMs: Date.now() - startedAt });
    } catch (error) {
      const code = typeof error?.code === 'string' && error.code ? error.code : 'siri-failed';
      const status = Object.hasOwn(TURN_ERROR_STATUS, code) ? TURN_ERROR_STATUS[code] : 0;
      if (status) {
        fail(response, status, code, code === 'rate-limited' ? { 'retry-after': '30' } : undefined);
        return;
      }
      logger.error?.(`Siri turn failed (${code}):`, error?.message ?? error);
      json(response, 200, { reply: runtime.failureReply, error: { code } });
    }
  };
}

/** Start the listener; resolves with the server once it is bound, rejects when the bind fails. */
export function listenSiriHttp({ handler, host, port, logger = console }) {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      logger.error?.('Siri endpoint request failed', error?.message ?? error);
      fail(response, 500, 'siri-failed');
    });
  });
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      server.on('error', (error) => logger.error?.('Siri endpoint error', error?.message ?? error));
      resolve(server);
    });
  });
}
