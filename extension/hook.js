/**
 * AI Bridge · 网页主环境钩子（2026-10-14）
 *
 * 在网页自己的 JS 环境里运行（manifest 里 world: MAIN、document_start，只注入四个 AI 站点），
 * 包一层 fetch / XMLHttpRequest / EventSource / WebSocket：
 *  - 平时（没“布防”）只是原样转发，什么都不记；
 *  - 采样时（content.js 发来 arm）把请求和**流式返回的每一块**记下来，通过 postMessage 交给 content.js。
 * AI 网站的回复都是流式推过来的（SSE / 流式 fetch / WebSocket），这里要知道：哪个接口、什么格式、什么时候结束。
 *
 * 另外还有“实时”通道（给适配器用，不受布防影响）：content.js 告诉钩子回复接口的网址规则（watch），
 * 命中的请求每收到一块就把新增的文字发过去（kind: "live"，phase: start / data / end / error）。
 * connect 协议（Kimi，application/connect+json）每条消息前有 5 字节的二进制头，这里按字节拆开，每条消息一行。
 *
 * 会话列表 / 删除用的“接口代发”（kind: "api"）：网站自己发请求时，这里记下每个域名最近一次的请求头和网址参数
 * （只存在网页内存里，不发给任何人），代发时带上同样的请求头，cookie 由浏览器自己带。
 * 有签名的网站（智谱清言）代发不了，就用 LIST_CACHE 记下网站自己请求到的会话列表。
 */
(() => {
  if (window.__aibHook) return;
  window.__aibHook = true;

  const TAG = "__aib"; // 钩子 → content：{__aib: 1}；content → 钩子：{__aib: 2}
  const BODY_MAX = 600000; // 每个接口最多留这么多字
  const FRAMES_MAX = 800; // WebSocket / EventSource 最多记这么多条
  const SKIP_URL = /\.(m?js|css|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|mp4|mp3|wav|wasm|map)(\?|#|$)/i;
  const SKIP_CT = /^(image|font|video|audio)\/|text\/css|javascript|wasm/i;

  // 会话列表采样要从页面一打开就记（列表是页面加载时请求的）：content.js 刷新页面前在 sessionStorage 里留了标记。
  // 这时 content.js 还没准备好，记下的东西先排队，等它发来 attach 再交过去
  let armed = false, holding = false;
  try { if (sessionStorage.getItem("aib-arm") === "1") armed = holding = true; } catch {}
  const queue = [];
  let seq = 0;
  const active = new Map(); // 还没结束的流：id -> () => 当前数据（停止采样时先交上去）
  const onArm = []; // 布防 / 撤防时要做的事
  let watch = []; // 实时通道要盯的回复接口（正则）
  const hdrs = new Map(); // 域名 -> 最近一次请求的请求头（原值，只在内存里）
  const lastQuery = new Map(); // 域名 -> 最近一次请求的网址参数
  const LIST_CACHE_RE = /\/conversation\/recent_list|\/chat_session\/fetch_page|\/session\/page\/list|FeedService\/ListFeeds/;
  const listCache = []; // 最近的会话列表返回：{ url, reqBody, body, at }
  function remember(url, h) {
    try {
      const u = new URL(url, location.href);
      if (u.search.length > 1) lastQuery.set(u.host, u.search.slice(1));
      if (!h) return;
      const o = {};
      const it = h instanceof Headers ? h.entries() : Array.isArray(h) ? h : Object.entries(h);
      for (const [k, v] of it) o[k] = String(v);
      if (Object.keys(o).length) hdrs.set(u.host, { ...(hdrs.get(u.host) || {}), ...o });
    } catch {}
  }
  function cacheList(url, reqBody, body) {
    if (!LIST_CACHE_RE.test(url)) return;
    listCache.push({ url, reqBody, body, at: Date.now() });
    if (listCache.length > 30) listCache.shift();
  }
  const watched = (url) => watch.some((r) => r.test(url));
  const send = (msg) => { try { window.postMessage(msg, "*"); } catch {} };
  const post = (kind, data) => {
    const msg = { [TAG]: 1, kind, ...data };
    if (holding && kind !== "pong") { if (queue.length < 3000) queue.push(msg); return; }
    send(msg);
  };
  const now = () => Date.now();

  window.addEventListener("message", (e) => {
    const d = e.data;
    if (e.source !== window || !d || d[TAG] !== 2) return;
    if (d.kind === "ping") post("pong", { armedOnLoad: holding || undefined });
    if (d.kind === "attach" && holding) { holding = false; for (const m of queue.splice(0)) send(m); }
    if (d.kind === "api") apiCall(d);
    if (d.kind === "listCache") post("listCache", { reqId: d.reqId, items: listCache.slice() });
    if (d.kind === "watch") { try { watch = (d.patterns || []).map((x) => new RegExp(x)); } catch { watch = []; } }
    if (d.kind === "arm") {
      armed = !!d.on;
      if (!armed) for (const [id, snap] of active) { post("end", { id, t: now(), stillOpen: true, ...snap() }); active.delete(id); }
      for (const fn of onArm) fn(armed);
    }
  });

  const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join(" ");
  const absUrl = (u) => { try { return new URL(String(u), location.href).href; } catch { return String(u); } };
  /** 很短的指纹（24 位），只用来看两次请求的值一样不一样（固定的登录凭证 / 每次都变的签名），反推不出原值 */
  const fp = (v) => { let h = 0x811c9dc5; for (let i = 0; i < v.length; i++) { h ^= v.charCodeAt(i); h = Math.imul(h, 0x01000193); } return ((h >>> 8) & 0xffffff).toString(16).padStart(6, "0"); };
  /** 请求头不记值（值里可能有登录凭证），只记长度和指纹；content-type / accept 记值 */
  function headerInfo(h) {
    if (!h) return undefined;
    const out = {};
    try {
      const it = h instanceof Headers ? h.entries() : Array.isArray(h) ? h : Object.entries(h);
      for (const [k, v] of it) out[k] = /^(content-type|accept|x-stream|x-sse|connect-protocol-version)$/i.test(k) ? String(v) : `(有 ${String(v).length}字 #${fp(String(v))})`;
    } catch {}
    return Object.keys(out).length ? out : undefined;
  }
  function bodyText(b) {
    if (b == null) return undefined;
    try {
      if (typeof b === "string") return b.slice(0, 20000);
      if (b instanceof URLSearchParams) return b.toString().slice(0, 20000);
      if (b instanceof FormData) return "(FormData) " + [...b.keys()].join(",");
      if (b instanceof Blob) return `(Blob ${b.size} 字节)`;
      if (b instanceof ArrayBuffer || ArrayBuffer.isView(b)) {
        const u8 = b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
        return "(二进制) " + new TextDecoder().decode(u8.subarray(0, 20000));
      }
      if (b instanceof ReadableStream) return "(ReadableStream)";
    } catch {}
    return "(" + Object.prototype.toString.call(b) + ")";
  }

  /** 用网站自己的请求头代发一个请求（会话列表 / 删除） */
  async function apiCall(d) {
    try {
      const u = new URL(d.url, location.href);
      if (d.queryFrom) {
        const q = new URLSearchParams(lastQuery.get(d.queryFrom) || "");
        for (const k of d.dropParams || []) q.delete(k);
        for (const [k, v] of u.searchParams) q.set(k, v);
        u.search = q.toString();
      }
      const h = { ...(hdrs.get(d.headersFrom || u.host) || {}) };
      for (const k of Object.keys(h)) if (/^(content-length|host|accept-encoding)$/i.test(k) || (d.dropHeaders || []).some((x) => x.toLowerCase() === k.toLowerCase())) delete h[k];
      Object.assign(h, d.headers || {});
      const res = await origFetch.call(window, u.href, { method: d.method || "GET", headers: h, body: d.body, credentials: "include" });
      const text = await res.text();
      post("apiRes", { reqId: d.reqId, status: res.status, text, haveHeaders: Object.keys(h).length });
    } catch (e) { post("apiRes", { reqId: d.reqId, status: 0, error: String(e) }); }
  }

  // ---------------------------------------------------------------- fetch
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      const p = origFetch.apply(this, arguments);
      let url = "";
      try { url = absUrl(typeof input === "string" || input instanceof URL ? input : input.url); } catch {}
      try { remember(url, (init && init.headers) || (input instanceof Request ? input.headers : null)); } catch {}
      if (LIST_CACHE_RE.test(url)) {
        const rb = init && typeof init.body === "string" ? init.body : undefined;
        p.then((res) => res.clone().text().then((t) => cacheList(url, rb, t))).catch(() => {});
      }
      const live = watch.length > 0 && watched(url);
      const rec = armed && !SKIP_URL.test(url);
      if (!rec && !live) return p;
      let method = "GET", reqBody, reqHeaders;
      try {
        method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
        reqBody = bodyText(init && init.body);
        reqHeaders = headerInfo((init && init.headers) || (input && input.headers));
      } catch {}
      const id = "f" + ++seq, t0 = performance.now();
      if (rec) post("req", { id, src: "fetch", url, method, reqBody, reqHeaders, t: now() });
      if (live) post("live", { id, phase: "req", url, method });
      p.then(
        (res) => { try { readFetch(id, res.clone(), t0, rec, live, url); } catch (e) { if (rec) post("end", { id, t: now(), error: String(e) }); if (live) post("live", { id, phase: "error", error: String(e) }); } },
        (err) => { if (rec) post("end", { id, t: now(), error: "请求失败：" + String(err) }); if (live) post("live", { id, phase: "error", error: "请求失败：" + String(err) }); },
      );
      return p;
    };
  }
  /** 把收到的字节变成文字；connect 协议先拆掉每条消息的 5 字节头（1 字节标志 + 4 字节长度），每条消息一行 */
  function makeDecoder(ct) {
    const dec = new TextDecoder("utf-8");
    if (!/connect\+|grpc-web/i.test(ct)) return { push: (v) => dec.decode(v, { stream: true }), end: () => dec.decode() };
    let buf = new Uint8Array(0);
    return {
      push(v) {
        const nb = new Uint8Array(buf.length + v.length);
        nb.set(buf); nb.set(v, buf.length);
        buf = nb;
        let out = "";
        while (buf.length >= 5) {
          const len = ((buf[1] << 24) | (buf[2] << 16) | (buf[3] << 8) | buf[4]) >>> 0;
          if (buf.length < 5 + len) break;
          out += new TextDecoder("utf-8").decode(buf.subarray(5, 5 + len)) + "\n";
          buf = buf.slice(5 + len);
        }
        return out;
      },
      end: () => (buf.length ? new TextDecoder("utf-8").decode(buf) : ""),
    };
  }
  async function readFetch(id, res, t0, rec, live, url) {
    const ct = res.headers.get("content-type") || "";
    if (rec) post("res", { id, status: res.status, ct, resHeaders: headerInfo(res.headers), ms: Math.round(performance.now() - t0) });
    if (live) post("live", { id, phase: "start", url, status: res.status, ct });
    if ((SKIP_CT.test(ct) && !live) || !res.body) {
      res.body && res.body.cancel().catch(() => {});
      if (rec) post("end", { id, t: now(), skipped: ct || "无内容" });
      if (live) post("live", { id, phase: "end", status: res.status });
      return;
    }
    const reader = res.body.getReader();
    const dec = makeDecoder(ct);
    const st = { text: "", bytes: 0, chunks: 0, firstHex: "", times: [], truncated: false };
    const snap = () => ({ body: st.text, bytes: st.bytes, chunks: st.chunks, firstHex: st.firstHex, times: st.times, truncated: st.truncated || undefined });
    if (rec) active.set(id, snap);
    let lastPost = 0;
    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        const v = r.value;
        st.chunks++;
        st.bytes += v.byteLength;
        if (st.chunks === 1) st.firstHex = hex(v.subarray(0, 48));
        if (st.times.length < 3000) st.times.push(Math.round(performance.now() - t0)); // 每一块到达的时间（毫秒，从发请求算起）
        const piece = dec.push(v);
        if (live && piece) post("live", { id, phase: "data", text: piece });
        if (!rec) continue;
        if (!st.truncated) {
          st.text += piece;
          if (st.text.length > BODY_MAX) { st.text = st.text.slice(0, BODY_MAX); st.truncated = true; }
        }
        const n = performance.now();
        if (n - lastPost > 400) { lastPost = n; post("progress", { id, bytes: st.bytes, chunks: st.chunks, tail: st.text.slice(-200) }); }
      }
      const rest = dec.end();
      if (live) post("live", { id, phase: "end", status: res.status, text: rest || undefined });
      if (!st.truncated) st.text += rest;
      if (active.delete(id)) post("end", { id, t: now(), ms: Math.round(performance.now() - t0), ...snap() });
    } catch (e) {
      if (live) post("live", { id, phase: "error", error: "读取中断：" + String(e) });
      if (active.delete(id)) post("end", { id, t: now(), ms: Math.round(performance.now() - t0), error: "读取中断：" + String(e), ...snap() });
    }
  }

  // ---------------------------------------------------------------- XMLHttpRequest
  const XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send, XH = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (m, u) { this.__aib = { method: String(m).toUpperCase(), url: absUrl(u), headers: {} }; return XO.apply(this, arguments); };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) { if (this.__aib) this.__aib.headers[k] = v; return XH.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (b) {
    const p = this.__aib;
    if (p) {
      remember(p.url, p.headers);
      if (LIST_CACHE_RE.test(p.url)) { const x = this; this.addEventListener("load", () => { try { cacheList(p.url, typeof b === "string" ? b : undefined, String(x.responseText || "")); } catch {} }); }
    }
    if (p && watch.length && watched(p.url)) {
      // 实时通道：DeepSeek 用的是 XHR 收流式回复
      const id = "L" + ++seq, xhr = this;
      let started = false, seen = 0;
      const text = () => { try { return xhr.responseType === "" || xhr.responseType === "text" ? String(xhr.responseText || "") : ""; } catch { return ""; } };
      const flush = () => { const t = text(); if (t.length > seen) { post("live", { id, phase: "data", text: t.slice(seen) }); seen = t.length; } };
      post("live", { id, phase: "req", url: p.url, method: p.method });
      this.addEventListener("readystatechange", () => {
        if (xhr.readyState >= 2 && !started) { started = true; post("live", { id, phase: "start", url: p.url, status: xhr.status, ct: xhr.getResponseHeader("content-type") || "" }); }
        if (xhr.readyState >= 3) flush();
      });
      this.addEventListener("progress", flush);
      this.addEventListener("error", () => post("live", { id, phase: "error", error: "网络错误" }));
      this.addEventListener("abort", () => post("live", { id, phase: "error", error: "请求被中止" }));
      this.addEventListener("timeout", () => post("live", { id, phase: "error", error: "请求超时" }));
      this.addEventListener("loadend", () => { flush(); post("live", { id, phase: "end", status: xhr.status }); });
    }
    if (armed && p && !SKIP_URL.test(p.url)) {
      const id = "x" + ++seq, t0 = performance.now(), xhr = this;
      const st = { chunks: 0, times: [] };
      const bodyNow = () => {
        try {
          if (xhr.responseType === "" || xhr.responseType === "text") return String(xhr.responseText || "");
          if (xhr.responseType === "json") return JSON.stringify(xhr.response);
          if (xhr.responseType === "arraybuffer" && xhr.response) return new TextDecoder().decode(new Uint8Array(xhr.response));
        } catch {}
        return "(" + xhr.responseType + ")";
      };
      const snap = () => { const t = bodyNow(); return { body: t.slice(0, BODY_MAX), bytes: t.length, chunks: st.chunks, times: st.times }; };
      post("req", { id, src: "xhr", url: p.url, method: p.method, reqBody: bodyText(b), reqHeaders: headerInfo(p.headers), t: now() });
      active.set(id, snap);
      let sentRes = false, lastPost = 0;
      this.addEventListener("readystatechange", () => {
        if (xhr.readyState >= 2 && !sentRes) { sentRes = true; post("res", { id, status: xhr.status, ct: xhr.getResponseHeader("content-type") || "", ms: Math.round(performance.now() - t0) }); }
      });
      this.addEventListener("progress", () => {
        st.chunks++;
        if (st.times.length < 3000) st.times.push(Math.round(performance.now() - t0));
        const n = performance.now();
        if (n - lastPost > 400) { lastPost = n; const t = bodyNow(); post("progress", { id, bytes: t.length, chunks: st.chunks, tail: t.slice(-200) }); }
      });
      this.addEventListener("loadend", () => {
        if (!active.delete(id)) return;
        post("end", { id, t: now(), ms: Math.round(performance.now() - t0), status: xhr.status, ...snap() });
      });
    }
    return XS.apply(this, arguments);
  };

  // ---------------------------------------------------------------- EventSource（SSE）
  const ES = window.EventSource;
  if (ES) {
    const esAdd = ES.prototype.addEventListener;
    const watchES = (es, url) => {
      const id = "e" + ++seq, t0 = performance.now();
      const st = { frames: [], types: new Set(["message"]) };
      es.__aibSt = st;
      post("req", { id, src: "eventsource", url: absUrl(url), method: "GET", t: now() });
      const snap = () => ({ frames: st.frames, chunks: st.frames.length });
      active.set(id, snap);
      st.rec = (ev) => { if (st.frames.length < FRAMES_MAX) st.frames.push({ ms: Math.round(performance.now() - t0), type: ev.type, data: String(ev.data ?? "").slice(0, 8000), lastEventId: ev.lastEventId || undefined }); };
      esAdd.call(es, "message", st.rec);
      esAdd.call(es, "error", () => { if (es.readyState === 2 && active.delete(id)) post("end", { id, t: now(), ms: Math.round(performance.now() - t0), note: "连接关闭（error）", ...snap() }); });
      const close = es.close;
      es.close = function () { if (active.delete(id)) post("end", { id, t: now(), ms: Math.round(performance.now() - t0), note: "网页调用了 close()", ...snap() }); return close.apply(this, arguments); };
    };
    // 网站自定义的事件名（event: xxx），在它注册监听时顺便也记下
    ES.prototype.addEventListener = function (type, fn, opt) {
      const st = this.__aibSt;
      if (st && !st.types.has(type) && type !== "error" && type !== "open") { st.types.add(type); esAdd.call(this, type, st.rec); }
      return esAdd.call(this, type, fn, opt);
    };
    const Wrapped = function EventSource(url, cfg) {
      const es = new ES(url, cfg);
      if (armed) watchES(es, url);
      return es;
    };
    Wrapped.prototype = ES.prototype;
    Object.assign(Wrapped, { CONNECTING: 0, OPEN: 1, CLOSED: 2 });
    window.EventSource = Wrapped;
  }

  // ---------------------------------------------------------------- WebSocket
  // 有的网站一打开页面就建好长连接，所以每个连接都挂上，但只在采样期间记帧
  const WS = window.WebSocket;
  if (WS) {
    const wsSend = WS.prototype.send;
    const sockets = new Set();
    const frameOf = (dir, data, t0) => {
      const f = { ms: Math.round(performance.now() - t0), dir };
      if (typeof data === "string") f.data = data.slice(0, 8000);
      else if (data instanceof ArrayBuffer) { f.bytes = data.byteLength; f.hex = hex(new Uint8Array(data).subarray(0, 48)); f.text = new TextDecoder().decode(new Uint8Array(data).subarray(0, 8000)); }
      else if (data instanceof Blob) f.bytes = data.size;
      return f;
    };
    const startWS = (st, note) => {
      st.id = "w" + ++seq;
      st.t0 = performance.now();
      st.frames = [];
      post("req", { id: st.id, src: "websocket", url: st.url, method: "WS", t: now(), note });
      active.set(st.id, () => ({ frames: st.frames, chunks: st.frames.length }));
    };
    onArm.push((on) => {
      for (const st of sockets) {
        if (!on) st.id = null;
        else if (st.ws.readyState <= 1) startWS(st, "采样开始前就已打开的连接");
      }
    });
    WS.prototype.send = function (data) {
      const st = this.__aibSt;
      if (st && st.id && st.frames.length < FRAMES_MAX) st.frames.push(frameOf("发", data, st.t0));
      return wsSend.apply(this, arguments);
    };
    const Wrapped = function WebSocket(url, protocols) {
      const ws = protocols === undefined ? new WS(url) : new WS(url, protocols);
      const st = { ws, url: absUrl(url), id: null, frames: [], t0: 0 };
      ws.__aibSt = st;
      sockets.add(st);
      ws.addEventListener("message", (ev) => { if (st.id && st.frames.length < FRAMES_MAX) st.frames.push(frameOf("收", ev.data, st.t0)); });
      ws.addEventListener("close", (ev) => {
        sockets.delete(st);
        if (st.id && active.has(st.id)) { const snap = active.get(st.id); active.delete(st.id); post("end", { id: st.id, t: now(), note: `关闭 code=${ev.code}`, ...snap() }); }
      });
      if (armed) startWS(st);
      return ws;
    };
    Wrapped.prototype = WS.prototype;
    Object.assign(Wrapped, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    window.WebSocket = Wrapped;
  }
})();
