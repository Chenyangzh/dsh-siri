# dsh-siri

用 Siri 和 iPhone 快捷指令对话 DeepSeek Harness。Talk to DeepSeek Harness with Siri and iPhone Shortcuts.

对 Siri 说一句话,快捷指令把它 `POST` 到这台 Mac 上的 `/siri`,Harness 回答后由 Siri 念出来。
独立插件,不依赖 Telegram 或任何第三方服务。

## 接口

| 方法与路径 | 作用 |
| --- | --- |
| `POST /siri` | 请求体 `{"text": "…"}`,返回 `{"reply": "…"}` |
| `GET /siri/last` | 取上一轮的结果(任务太慢时 Siri 先说"还在处理";也可以直接对 Siri 说"刚才的结果") |
| `GET /siri/health` | 检查密钥是否有效 |

`POST /siri` 的请求体还可以带 `"bot"`(DS Bot 的名称或 ID,名称可只写一部分),让这一句话发给指定的 DS Bot;不带则用设置页里绑定的 DS Bot,没绑定就用普通会话。

出错时响应里同样带 `reply`(例如"密钥不对""没有找到这个 DS Bot"),快捷指令照常念出来,不会无声失败。

所有请求都要带 `Authorization: Bearer <密钥>`。密钥、端口、等待时长在 DSH 设置里的 **Siri 语音** 页管理。

## 快捷指令

现成的模板:[Hey DSH 快捷指令(iCloud 链接)](https://www.icloud.com/shortcuts/49fc2d6ae605418a8961f151a7cda184),也可以直接用仓库里已签名的 `shortcuts/Hey DSH.shortcut`(由 `scripts/make-shortcut.py` 生成)。

1. 在 iPhone 上打开这个文件(AirDrop、iCloud 链接或“文件”App 都行),点“添加快捷指令”。
2. 添加时系统会问三个问题,填完即可,之后不用再填:
   - **接口地址**:DSH 设置里“Siri 语音”页显示的地址,形如 `http://地址:8000/siri`
   - **密钥**:同一页点“显示”再复制
   - **DS Bot 名称**:可留空,留空则用设置页里绑定的 Bot
3. 对 Siri 说“Hey DSH”,然后说话。

想自己搭:听写文本 → 获取 URL 内容(POST,JSON 请求体 `text`,头部 `Authorization: Bearer 密钥`)→ 从字典获取值(键 `reply`)→ 朗读文本。

分享快捷指令时,请分享这个模板而不是你自己用的那份:你的那份里带着你的密钥和地址。

## 构建

```bash
npm install
npm run build
npm test
```

构建会把 `plugin-src/` 与 `src/` 打成 `lib/index.js`(Host)和 `lib/client.js`(设置页)。

## 功能

- Siri 语音入口:`POST /siri`,Bearer 密钥鉴权,监听端口、等待时长可配置。
- 在 DSH 设置里新增“Siri 语音”页:查看和重置密钥、改端口、选工作区/模型/Agent Preset、写语音指引、限频、限制来源地址。
- 绑定 DS Bot:对 Siri 说的话直接进入所选 DS Bot 的会话;请求里可用 `bot` 字段临时指定另一个 Bot。
- DS Bot 提问(实验性):Bot 用 `ask_user` 提问时,Siri 念出问题和选项,下一句话作为回答交给 Bot。
- 接续已有会话:管理接口 `bot.session.get` / `bot.session.set` / `bot.session.clear` 可以读出、切换或清除 Siri 当前绑定的会话,下一次请求立即生效,不需要重启插件。
- 会话失效自愈:绑定的会话被归档或删除后,下一条消息会自动在新会话里继续,并在回答前说明原会话的历史不会带入。

## 要求

- 已安装 DeepSeek Harness,并启用本插件;使用 DS Bot 功能需要同时安装并启用 `ds-bot`。
- 手机能访问到运行 DeepSeek Harness 的这台电脑(同一 Wi-Fi,或 Tailscale 等内网穿透)。
- 接口只做了 Bearer 密钥鉴权,没有 HTTPS;不要直接暴露到公网。

## 致谢

`src/channels/shared/` 与 `plugin-src/host/` 中的一部分文件取自 [dsh-im](https://github.com/xmanrui/dsh-im)(MIT,作者 xmanrui),保留其版权声明,见 `LICENSE`。
