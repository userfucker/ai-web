/**
 * AI Bridge · 四个站点的适配器配置（2026-10-14，根据第一轮采样报告写的）
 *
 * 每个站点：
 *  - input / send / stop：输入框、发送按钮、“停止生成”按钮的选择器（按顺序试，第一个找到的算）
 *  - insert：往输入框写字的方式（textarea 用 setter；Lexical 用 execCommand；Slate 用 beforeinput）
 *  - sendBy：click 点发送按钮 / enter 按回车
 *  - home：新对话的网址（点“新对话”按钮没反应时直接打开这个网址）
 *  - stream：回复的流式接口地址
 *  - parse(全文)：把流式接口到目前为止收到的全部文字解析成 { answer, thinking, done, error }
 *    answer 是最终回答（Markdown，不含思考过程），done 表示网站说回复已结束
 *  - dom：读页面上最后一条回复的选择器（网络读不到时的备用，也用来对照）
 *  - chatUrl(id) / chatId()：会话的网址、当前打开的会话 id
 *  - listChats(h, max) / deleteChats(h, ids)：会话列表、批量删除（根据第三轮采样报告）
 *      h.api(url, opts)：用网站自己的请求头代发请求，返回 { status, json, text }
 *      h.listCache()：网站自己请求到的会话列表（智谱清言有签名，只能这样拿）
 *      h.uiDelete(spec, id, title)：像人一样点“更多 → 删除 → 确认”
 *  - uiDelete：点界面删除时用的选择器 / 文字
 *
 * 会话统一成 { id, title, updatedAt（毫秒）, pinned, url }
 */
(() => {
  /** 按行取 SSE 的 data，带上 event 名 */
  function sseEvents(text) {
    const out = [];
    let ev = "message";
    for (const raw of text.split("\n")) {
      const line = raw.replace(/\r$/, "");
      if (!line) { ev = "message"; continue; }
      if (line.startsWith("event:")) { ev = line.slice(6).trim(); continue; }
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      let json = null;
      try { json = JSON.parse(data); } catch {}
      out.push({ event: ev, data, json });
    }
    return out;
  }
  /** 文字里所有顶层的 {...} JSON（不管它们之间夹着什么，比如 connect 协议的二进制长度头） */
  function jsonObjects(text) {
    const out = [];
    let depth = 0, start = -1, inStr = false, escp = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inStr) { if (escp) escp = false; else if (c === "\\") escp = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') { if (depth > 0) inStr = true; continue; }
      if (c === "{") { if (depth === 0) start = i; depth++; }
      else if (c === "}" && depth > 0) {
        depth--;
        if (depth === 0) { try { out.push(JSON.parse(text.slice(start, i + 1))); } catch {} }
      }
    }
    return out;
  }
  /** 收到的不是流而是一个报错 JSON（额度用完、需要登录、风控……） */
  function plainError(text) {
    const t = text.trim();
    if (!t.startsWith("{")) return null;
    try {
      const j = JSON.parse(t);
      const code = j.code ?? j.error_code ?? j.status;
      const msg = j.msg ?? j.message ?? j.error_msg ?? (j.error && (j.error.message || j.error));
      if ((code !== undefined && code !== 0 && code !== 200) || msg) return `${code ?? ""} ${typeof msg === "string" ? msg : JSON.stringify(msg || j)}`.trim();
    } catch {}
    return null;
  }

  const ok = (r, test) => r && r.status === 200 && r.json && test(r.json);
  const apiErr = (r) => r ? `接口返回 ${r.status}${r.error ? " " + r.error : ""} ${String(r.text || "").slice(0, 160)}` : "没有返回";
  const chunk = (a, n) => { const out = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; };

  const DS_DROP = ["x-ds-pow-response", "x-hif-leim", "x-hif-dliq", "x-thinking-enabled", "content-type"]; // 只在发消息时用的一次性请求头

  const SITES = {
    // ------------------------------------------------------------ DeepSeek
    deepseek: {
      name: "DeepSeek",
      home: "https://chat.deepseek.com/",
      isFresh: () => location.pathname === "/",
      input: ['textarea[name="search"]', "textarea"],
      insert: "setter",
      send: ['div[role="button"].ds-button--primary.ds-button--circle:not(.ds-button--disabled)'],
      sendBy: "click",
      newChat: { text: /^开启新对话$/ },
      stream: /\/api\/v0\/chat\/completion/,
      dom: ".ds-message .ds-markdown, .ds-markdown",
      chatUrl: (id) => `https://chat.deepseek.com/a/chat/s/${id}`,
      chatId: () => (/\/a\/chat\/s\/([\w-]+)/.exec(location.pathname) || [])[1] || null,
      // GET /api/v0/chat_session/fetch_page?lte_cursor.pinned=false → data.biz_data.chat_sessions[]、has_more
      async listChats(h, max) {
        const out = [], seen = new Set();
        let cursor = null;
        for (let page = 0; page < 50 && out.length < max; page++) {
          let q = "lte_cursor.pinned=false";
          if (cursor) q += `&lte_cursor.updated_at=${encodeURIComponent(cursor.updated_at)}&lte_cursor.id=${encodeURIComponent(cursor.id)}`;
          const r = await h.api(`https://chat.deepseek.com/api/v0/chat_session/fetch_page?${q}`, { dropHeaders: DS_DROP });
          if (!ok(r, (j) => j.code === 0)) throw new Error("获取列表失败：" + apiErr(r));
          const bd = r.json.data.biz_data || {};
          let added = 0;
          for (const c of bd.chat_sessions || []) {
            if (seen.has(c.id)) continue;
            seen.add(c.id); added++;
            out.push({ id: c.id, title: c.title, updatedAt: Math.round((c.updated_at || 0) * 1000), pinned: !!c.pinned, url: this.chatUrl(c.id) });
          }
          if (!bd.has_more || !added) break;
          cursor = (bd.chat_sessions || []).slice(-1)[0];
        }
        return out.slice(0, max);
      },
      // POST /api/v0/chat_session/delete {"chat_session_ids":[...]}，一次可以删多个
      async deleteChats(h, ids) {
        const res = [];
        for (const part of chunk(ids, 20)) {
          const r = await h.api("https://chat.deepseek.com/api/v0/chat_session/delete", { method: "POST", dropHeaders: DS_DROP, headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_session_ids: part }) });
          const good = ok(r, (j) => j.code === 0 && (!j.data || !j.data.biz_code));
          for (const id of part) res.push({ id, ok: good, how: "接口", error: good ? undefined : apiErr(r) });
        }
        return res;
      },
      uiDelete: {
        item: (id) => document.querySelector(`a[href$="/a/chat/s/${id}"]`),
        trigger: 'div[role="button"]',
        menu: ".ds-dropdown-menu-option", menuText: /^删除$/,
        confirm: '.ds-modal-content__button-group div[role="button"], [class*="ds-modal"] div[role="button"]', confirmText: /^删除(该对话)?$/,
      },
      // data: {"v":{"response":{"fragments":[{"type":"RESPONSE","content":"你好"}]}}}
      // data: {"p":"response/fragments/-1/content","o":"APPEND","v":"！"}  之后的 {"v":"..."} 都接着往这个路径追加
      // data: {"p":"response/fragments","o":"APPEND","v":[{"type":"THINK" / "RESPONSE", ...}]}  新的一段
      // data: {"p":"response/status","o":"SET","v":"FINISHED"}   event: close
      parse(text) {
        const frags = [];
        let path = null, done = false, error = null, status = null;
        const applyStr = (p, op, v) => {
          const m = /^response\/fragments\/(-?\d+)\/content$/.exec(p || "");
          if (!m) return;
          let i = Number(m[1]);
          if (i < 0) i = frags.length + i;
          if (!frags[i]) return;
          frags[i].content = op === "SET" ? v : frags[i].content + v;
        };
        const apply = (p, op, v) => {
          if (p === "response/fragments" && Array.isArray(v)) { for (const f of v) frags.push({ type: f.type, content: f.content || "" }); return; }
          if (p === "response/status" || p === "quasi_status" || p === "response/quasi_status") { status = v; if (v === "FINISHED") done = true; return; }
          if (p === "response" && op === "BATCH" && Array.isArray(v)) { for (const x of v) apply(x.p === "fragments" ? "response/fragments" : x.p, x.o, x.v); return; }
          if (typeof v === "string") applyStr(p, op, v);
        };
        for (const e of sseEvents(text)) {
          if (e.event === "close") done = true;
          if (e.event === "error") error = e.data;
          const j = e.json;
          if (!j || typeof j !== "object") continue;
          if (e.event !== "message") continue;
          if (j.v && typeof j.v === "object" && j.v.response) {
            frags.length = 0;
            for (const f of j.v.response.fragments || []) frags.push({ type: f.type, content: f.content || "" });
            if (j.v.response.status === "FINISHED") done = true;
            continue;
          }
          if (j.code !== undefined && j.msg) { error = `${j.code} ${j.msg}`; continue; }
          if (j.p !== undefined) path = j.p;
          apply(path, j.o, j.v);
        }
        if (!frags.length && !done) error = error || plainError(text);
        const pick = (re) => frags.filter((f) => re.test(f.type || "")).map((f) => f.content).join("");
        return { answer: pick(/RESPONSE|ANSWER|TEXT/i), thinking: pick(/THINK/i), done, error, status };
      },
    },

    // ------------------------------------------------------------ 智谱清言
    glm: {
      name: "智谱清言",
      home: "https://chatglm.cn/main/alltoolsdetail?lang=zh",
      isFresh: () => !/[?&]cid=/.test(location.search),
      input: ["textarea.scroll-display-none", "textarea"],
      insert: "setter",
      send: [".enter-icon-container:not(.empty)"],
      sendBy: "enter",
      newChat: { selector: "div.new-session", text: /^新对话$/ },
      stream: /\/backend-api\/assistant\/stream/,
      dom: ".conversation-item .markdown-body",
      chatUrl: (id) => `https://chatglm.cn/main/alltoolsdetail?lang=zh&cid=${id}`,
      chatId: () => new URLSearchParams(location.search).get("cid"),
      // 每个请求都有签名（X-Sign / X-Nonce / X-Timestamp + refer__991），没法代发：
      // 列表用网站自己请求到的 recent_list（{"page":n,"page_size":20} → result.conversation_list[]、has_more），
      // 不够就滚动侧边栏让它加载下一页
      async listChats(h, max) {
        const pages = async () => {
          const all = (await h.listCache()).filter((x) => /recent_list/.test(x.url));
          // 从最近一次第 1 页开始往后的那些才是现在的列表（删除后网站会重新拿第 1 页）
          let start = -1;
          all.forEach((x, i) => { try { if (JSON.parse(x.reqBody || "{}").page === 1) start = i; } catch {} });
          return start < 0 ? [] : all.slice(start);
        };
        let ps = await pages();
        if (!ps.length) throw new Error("还没拿到会话列表（网站加载列表的时候插件还没准备好），刷新页面再试");
        for (let k = 0; k < 30; k++) {
          const last = JSON.parse(ps[ps.length - 1].body || "{}").result || {};
          const count = ps.reduce((n, x) => n + ((JSON.parse(x.body || "{}").result || {}).conversation_list || []).length, 0);
          if (!last.has_more || count >= max) break;
          const before = ps.length;
          await h.scrollSidebar("#aside-history-list, .history-list");
          await h.waitFor(async () => (ps = await pages()).length > before, 5000);
          if (ps.length <= before) break;
        }
        const out = [], seen = new Set();
        for (const x of ps) for (const c of (JSON.parse(x.body || "{}").result || {}).conversation_list || []) {
          if (seen.has(c.conversation_id)) continue;
          seen.add(c.conversation_id);
          out.push({ id: c.conversation_id, title: c.title, updatedAt: (c.update_time || 0) * 1000, pinned: !!c.is_top, url: this.chatUrl(c.conversation_id), assistantId: c.assistant_id });
        }
        return out.slice(0, max);
      },
      // 删除也有签名：点界面（会话上的“…” → 删除对话 → 确认删除），一个一个删
      async deleteChats(h, ids) {
        const list = await this.listChats(h, 1000).catch(() => []);
        const res = [];
        for (const id of ids) {
          const c = list.find((x) => x.id === id);
          if (!c) { res.push({ id, ok: false, error: "列表里没有这个会话" }); continue; }
          const dup = list.filter((x) => x.title === c.title);
          if (dup.length > 1 && !dup.every((x) => ids.includes(x.id))) { res.push({ id, ok: false, error: `有 ${dup.length} 个同名会话“${c.title}”，界面上分不清是哪个，没删` }); continue; }
          res.push({ id, ...(await h.uiDelete(this.uiDelete, id, c.title)) });
        }
        return res;
      },
      uiDelete: {
        item: (id, title) => [...document.querySelectorAll("#aside-history-list .history-item, .history-item")].find((e) => (e.querySelector(".title") || e).innerText.trim() === title),
        trigger: ".option",
        menu: ".operate-item", menuText: /^删除对话$/,
        confirm: "div.btn.sure, .delete-fonfirm-content .btn, [class*='delete'] .btn", confirmText: /^(确认删除|删除|确定)$/,
        scroller: "#aside-history-list, .history-list",
      },
      // 每条 data 是整个回复对象，parts 里每一段有 logic_id：
      //   status=init 时 content 是新增的一小段，status=finish 时是这一段的全文
      //   content.type：think（思考）/ text（回答）/ tool_calls / tool_result（跑代码等）
      // 最外层 status=finish 表示整条回复结束
      parse(text) {
        const parts = new Map();
        let done = false, error = null;
        for (const e of sseEvents(text)) {
          const j = e.json;
          if (!j || typeof j !== "object") continue;
          if (j.status === "finish") done = true;
          if (j.status === "error" || j.status === "intervene") error = j.last_error && Object.keys(j.last_error).length ? JSON.stringify(j.last_error) : "status=" + j.status;
          for (const p of j.parts || []) {
            const key = p.logic_id || p.id;
            for (const c of p.content || []) {
              if (c.type !== "text" && c.type !== "think") continue;
              const k = key + ":" + c.type;
              const r = parts.get(k) || { type: c.type, acc: "", full: null };
              const v = typeof c[c.type] === "string" ? c[c.type] : "";
              if (p.status === "finish") r.full = v; else r.acc += v;
              parts.set(k, r);
            }
          }
        }
        if (!parts.size && !done) error = error || plainError(text);
        const pick = (t) => [...parts.values()].filter((r) => r.type === t).map((r) => r.full ?? r.acc).filter(Boolean).join("\n\n");
        return { answer: pick("text"), thinking: pick("think"), done, error };
      },
    },

    // ------------------------------------------------------------ Kimi
    kimi: {
      name: "Kimi",
      home: "https://www.kimi.com/",
      isFresh: () => location.pathname === "/",
      input: ['div[role="textbox"][data-lexical-editor="true"]', '[contenteditable="true"]'],
      insert: "execCommand",
      send: ["div.send-button-container:not(.disabled):not(.stop):not(.loading)"],
      stop: ["div.send-button-container.stop"],
      sendBy: "click",
      newChat: { selector: 'a[aria-label="新建会话"]' },
      stream: /ChatService\/Chat(\?|$)/,
      dom: ".segment-assistant .segment-content",
      chatUrl: (id) => `https://www.kimi.com/chat/${id}`,
      chatId: () => (/^\/chat\/([\w-]{16,})/.exec(location.pathname) || [])[1] || null,
      // POST /apiv2/kimi.gateway.feed.v1.FeedService/ListFeeds（connect 协议的普通 JSON 请求）→ items[].chat
      async listChats(h, max) {
        const out = [], seen = new Set();
        let token = "";
        for (let page = 0; page < 50 && out.length < max; page++) {
          const body = { page_size: 50, project_id: "", filter_types: ["FEED_TYPE_CHAT"], include_pinned: true };
          if (token) body.page_token = token;
          const r = await h.api("https://www.kimi.com/apiv2/kimi.gateway.feed.v1.FeedService/ListFeeds", { method: "POST", headers: { "content-type": "application/json", "connect-protocol-version": "1" }, body: JSON.stringify(body) });
          if (!ok(r, (j) => Array.isArray(j.items) || !j.code)) throw new Error("获取列表失败：" + apiErr(r));
          let added = 0;
          for (const it of r.json.items || []) {
            const c = it.chat;
            if (!c || seen.has(c.id)) continue;
            seen.add(c.id); added++;
            out.push({ id: c.id, title: c.name, updatedAt: Date.parse(c.updateTime || c.createTime || "") || 0, pinned: !!(it.pinned || c.pinned), url: this.chatUrl(c.id) });
          }
          token = r.json.nextPageToken || r.json.next_page_token || "";
          if (!token || !added) break;
        }
        return out.slice(0, max);
      },
      // POST /apiv2/kimi.chat.v1.ChatService/DeleteChat {"chat_id":...}，一次一个；接口不行就点界面
      async deleteChats(h, ids) {
        const res = [];
        for (const id of ids) {
          const r = await h.api("https://www.kimi.com/apiv2/kimi.chat.v1.ChatService/DeleteChat", { method: "POST", headers: { "content-type": "application/json", "connect-protocol-version": "1" }, body: JSON.stringify({ chat_id: id }) });
          if (ok(r, (j) => j.chatId === id || j.chat_id === id || (!j.code && !j.message))) { res.push({ id, ok: true, how: "接口" }); continue; }
          const ui = await h.uiDelete(this.uiDelete, id);
          res.push({ id, ...ui, apiError: apiErr(r) });
        }
        return res;
      },
      uiDelete: {
        item: (id) => { const a = document.querySelector(`a[href*="/chat/${id}"]`); return a && (a.closest('[class*="next-sidebar-history-item"]:not(a)') || a.parentElement); },
        trigger: 'button[aria-haspopup="menu"]',
        menu: ".kimi-menu-item, [role='menuitem']", menuText: /^删除$/,
        confirm: 'button[data-testid="confirm-dialog-confirm"]', confirmText: /^删除$/,
      },
      // connect+json：每条消息是一个 JSON
      //   {"op":"set"/"append","mask":"block.text.content","block":{"id":"4","text":{"content":"下面"}}}  回答
      //   block.think.content 是思考过程；message.status=MESSAGE_STATUS_COMPLETED、{"done":{}} 表示结束
      parse(text) {
        const blocks = new Map();
        let done = false, error = null;
        for (const j of jsonObjects(text)) {
          if (j.error) error = j.error.message || JSON.stringify(j.error);
          if (j.done) done = true;
          const m = j.message;
          if (m && m.role !== "user" && m.status) {
            if (m.status === "MESSAGE_STATUS_COMPLETED" && m.role !== "system") done = true;
            if (/FAIL|ERROR|BLOCK|CANCEL/.test(m.status)) error = m.status;
          }
          if (m && m.status && !m.role && /COMPLETED/.test(m.status)) done = true;
          const b = j.block;
          if (!b || b.id === undefined) continue;
          for (const type of ["text", "think"]) {
            const c = b[type] && b[type].content;
            if (typeof c !== "string") continue;
            const r = blocks.get(b.id + ":" + type) || { type, s: "" };
            r.s = j.op === "append" ? r.s + c : c;
            blocks.set(b.id + ":" + type, r);
          }
        }
        if (!blocks.size && !done) error = error || plainError(text);
        const pick = (t) => [...blocks.values()].filter((r) => r.type === t).map((r) => r.s).filter(Boolean).join("\n\n");
        return { answer: pick("text"), thinking: pick("think"), done, error };
      },
    },

    // ------------------------------------------------------------ 千问
    qwen: {
      name: "千问",
      home: "https://www.qianwen.com/",
      isFresh: () => location.pathname === "/",
      input: ['div[role="textbox"][data-slate-editor="true"]', '[contenteditable="true"]'],
      insert: "beforeinput",
      send: ['button[aria-label="发送消息"]:not([disabled])'],
      stop: ['button[aria-label="停止回答"]'],
      sendBy: "click",
      newChat: { goHome: true }, // 点“新对话”没反应，直接打开首页
      stream: /\/api\/v\d+\/chat\?/,
      dom: "#qk-markdown-react",
      chatUrl: (id) => `https://www.qianwen.com/chat/${id}`,
      chatId: () => (/^\/chat\/([0-9a-f]{16,})/.exec(location.pathname) || [])[1] || null,
      // POST chat2-api.qianwen.com/api/v2/session/page/list?<网站自己的参数> {"limit":50,"next_token":...} → data.list[]、have_next_page、next_token
      async listChats(h, max) {
        const out = [], seen = new Set();
        let token = "";
        for (let page = 0; page < 50 && out.length < max; page++) {
          const r = await h.api("https://chat2-api.qianwen.com/api/v2/session/page/list", {
            method: "POST", queryFrom: "chat2-api.qianwen.com", dropParams: ["nonce", "timestamp"], headers: { "content-type": "application/json" },
            dropHeaders: ["clt-acs-sign", "clt-acs-reqt", "clt-acs-request-params", "clt-acs-caer", "clt-acs-bfg", "eo-clt-dvidn", "eo-clt-sacsft", "eo-clt-snver", "eo-clt-actkn", "eo-clt-acs-ve", "eo-clt-acs-kp", "x-wpk-reqid", "x-wpk-traceid"],
            body: JSON.stringify({ limit: 50, next_token: token, sort_field: "modifiedTime", need_filter_tag: true }),
          });
          if (!ok(r, (j) => j.code === 0)) throw new Error("获取列表失败：" + apiErr(r));
          const d = r.json.data || {};
          let added = 0;
          for (const c of d.list || []) {
            if (seen.has(c.session_id)) continue;
            seen.add(c.session_id); added++;
            out.push({ id: c.session_id, title: c.title, updatedAt: c.updated_at || 0, pinned: !!c.top, url: this.chatUrl(c.session_id) });
          }
          token = d.next_token || "";
          if (!d.have_next_page || !token || !added) break;
        }
        return out.slice(0, max);
      },
      // POST chat2-api.qianwen.com/api/v1/session/delete/batch {"session_ids":[...]} → data.success_ids
      async deleteChats(h, ids) {
        const res = [];
        for (const part of chunk(ids, 20)) {
          const r = await h.api("https://chat2-api.qianwen.com/api/v1/session/delete/batch", {
            method: "POST", queryFrom: "chat2-api.qianwen.com", dropParams: ["nonce", "timestamp"], headers: { "content-type": "application/json" },
            dropHeaders: ["clt-acs-sign", "clt-acs-reqt", "clt-acs-request-params", "clt-acs-caer", "clt-acs-bfg", "eo-clt-dvidn", "eo-clt-sacsft", "eo-clt-snver", "eo-clt-actkn", "eo-clt-acs-ve", "eo-clt-acs-kp", "x-wpk-reqid", "x-wpk-traceid"],
            body: JSON.stringify({ session_ids: part }),
          });
          const okIds = ok(r, (j) => j.code === 0) ? new Set((r.json.data && r.json.data.success_ids) || []) : new Set();
          for (const id of part) res.push({ id, ok: okIds.has(id), how: "接口", error: okIds.has(id) ? undefined : apiErr(r) });
        }
        return res;
      },
      uiDelete: {
        item: (id) => document.querySelector(`[data-session-id="${id}"][data-session-switch-target="normal"]`),
        trigger: '[data-session-switch-target="session-tools"]',
        menu: '[data-session-switch-target="delete-session"], [role="menuitem"]', menuText: /^删除此对话$/,
        confirm: '[data-session-switch-target="confirm-delete-session"]', confirmText: /^(确定|删除)$/,
      },
      // data:{"error_code":0,"data":{"messages":[{"mime_type":"multi_load/iframe","content":"回答全文…","status":"complete"}, …],
      //        "extra_info":{"sse_end":"1"}}}   sse_end=1 表示结束
      parse(text) {
        const msgs = new Map();
        let done = false, error = null;
        for (const e of sseEvents(text)) {
          const j = e.json;
          if (!j || typeof j !== "object") continue;
          if (j.error_code && j.error_code !== 0) error = `${j.error_code} ${j.error_msg || ""}`.trim();
          const d = j.data || {};
          if (d.extra_info && String(d.extra_info.sse_end) === "1") done = true;
          if (d.audit_info && d.audit_info.error_code) error = "审核 " + d.audit_info.error_code;
          for (const m of d.messages || []) {
            if (typeof m.content !== "string" || !m.content) continue;
            const mt = m.mime_type || "";
            const type = /think|reason/i.test(mt) ? "think" : /^(multi_load\/iframe|text\/)/.test(mt) ? "text" : null;
            if (!type) continue;
            const r = msgs.get(mt) || { type, s: "" };
            // 不确定每次是全文还是新增：新的以旧的开头就当全文，否则接上
            r.s = m.content.startsWith(r.s) ? m.content : r.s + m.content;
            msgs.set(mt, r);
          }
        }
        if (!msgs.size && !done) error = error || plainError(text);
        const pick = (t) => [...msgs.values()].filter((r) => r.type === t).map((r) => r.s).join("\n\n");
        return { answer: pick("text"), thinking: pick("think"), done, error };
      },
    },

    // ------------------------------------------------------------ 豆包（2026-10-18，按采样报告写）
    doubao: {
      name: "豆包",
      home: "https://www.doubao.com/chat/",
      isFresh: () => /^\/chat\/?$/.test(location.pathname),
      // Tiptap / ProseMirror：execCommand 和粘贴都能写进去，beforeinput 不行
      input: ['div.tiptap.ProseMirror[contenteditable="true"]', '[data-testid="chat_input_input"] [contenteditable="true"]', '[contenteditable="true"]'],
      insert: "execCommand",
      // 采样时没认到发送按钮（认成了“豆包 快速”模型按钮），按回车能发出去
      send: ['button[data-testid="chat_input_send_button"]:not([disabled]):not([data-disabled="true"])', 'button[aria-label="发送"]:not([disabled])'],
      stop: ['button[data-testid="chat_input_break_button"]', 'button[aria-label="停止生成"]', 'button[aria-label="停止"]'],
      sendBy: "enter",
      newChat: { goHome: true },
      upload: ["input"], // input[data-testid="upload-file-input"]，accept 里有 .txt
      stream: /\/chat\/completion(\?|$)/,
      dom: 'div[data-testid="receive_message"] div[data-testid="message_text_content"]',
      chatUrl: (id) => `https://www.doubao.com/chat/${id}`,
      chatId: () => (/^\/chat\/(\d{8,})/.exec(location.pathname) || [])[1] || null,
      async listChats() { throw new Error("豆包暂不支持获取会话列表"); },
      async deleteChats(_h, ids) { return ids.map((id) => ({ id, ok: false, error: "豆包暂不支持删除会话" })); },
      // POST /chat/completion，SSE：
      //   STREAM_MSG_NOTIFY {content:{content_block:[{block_type,block_id,content:{text_block:{text}},is_finish}]}}  第一块
      //   STREAM_CHUNK {patch_op:[{patch_object:1, patch_value:{content_block:[…同上…]}}]}  之后的块（patch_object 111 是语音稿 tts_content，不要）
      //   CHUNK_DELTA {text}  接在当前那一块后面的新文字
      //   SSE_REPLY_END {end_type:1 回答结束 / 2 / 3 全部结束}；ext.is_finish="1" 也表示完成
      // block_type 10000 是正文；别的（深度思考等）当思考过程，去掉
      parse(text) {
        const blocks = new Map();
        let cur = null, done = false, error = null;
        const add = (b) => {
          if (!b || !b.block_id) return;
          const tb = b.content && b.content.text_block;
          const type = b.block_type === 10000 ? "text" : "think";
          const r = blocks.get(b.block_id) || { type, s: "" };
          if (tb && typeof tb.text === "string") r.s += tb.text;
          if (b.content && b.content.thinking_block && typeof b.content.thinking_block.text === "string") { r.type = "think"; r.s += b.content.thinking_block.text; }
          blocks.set(b.block_id, r);
          cur = r;
        };
        for (const e of sseEvents(text)) {
          const j = e.json;
          if (!j || typeof j !== "object") continue;
          if (e.event === "SSE_REPLY_END" && (j.end_type === 1 || j.end_type === 3)) done = true;
          if (/ERROR|FAIL/i.test(e.event)) error = j.message || j.msg || j.error_msg || e.event;
          if ((j.code && j.code !== 0) || (j.error_code && j.error_code !== 0)) error = `${j.code || j.error_code} ${j.message || j.msg || j.error_msg || ""}`.trim();
          if (e.event === "STREAM_MSG_NOTIFY") for (const b of (j.content && j.content.content_block) || []) add(b);
          else if (e.event === "STREAM_CHUNK") {
            for (const op of j.patch_op || []) {
              const v = op.patch_value || {};
              if (op.patch_object === 1) for (const b of v.content_block || []) add(b);
              if (v.ext && v.ext.is_finish === "1") done = true;
            }
          } else if (e.event === "CHUNK_DELTA" && typeof j.text === "string") {
            if (!cur) { cur = { type: "text", s: "" }; blocks.set("_delta", cur); }
            cur.s += j.text;
          }
        }
        if (!blocks.size && !done) error = error || plainError(text);
        const pick = (t) => [...blocks.values()].filter((r) => r.type === t).map((r) => r.s).filter(Boolean).join("\n\n");
        return { answer: pick("text"), thinking: pick("think"), done, error };
      },
    },
  };

  const g = typeof window !== "undefined" ? window : globalThis;
  g.AIB_SITES = SITES;
  g.AIB_UTIL = { sseEvents, jsonObjects, plainError };
})();
