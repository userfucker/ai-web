# 插件 ⇄ 中转站 协议（1.0）

插件后台用 WebSocket 连 `ws://<中转站 IP>:<端口>/ext`，消息都是 JSON 文字。

## 连接

插件连上后先发：

```json
{ "type": "hello", "role": "extension", "token": "口令", "name": "书房电脑", "version": "1.0.0",
  "sites": [ { "site": "deepseek", "name": "DeepSeek", "open": true, "ready": true, "tabId": 1, "url": "…", "chatId": "…" }, … ] }
```

中转站回：
- 口令对：`{ "type": "welcome", "server": "名字" }`
- 口令不对：`{ "type": "error", "error": "口令不对", "fatal": true }`，然后断开。`fatal` 的错误插件不会自动重连。
- `hello` 里带 `"test": true` 的是设置页的“测试连接”，回 `welcome` 后断开即可。

心跳：
- 插件每 20 秒发 `{ "type": "ping", "t": 毫秒 }`，中转站回 `{ "type": "pong", "t": … }`（不回也行）。
- 中转站发 `ping`，插件会回 `pong`。

断线以后插件自动重连，间隔 1、2、4… 秒，最长 30 秒。

## 命令

中转站 → 插件：

```json
{ "type": "cmd", "id": "唯一编号", "site": "deepseek | glm | kimi | qwen", "cmd": "命令", "args": { … } }
```

插件 → 中转站，每个命令一个结果：

```json
{ "type": "result", "id": "同一个编号", "site": "…", "cmd": "…", "ok": true, "data": { … } }
```

失败时 `ok: false`，`data.error` 是中文原因。同一个网站的命令最好排队发（上一个有结果再发下一个）。不同网站可以同时发。

| 命令 | args | data |
| --- | --- | --- |
| `status`（site 随便填） | — | `{ version, sites: [ {site, name, open, ready, tabId, url, chatId} ] }` |
| `open` | `timeoutMs?` | 没打开就新开一个窗口，等页面能用；返回网站状态 |
| `focus` | — | 把这个网站的窗口切到前台 |
| `reload` | — | 刷新页面，等能用 |
| `state` | — | `{ url, chatId, generating, inputReady, title }` |
| `ready` | `timeoutMs?` | 等输入框能用（最多 60 秒），能识别没登录 |
| `newChat` | — | 新建对话。千问是跳到首页，插件会等新页面准备好 |
| `send` | `text` | 写进输入框并发送，确认回复接口已经开始；`{ method, how, chatId }` |
| `wait` | `timeoutMs?`（默认 300000） | 等回复完成；`{ answer, thinking, done, error, firstTokenSec, totalSec, chatId, url }` |
| `ask` | `text, newChat?, timeoutMs?` | 等于 newChat（可选）+ send + wait；生成中会发 `progress` |
| `read` | — | 读当前（最后一次）回复，不等待 |
| `generating` | — | `{ generating }` |
| `stop` | — | 点“停止生成”（Kimi、千问有；DeepSeek / 智谱清言要看网站） |
| `listChats` | `max?`（默认 200） | `{ count, list: [ {id, title, updatedAt(毫秒), pinned, url} ], current }` |
| `deleteChats` | `ids: [ … ]` | `{ deleted, failed, results: [ {id, ok, how: "接口"/"界面", error?} ] }` |
| `openChat` | `chatId` 或 `url` | 打开某个会话，等页面能用；返回网站状态 |

说明：
- `answer` 是 Markdown，**不含思考过程**。`thinking` 里是思考过程，需要的话可以自己存。
- `chatId` 是网站自己的会话 id，可以存起来，以后 `openChat` 回到这个会话。
- 删除方式：
  - DeepSeek、千问：直接调网站接口，可以批量；
  - Kimi：先调接口，不行就点界面；
  - 智谱清言：请求有签名，只能点界面，一个一个删。同名会话分不清时不删，`error` 里会写原因。

## 进度和事件（插件 → 中转站）

```json
{ "type": "progress", "id": "ask 命令的编号", "site": "kimi", "answer": "到目前为止的回答全文", "thinkingLen": 120, "done": false }
{ "type": "event", "event": "tab", "site": "kimi", "data": { "open": true, "ready": true, "url": "…", "chatId": "…" } }
```

- `progress` 最多半秒一次，`answer` 每次都是全文（不是增量）。
- `event: tab`：网站标签页打开、关闭、刷新、页面准备好时发。
