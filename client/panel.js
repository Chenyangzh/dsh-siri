import * as React from 'react';
const h = React.createElement;
import { SIRI_ENDPOINTS, siriBot, unwrapSiriResult } from './api.js';
import { WorkspaceDirectoryPickerContext, WorkspaceEditor } from './workspace-editor.js';
import { ModelCatalogContext, ModelEditor, EMPTY_MODEL_CATALOG } from './model-setting.js';
import { AgentPresetCatalogContext, AgentPresetEditor, EMPTY_AGENT_PRESET_CATALOG } from './agent-preset.js';

export function SiriLogoGlyph({ size } = {}) {
  return h('svg', {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'currentColor',
    'aria-hidden': 'true', focusable: 'false', 'data-im-channel-logo': 'siri',
  }, h('path', {
    d: 'M12 14.5a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5.5a3 3 0 0 0 3 3Zm5-3a1 1 0 1 1 2 0 7 7 0 0 1-6 6.93V21a1 1 0 1 1-2 0v-2.57A7 7 0 0 1 5 11.5a1 1 0 1 1 2 0 5 5 0 0 0 10 0Z',
  }));
}

/** Every address the phone could use: the one this page was opened on, then the Host's LAN addresses. */
function endpointsFor(bot) {
  const host = globalThis.location?.hostname;
  const browserHost = host && host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]' ? host : null;
  const lan = Array.isArray(bot.lanAddresses) ? bot.lanAddresses.filter((item) => typeof item === 'string') : [];
  const addresses = [...new Set([browserHost, ...lan].filter(Boolean))];
  if (addresses.length === 0) addresses.push('<这台 Mac 的地址>');
  return addresses.map((address) => `http://${address}:${bot.port}/siri`);
}

const DS_BOT_NOTICES = {
  missing: '未安装 DS Bot，请先在 DSH 插件管理中安装 ds-bot，然后刷新。',
  disabled: 'DS Bot 尚未启用，请在 DSH 插件管理中启用后刷新。',
  unavailable: '暂时无法读取 DS Bot，请检查插件是否正常运行后重试。',
  readonly: 'DS Bot 当前由其他 Host 管理，请在运行它的 Host 中绑定。',
};

export function SiriSettingsTab({ rpcCall, directoryPicker }) {
  const [bot, setBot] = React.useState(null);
  const [catalogs, setCatalogs] = React.useState({});
  const [dsBots, setDsBots] = React.useState(null);
  const [dsBotChoice, setDsBotChoice] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [revealed, setRevealed] = React.useState(false);
  const [copied, setCopied] = React.useState('');
  const [draft, setDraft] = React.useState({ port: '', timeout: '', name: '', guidance: '', rate: '', addresses: '' });

  const apply = React.useCallback((snapshot) => {
    const next = siriBot(snapshot);
    setBot(next);
    setCatalogs({ model: snapshot?.modelCatalog, preset: snapshot?.agentPresetCatalog });
    if (next) {
      setDraft({
        port: String(next.port ?? ''),
        timeout: next.timeoutMs ? String(Math.round(next.timeoutMs / 1000)) : '',
        name: next.name ?? '',
        guidance: next.guidance ?? '',
        rate: next.rateLimitPerMinute ? String(next.rateLimitPerMinute) : '',
        addresses: (next.allowedAddresses ?? []).join('\n'),
      });
    }
  }, []);

  const run = React.useCallback(async (endpoint, payload = {}) => {
    setBusy(true); setError('');
    try {
      apply(unwrapSiriResult(await rpcCall(endpoint, payload)));
    } catch (failure) {
      setError(failure?.message || 'Siri 操作失败，请稍后重试。');
    } finally {
      setBusy(false);
    }
  }, [rpcCall, apply]);

  React.useEffect(() => {
    let live = true;
    (async () => {
      try {
        const snapshot = unwrapSiriResult(await rpcCall(SIRI_ENDPOINTS.status, {}));
        if (live) apply(snapshot);
      } catch (failure) {
        if (live) setError(failure?.message || '无法读取 Siri 状态。');
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => { live = false; };
  }, [rpcCall, apply]);

  const loadDsBots = React.useCallback(async () => {
    try {
      const value = unwrapSiriResult(await rpcCall('ds-bot.status', {}));
      setDsBots(value);
      setDsBotChoice((current) => value.bots?.some((entry) => entry.id === current) ? current : '');
    } catch (failure) {
      setDsBots({ state: 'unavailable', bots: [], boundId: null });
      setError(failure?.message || '无法读取 DS Bot。');
    }
  }, [rpcCall]);
  React.useEffect(() => { void loadDsBots(); }, [loadDsBots]);
  const changeDsBot = async (endpoint, payload) => {
    setBusy(true); setError('');
    try {
      setDsBots(unwrapSiriResult(await rpcCall(endpoint, payload)));
      setDsBotChoice('');
    } catch (failure) {
      setError(failure?.message || 'DS Bot 绑定失败，请刷新后重试。');
    } finally {
      setBusy(false);
    }
  };

  const copy = async (label, value) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      setTimeout(() => setCopied(''), 1600);
    } catch {
      setError('复制失败，请手动选中后复制。');
    }
  };

  if (loading) {
    return h('div', { className: 'dsiri-card dim-siriPanel' }, h('p', null, '正在读取 Siri 状态…'));
  }
  if (!bot) {
    return h('div', { className: 'dsiri-card dim-siriPanel' },
      h('h3', null, 'Siri 暂不可用'),
      h('p', null, error || 'Host 还没有返回 Siri 通道，请稍后刷新。'));
  }

  const key = typeof bot.apiKey === 'string' ? bot.apiKey : '';
  const shownKey = revealed ? key : `${key.slice(0, 5)}${'•'.repeat(Math.max(0, key.length - 5))}`;
  const [endpoint, ...otherEndpoints] = endpointsFor(bot);
  const boundBot = dsBots?.boundId ? dsBots.bots.find((entry) => entry.id === dsBots.boundId) : null;
  const dsBotActive = Boolean(dsBots?.boundId);
  const savePort = Number(draft.port);
  const saveTimeout = draft.timeout.trim() === '' ? null : Number(draft.timeout) * 1000;
  const settingsValid = Number.isSafeInteger(savePort) && savePort >= 1 && savePort <= 65535
    && (saveTimeout === null || (Number.isSafeInteger(saveTimeout) && saveTimeout >= 1000 && saveTimeout <= 120000));
  const changed = savePort !== bot.port || (saveTimeout ?? null) !== (bot.timeoutMs ?? null);

  const addressList = draft.addresses.split(/[\s,;]+/u).map((item) => item.trim()).filter(Boolean);
  const rateValue = draft.rate.trim() === '' ? 0 : Number(draft.rate);
  const behaviourValid = draft.name.trim().length > 0 && draft.name.trim().length <= 80
    && draft.guidance.length <= 2000
    && Number.isSafeInteger(rateValue) && rateValue >= 0 && rateValue <= 600;
  const behaviourChanged = draft.name.trim() !== (bot.name ?? '')
    || draft.guidance.trim() !== (bot.guidance ?? '')
    || rateValue !== (bot.rateLimitPerMinute ?? 0)
    || addressList.join(',') !== (bot.allowedAddresses ?? []).join(',');
  const saveWorkspace = async (workspace) => {
    apply(unwrapSiriResult(await rpcCall('bot.workspace.set', { botId: bot.botId, workspace })));
  };
  const saveModel = async (model) => {
    apply(unwrapSiriResult(await rpcCall('bot.model.set', { botId: bot.botId, model })));
  };
  const savePreset = async (agentPreset) => {
    apply(unwrapSiriResult(await rpcCall('bot.preset.set', { botId: bot.botId, agentPreset })));
  };

  return h(WorkspaceDirectoryPickerContext.Provider, { value: directoryPicker },
  h(ModelCatalogContext.Provider, { value: catalogs.model ?? EMPTY_MODEL_CATALOG },
  h(AgentPresetCatalogContext.Provider, { value: catalogs.preset ?? EMPTY_AGENT_PRESET_CATALOG },
  h('div', { className: 'dim-pageSiri dim-panel' },
    h('section', { className: 'dsiri-card dim-siriPanel' },
      h('h3', null, 'Siri 语音入口'),
      h('p', null, '对 Siri 说一句话，iPhone 快捷指令把它发到这台 Mac，DeepSeek Harness 回答后由 Siri 念出来。不依赖 Telegram 或任何第三方服务。'),
      h('span', { className: 'dim-siriState' },
        h('span', { className: 'dim-siriDot', 'data-ok': String(bot.connected === true) }),
        bot.enabled === false ? '已停用' : bot.connected ? `运行中 · 端口 ${bot.port}` : '未启动'),
      bot.error ? h('div', { className: 'dim-siriError' }, bot.error.message || '启动失败') : null,
      error ? h('div', { className: 'dim-siriError' }, error) : null,
      h('div', { className: 'dsiri-actions' },
        h('button', {
          type: 'button', className: 'dsiri-button', disabled: busy,
          onClick: () => run(SIRI_ENDPOINTS.updateSettings, { enabled: bot.enabled === false }),
        }, bot.enabled === false ? '启用' : '停用'),
        h('button', {
          type: 'button', className: 'dsiri-button', disabled: busy || bot.enabled === false,
          onClick: () => run(SIRI_ENDPOINTS.reconnect, {}),
        }, '重新启动监听'))),

    h('section', { className: 'dsiri-card dim-siriPanel' },
      h('h3', null, '绑定 DS Bot'),
      h('p', null, '绑定后，对 Siri 说的话直接发给这个 DS Bot，沿用它的会话、记忆和角色。不绑定则使用下面“会话环境”里的普通会话。'),
      !dsBots ? h('p', null, '正在检测 DS Bot…')
        : dsBots.state !== 'ready' ? h('p', { className: 'dim-siriHint' }, DS_BOT_NOTICES[dsBots.state] ?? DS_BOT_NOTICES.unavailable)
        : !dsBots.bots.length ? h('p', { className: 'dim-siriHint' }, '还没有 DS Bot，请先在 DS Bot 中创建后刷新。')
        : h('div', { className: 'dim-siriRow' },
            dsBots.boundId
              ? h('span', { className: 'dim-siriState' },
                  h('span', { className: 'dim-siriDot', 'data-ok': 'true' }),
                  `已绑定：${dsBots.bots.find((entry) => entry.id === dsBots.boundId)?.name ?? dsBots.boundId}`)
              : h('span', { className: 'dim-siriHint' }, '当前未绑定。'),
            h('div', { className: 'dim-siriValue' },
              h('select', {
                className: 'dsiri-input', value: dsBotChoice, disabled: busy,
                'aria-label': 'DS Bot', onChange: (event) => setDsBotChoice(event.target.value),
              }, h('option', { value: '' }, '选择 DS Bot…'),
                dsBots.bots.map((entry) => h('option', { key: entry.id, value: entry.id }, entry.name))),
              h('button', {
                type: 'button', className: 'dsiri-button', 'data-kind': 'primary',
                disabled: busy || !dsBotChoice || dsBotChoice === dsBots.boundId,
                onClick: () => changeDsBot('ds-bot.bind', { dsBotId: dsBotChoice }),
              }, '保存绑定'),
              dsBots.boundId ? h('button', {
                type: 'button', className: 'dsiri-button', disabled: busy,
                onClick: () => changeDsBot('ds-bot.unbind', {}),
              }, '解除绑定') : null),
            h('p', { className: 'dim-siriHint' }, '接口也可以在每次请求里指定 Bot：{"text":"…","bot":"秘书"}，填名称（可只写一部分）或 ID，不填就用这里绑定的。解除绑定后聊天记录保留。'))),

    h('section', { className: 'dsiri-card dim-siriPanel', 'data-section': 'environment' },
      h('div', { className: 'dsiri-sectionHead' },
        h('h3', null, '会话环境'),
        dsBotActive ? h('span', { className: 'dsiri-pill', 'data-tone': 'info' }, 'DS Bot 接管中') : null),
      dsBotActive
        ? h('div', { className: 'dsiri-banner' },
            h('strong', null, `正在 DS Bot「${boundBot?.name ?? dsBots.boundId}」中工作`),
            h('span', null, '对话直接进入这个 Bot 的会话，使用它自己的工作区、模型和 Agent Preset，下面的设置暂不生效。解除 DS Bot 绑定后恢复。'))
        : h('p', null, 'Siri 的每句话都在这里设定的工作区里运行，沿用同一个会话，所以它记得你前面说过的话。'),
      h('div', { className: 'dsiri-env', 'data-overridden': String(dsBotActive), 'aria-disabled': dsBotActive },
        h(WorkspaceEditor, { workspace: bot.workspace, disabled: busy || dsBotActive, onSave: saveWorkspace }),
        h(ModelEditor, { model: bot.model, disabled: busy || dsBotActive, onSave: saveModel }),
        h(AgentPresetEditor, { agentPreset: bot.agentPreset, disabled: busy || dsBotActive, onSave: savePreset }))),

    h('section', { className: 'dsiri-card dim-siriPanel' },
      h('h3', null, 'API 密钥'),
      h('div', { className: 'dim-siriRow' },
        h('label', null, 'Bearer 密钥（快捷指令里填在 Authorization 头）'),
        key
          ? h('div', { className: 'dim-siriValue' },
              h('code', null, shownKey),
              h('button', { type: 'button', className: 'dsiri-button', onClick: () => setRevealed(!revealed) }, revealed ? '隐藏' : '显示'),
              h('button', { type: 'button', className: 'dsiri-button', onClick: () => copy('key', key) }, copied === 'key' ? '已复制' : '复制'))
          : h('p', null, '密钥尚未生成，请先启用并启动监听。')),
      h('p', { className: 'dim-siriHint' }, '重置后旧密钥立即失效，需要同步更新快捷指令。'),
      h('div', { className: 'dsiri-actions' },
        h('button', {
          type: 'button', className: 'dsiri-button', disabled: busy,
          onClick: () => {
            if (globalThis.confirm?.('重置后旧密钥立即失效，确定要重置吗？') === false) return;
            setRevealed(true);
            run(SIRI_ENDPOINTS.resetApiKey, {});
          },
        }, '重置密钥'))),

    h('section', { className: 'dsiri-card dim-siriPanel' },
      h('h3', null, '连接设置'),
      h('div', { className: 'dim-siriRow' },
        h('label', null, '接口地址（POST，JSON：{"text": "…"}）'),
        h('div', { className: 'dim-siriValue' },
          h('code', null, endpoint),
          h('button', { type: 'button', className: 'dsiri-button', onClick: () => copy('url', endpoint) }, copied === 'url' ? '已复制' : '复制'))),
      otherEndpoints.length > 0
        ? h('p', { className: 'dim-siriHint' }, `其他可用地址：${otherEndpoints.join('、')}`)
        : null,
      h('div', { className: 'dim-siriFields' },
        h('div', { className: 'dim-siriRow' },
          h('label', { htmlFor: 'dim-siri-port' }, '端口'),
          h('input', {
            id: 'dim-siri-port', inputMode: 'numeric', value: draft.port,
            onChange: (event) => setDraft({ ...draft, port: event.target.value.trim() }),
          })),
        h('div', { className: 'dim-siriRow' },
          h('label', { htmlFor: 'dim-siri-timeout' }, '最长等待（秒，留空用默认 26）'),
          h('input', {
            id: 'dim-siri-timeout', inputMode: 'numeric', value: draft.timeout,
            onChange: (event) => setDraft({ ...draft, timeout: event.target.value.trim() }),
          }))),
      h('div', { className: 'dsiri-actions' },
        h('button', {
          type: 'button', className: 'dsiri-button', 'data-kind': 'primary',
          disabled: busy || !settingsValid || !changed,
          onClick: () => run(SIRI_ENDPOINTS.updateSettings, { port: savePort, timeoutMs: saveTimeout }),
        }, busy ? '正在保存…' : '保存')),
      h('p', { className: 'dim-siriHint' }, '监听 0.0.0.0，手机和 Mac 在同一 Wi-Fi 下用 Mac 的局域网地址访问；出门时用 Tailscale 等内网穿透地址。')),

    h('section', { className: 'dsiri-card dim-siriPanel' },
      h('h3', null, '回答方式与限制'),
      h('div', { className: 'dim-siriRow' },
        h('label', { htmlFor: 'dim-siri-name' }, '名称（显示在会话标题里）'),
        h('input', {
          id: 'dim-siri-name', className: 'dsiri-input', value: draft.name, maxLength: 80,
          onChange: (event) => setDraft({ ...draft, name: event.target.value }),
        })),
      h('div', { className: 'dim-siriRow' },
        h('label', { htmlFor: 'dim-siri-guidance' }, '语音指引（每次请求前自动附带，例如“用口语简短回答，不要列清单”）'),
        h('textarea', {
          id: 'dim-siri-guidance', className: 'dsiri-input', rows: 3, value: draft.guidance, maxLength: 2000,
          onChange: (event) => setDraft({ ...draft, guidance: event.target.value }),
        })),
      h('div', { className: 'dim-siriFields' },
        h('div', { className: 'dim-siriRow' },
          h('label', { htmlFor: 'dim-siri-rate' }, '每分钟最多请求数（留空不限）'),
          h('input', {
            id: 'dim-siri-rate', className: 'dsiri-input', inputMode: 'numeric', value: draft.rate,
            onChange: (event) => setDraft({ ...draft, rate: event.target.value.trim() }),
          }))),
      h('div', { className: 'dim-siriRow' },
        h('label', { htmlFor: 'dim-siri-addresses' }, '允许的来源地址（每行一个 IP 或网段，如 192.168.1.0/24；留空表示都允许）'),
        h('textarea', {
          id: 'dim-siri-addresses', className: 'dsiri-input', rows: 3, value: draft.addresses,
          onChange: (event) => setDraft({ ...draft, addresses: event.target.value }),
        })),
      h('p', { className: 'dim-siriHint' }, '本机（127.0.0.1）始终允许。限制来源后，请先确认手机访问时的地址在范围内，否则快捷指令会被拒绝。'),
      h('div', { className: 'dsiri-actions' },
        h('button', {
          type: 'button', className: 'dsiri-button', 'data-kind': 'primary',
          disabled: busy || !behaviourValid || !behaviourChanged,
          onClick: () => run(SIRI_ENDPOINTS.updateSettings, {
            name: draft.name.trim(), guidance: draft.guidance.trim(),
            rateLimitPerMinute: rateValue, allowedAddresses: addressList,
          }),
        }, busy ? '正在保存…' : '保存'))),

    h('section', { className: 'dsiri-card dim-siriPanel' },
      h('h3', null, '快捷指令怎么配'),
      h('ol', { className: 'dim-siriSteps' },
        h('li', null, '新建快捷指令，添加“听写文本”。'),
        h('li', null, '添加“获取 URL 内容”：URL 填上面的接口地址，方法 POST，请求体选 JSON，加字段 text = 听写的文本。'),
        h('li', null, '在该动作的“头”里加 Authorization = Bearer 加空格再加上面的密钥。'),
        h('li', null, '添加“从字典获取值”，键填 reply，再接“朗读文本”。'),
        h('li', null, '任务较慢时 Siri 会先说“还在处理”，之后对她说“刚才的结果”：用 GET 访问 …/siri/last，取键 reply 朗读。')))))));
}
