import { createConnectionDiagnostics, diagnosticRpcResult } from '../../../../src/channels/shared/connection-error.mjs';
import { DS_BOT_ERROR_MESSAGES } from '../../../../src/channels/siri/ds-bot-service.mjs';
import { validSiriAllowedAddress } from '../../../../src/channels/siri/config-store.mjs';
import { registerManagementRpc } from '../../../management-rpc.mjs';
import { SESSION_ID_PATTERN } from '../../../../src/channels/siri/siri-runtime.mjs';
import { resolveRpcAuthority } from '../../rpc-authority.mjs';
import { publicWorkspaceError, SET_WORKSPACE_ENDPOINT, validWorkspacePayload } from '../shared/workspace-rpc.mjs';
import { SET_AGENT_PRESET_ENDPOINT, validAgentPresetPayload } from '../shared/agent-preset-rpc.mjs';
import { SET_MODEL_ENDPOINT, validModelPayload } from '../shared/model-setting-rpc.mjs';

export const SIRI_RPC_CHANNEL = '/siri';
export const SIRI_ENDPOINTS = Object.freeze({
  status: 'connection.status',
  updateSettings: 'siri.settings.update',
  resetApiKey: 'siri.api-key.reset',
  reconnect: 'bot.reconnect',
  dsBotStatus: 'ds-bot.status',
  bindDsBot: 'ds-bot.bind',
  unbindDsBot: 'ds-bot.unbind',
  setWorkspace: SET_WORKSPACE_ENDPOINT,
  setModel: SET_MODEL_ENDPOINT,
  setAgentPreset: SET_AGENT_PRESET_ENDPOINT,
  getSession: 'bot.session.get',
  setSession: 'bot.session.set',
  clearSession: 'bot.session.clear',
});
export const SIRI_RPC_ENDPOINTS = Object.freeze(Object.values(SIRI_ENDPOINTS));

/** Spoken-facing messages for the Session switch endpoints. */
const SESSION_ERROR_MESSAGES = Object.freeze({
  'session-id-invalid': '会话 ID 格式不对。',
  'siri-not-ready': 'Siri 接口尚未就绪，请稍后重试。',
});

const CANCELLED = { ok: false, error: { code: 'cancelled', message: 'The request was cancelled.', details: {} } };

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, allowed) {
  return isRecord(value) && Object.keys(value).every((key) => allowed.includes(key));
}

function payloadFailure(endpoint, payload) {
  if (!isRecord(payload)) return 'Payload must be an object.';
  if (endpoint === SIRI_ENDPOINTS.status || endpoint === SIRI_ENDPOINTS.resetApiKey
    || endpoint === SIRI_ENDPOINTS.reconnect || endpoint === SIRI_ENDPOINTS.getSession
    || endpoint === SIRI_ENDPOINTS.clearSession) {
    return exactKeys(payload, []) ? null : `${endpoint} does not accept fields.`;
  }
  if (endpoint === SIRI_ENDPOINTS.setSession) {
    return exactKeys(payload, ['sessionId']) && typeof payload.sessionId === 'string'
      && SESSION_ID_PATTERN.test(payload.sessionId) ? null : '请提供有效的会话 ID。';
  }
  if (endpoint === SIRI_ENDPOINTS.dsBotStatus || endpoint === SIRI_ENDPOINTS.unbindDsBot) {
    return exactKeys(payload, []) ? null : `${endpoint} does not accept fields.`;
  }
  if (endpoint === SIRI_ENDPOINTS.bindDsBot) {
    return exactKeys(payload, ['dsBotId']) && typeof payload.dsBotId === 'string'
      && /^[A-Za-z0-9_-]{1,128}$/u.test(payload.dsBotId) ? null : '请选择有效的 DS Bot。';
  }
  if (endpoint === SIRI_ENDPOINTS.updateSettings) {
    if (!exactKeys(payload, ['port', 'host', 'timeoutMs', 'enabled', 'name', 'guidance', 'rateLimitPerMinute', 'allowedAddresses'])) {
      return 'siri.settings.update received unsupported fields.';
    }
    if (payload.port !== undefined && !(Number.isSafeInteger(payload.port) && payload.port >= 1 && payload.port <= 65_535)) {
      return '请输入 1–65535 之间的端口。';
    }
    if (payload.host !== undefined && !(typeof payload.host === 'string' && payload.host.trim() && payload.host.length <= 255)) {
      return '请输入有效的监听地址。';
    }
    if (payload.timeoutMs !== undefined && payload.timeoutMs !== null
      && !(Number.isSafeInteger(payload.timeoutMs) && payload.timeoutMs >= 1_000 && payload.timeoutMs <= 120_000)) {
      return '等待时长需在 1–120 秒之间。';
    }
    if (payload.enabled !== undefined && typeof payload.enabled !== 'boolean') return 'enabled must be a boolean.';
    if (payload.name !== undefined && !(typeof payload.name === 'string' && payload.name.trim() && payload.name.length <= 80)) {
      return '请输入有效的名称（最多 80 个字符）。';
    }
    if (payload.guidance !== undefined && !(typeof payload.guidance === 'string' && payload.guidance.length <= 2000)) {
      return '指引最多 2000 个字符。';
    }
    if (payload.rateLimitPerMinute !== undefined
      && !(Number.isSafeInteger(payload.rateLimitPerMinute) && payload.rateLimitPerMinute >= 0 && payload.rateLimitPerMinute <= 600)) {
      return '每分钟请求数需在 0–600 之间（0 表示不限）。';
    }
    if (payload.allowedAddresses !== undefined
      && !(Array.isArray(payload.allowedAddresses) && payload.allowedAddresses.length <= 64
        && payload.allowedAddresses.every(validSiriAllowedAddress))) {
      return '允许的来源地址格式不对，请填 IP 或 IPv4 网段（如 192.168.1.0/24）。';
    }
    return null;
  }
  if (endpoint === SIRI_ENDPOINTS.setWorkspace) {
    return validWorkspacePayload(payload) ? null : '请输入工作区绝对路径。';
  }
  if (endpoint === SIRI_ENDPOINTS.setModel) return validModelPayload(payload) ? null : '请选择有效模型。';
  if (endpoint === SIRI_ENDPOINTS.setAgentPreset) {
    return validAgentPresetPayload(payload) ? null : '请选择 Agent Preset。';
  }
  return 'Unknown Siri endpoint.';
}

export function createSiriRpcHandler(controller) {
  const diagnostics = controller.diagnostics ?? createConnectionDiagnostics({ channel: 'siri' });
  for (const method of ['status', 'updateSettings', 'resetApiKey', 'reconnect']) {
    if (typeof controller?.[method] !== 'function') {
      throw new TypeError(`A complete Siri controller is required (${method})`);
    }
  }
  return async (endpoint, payload, signal) => {
    if (signal?.aborted) return CANCELLED;
    if (!SIRI_RPC_ENDPOINTS.includes(endpoint)) {
      return { ok: false, error: { code: 'bad-request', message: 'Unknown Siri endpoint.', details: {} } };
    }
    const invalid = payloadFailure(endpoint, payload);
    if (invalid) return { ok: false, error: { code: 'bad-request', message: invalid } };
    try {
      let value;
      if (endpoint === SIRI_ENDPOINTS.status) value = await controller.status();
      else if (endpoint === SIRI_ENDPOINTS.updateSettings) value = await controller.updateSettings(payload);
      else if (endpoint === SIRI_ENDPOINTS.resetApiKey) value = await controller.resetApiKey();
      else if (endpoint === SIRI_ENDPOINTS.reconnect) value = await controller.reconnect();
      else if (endpoint === SIRI_ENDPOINTS.dsBotStatus) value = await controller.dsBotStatus();
      else if (endpoint === SIRI_ENDPOINTS.bindDsBot) value = await controller.bindDsBot(payload.dsBotId);
      else if (endpoint === SIRI_ENDPOINTS.unbindDsBot) value = await controller.unbindDsBot();
      else if (endpoint === SIRI_ENDPOINTS.setWorkspace) {
        value = await controller.updateWorkspace(payload.botId, payload.workspace);
      } else if (endpoint === SIRI_ENDPOINTS.setModel) {
        value = await controller.updateModel(payload.botId, payload.model);
      } else if (endpoint === SIRI_ENDPOINTS.getSession) {
        value = { sessionId: controller.sessionId() };
      } else if (endpoint === SIRI_ENDPOINTS.setSession) {
        value = { sessionId: await controller.setSession(payload.sessionId) };
      } else if (endpoint === SIRI_ENDPOINTS.clearSession) {
        value = { sessionId: await controller.clearSession() };
      } else {
        value = await controller.updateAgentPreset(payload.botId, payload.agentPreset);
      }
      return signal?.aborted ? CANCELLED : { ok: true, value };
    } catch (error) {
      if (typeof error?.code === 'string' && DS_BOT_ERROR_MESSAGES[error.code]) {
        return { ok: false, error: { code: error.code, message: DS_BOT_ERROR_MESSAGES[error.code], details: {} } };
      }
      if (typeof error?.code === 'string' && SESSION_ERROR_MESSAGES[error.code]) {
        return { ok: false, error: { code: error.code, message: SESSION_ERROR_MESSAGES[error.code], details: {} } };
      }
      const workspaceError = publicWorkspaceError(error);
      return diagnosticRpcResult(diagnostics, error, signal?.aborted
        ? CANCELLED
        : { ok: false, error: workspaceError
          ? { ...workspaceError, details: {} }
          : { code: 'siri-operation-failed', message: 'Siri 操作失败，请稍后重试。', details: {} } },
      { operation: endpoint });
    }
  };
}

export function installSiriRpc(ctx, controller, options, authority) {
  return registerManagementRpc(ctx, SIRI_RPC_CHANNEL, createSiriRpcHandler(controller, options),
    { authority: resolveRpcAuthority(authority) });
}
