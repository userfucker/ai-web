/**
 * AI Bridge · 采样面板（2026-10-14）
 *
 * 只在四个 AI 网站运行：DeepSeek、智谱清言、千问、Kimi。目的是摸清每个网站，好写适配器
 * （新建对话 / 发送 / 等待完成 / 读取回复）。面板功能：
 *  ① 识别元素：自动找输入框、发送按钮、新建对话按钮；找错了可以手动重选
 *  ② 测试：几种往输入框里写字的方式哪种管用；点“新建对话”后页面怎么变
 *  ③ 采样对话：自动（或你手动）发一条消息，录下流式接口的每一块、发送按钮的状态变化、回复出现在哪个元素
 *  ④ 功能测试：用 sites.js 里的适配器做“新建对话 → 发送 → 等待完成 → 读取回复”，回复从流式接口解析（不含思考过程）
 *  ⑤ 会话列表采样：刷新页面从头记，看会话列表怎么加载、翻页、删除
 *  ⑥ 报告：整理成一份 JSON 下载，发给 AI 写 / 改适配器
 */
(() => {
  if (window.__aibLoaded) { if (window.__aibToggle) window.__aibToggle(); return; }
  window.__aibLoaded = true;
  const VERSION = "ai-web-1.1.0";
  const HOST_ID = "ai-bridge-host";

  const SITES = [
    { id: "deepseek", name: "DeepSeek", re: /(^|\.)deepseek\.com$/ },
    { id: "glm", name: "智谱清言", re: /(^|\.)chatglm\.cn$/ },
    { id: "qwen", name: "千问", re: /(^|\.)(tongyi\.com|qianwen\.com)$/ },
    { id: "kimi", name: "Kimi", re: /(^|\.)(kimi\.com|moonshot\.cn)$/ },
  ];
  const SITE = SITES.find((s) => s.re.test(location.hostname));
  if (!SITE) return;
  const DEFAULT_PROMPT = "这是一条自动化测试消息。请用两段话简单介绍你自己，然后给一个 Python 代码块，代码只打印 hello。";

  // ------------------------------------------------------------ 小工具
  const short = (s, n = 80) => {
    if (s == null || s === "") return undefined;
    s = String(s).replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n) + "…" : s;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isOurs = (el) => {
    for (let e = el; e; e = e.parentElement || (e.getRootNode && e.getRootNode().host)) if (e.id === HOST_ID) return true;
    return false;
  };
  const visible = (el) => { if (!el || !el.getBoundingClientRect) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const sec = (ms) => Math.round(ms / 100) / 10;
  const stamp = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19).replace(/[-:T]/g, ""); // 北京时间
  const bjTime = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19).replace("T", " ") + " 北京时间";

  /** class 里像随机生成的部分（哈希）去掉；CSS Modules 那种 名字--部件--哈希 / 名字_哈希 只留前面的名字 */
  function classParts(el) {
    const out = [];
    for (const c of el.classList || []) {
      if (c.length > 60) continue;
      const m = /^(.+--.+?)--[A-Za-z0-9_-]{4,}$/.exec(c) || /^(.+?)__[A-Za-z0-9]{5,}$/.exec(c) || /^(.+?)_[a-z0-9]{5,}$/i.exec(c);
      if (m && /[a-z]{3}/i.test(m[1])) { out.push(`[class*="${m[1]}"]`); continue; }
      if (/\d{4,}|^[a-z0-9]{1,2}$|^[a-z]{1,3}\d|^_|^css-|^sc-|^jsx-/i.test(c)) continue;
      out.push("." + CSS.escape(c));
    }
    return out.slice(0, 3);
  }
  const stableId = (id) => id && !/\d{3,}|^:|[A-Z0-9]{8,}|^_r_/.test(id) && id.length < 50;
  const count = (sel) => { try { return document.querySelectorAll(sel).length; } catch { return -1; } };
  const ATTRS = ["data-testid", "data-test-id", "data-role", "data-type", "name", "aria-label", "role", "title", "placeholder"];
  function selfSel(el) {
    const tag = el.tagName.toLowerCase();
    if (stableId(el.id)) return { sel: `#${CSS.escape(el.id)}` };
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v && v.length < 60 && !/\d{6,}/.test(v)) return { sel: `${tag}[${a}="${CSS.escape(v)}"]` };
    }
    return { sel: tag + classParts(el).join("") };
  }
  function bestSelector(el) {
    if (!el || el.nodeType !== 1) return "";
    const parts = [], els = [];
    for (let e = el, i = 0; e && e.nodeType === 1 && e !== document.documentElement && i < 7; e = e.parentElement, i++) {
      const s = selfSel(e);
      parts.unshift(s.sel);
      els.unshift(e);
      if (count(parts.join(" > ")) === 1) return parts.join(" > ");
      if (s.sel[0] === "#") break;
    }
    const nth = (k) => {
      const e = els[k];
      const sib = e.parentElement ? [...e.parentElement.children].filter((x) => x.tagName === e.tagName) : [];
      return sib.length > 1 ? `:nth-of-type(${sib.indexOf(e) + 1})` : "";
    };
    for (let k = 0; k < parts.length; k++) {
      const t = nth(k);
      if (!t) continue;
      const one = parts.map((x, i) => (i === k ? x + t : x)).join(" > ");
      if (count(one) === 1) return one;
    }
    for (let k = parts.length - 1; k >= 0; k--) {
      parts[k] += nth(k);
      if (count(parts.join(" > ")) === 1) break;
    }
    return parts.join(" > ");
  }
  function attrsOf(el, max = 200) {
    const out = {};
    for (const a of el.attributes || []) if (a.name !== "class" && a.name !== "style" && a.name !== "d") out[a.name] = a.value.length > max ? a.value.slice(0, max) + "…" : a.value;
    return Object.keys(out).length ? out : undefined;
  }
  function desc(el, textLen = 200) {
    if (!el || el.nodeType !== 1) return null;
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      selector: bestSelector(el),
      generic: el.tagName.toLowerCase() + classParts(el).join(""),
      cls: typeof el.className === "string" && el.className ? short(el.className, 240) : undefined,
      attrs: attrsOf(el),
      text: short(el.innerText || el.value || "", textLen),
      size: `${Math.round(r.width)}x${Math.round(r.height)}`,
      pos: `${Math.round(r.left)},${Math.round(r.top)}`,
    };
  }
  /** 元素的 HTML（去掉 svg 路径、style、过长的属性），给 AI 看结构用 */
  function cleanHtml(el, max = 20000) {
    if (!el) return undefined;
    const c = el.cloneNode(true);
    c.querySelectorAll("script,style,noscript").forEach((n) => n.remove());
    c.querySelectorAll("svg").forEach((s) => { while (s.firstChild) s.firstChild.remove(); });
    const all = [c, ...c.querySelectorAll("*")];
    for (const n of all) {
      n.removeAttribute("style");
      for (const a of [...n.attributes]) if (a.value.length > 300) n.setAttribute(a.name, a.value.slice(0, 120) + "…");
    }
    const w = document.createTreeWalker(c, NodeFilter.SHOW_TEXT);
    for (let t = w.nextNode(); t; t = w.nextNode()) if (t.nodeValue.length > 3000) t.nodeValue = t.nodeValue.slice(0, 3000) + "…";
    const html = c.outerHTML;
    return html.length > max ? html.slice(0, max) + `…（共 ${html.length} 字，后面截掉了）` : html;
  }
  /** 隐藏登录凭证：JWT、带 token / cookie / session 之类名字的字段、网址里的 token 参数 */
  function redact(s) {
    if (typeof s !== "string" || !s) return s;
    return s
      .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[JWT已隐藏]")
      .replace(/("[^"\n]{0,40}(?:token|authorization|cookie|password|passwd|secret|ticket|credential)[^"\n]{0,40}"\s*:\s*)"[^"]*"/gi, '$1"[已隐藏]"')
      .replace(/([?&](?:token|access_token|refresh_token|auth|ticket|sign|signature)=)[^&#\s"]+/gi, "$1[已隐藏]");
  }
  const editorKind = (el) => {
    if (!el) return undefined;
    if (el.tagName === "TEXTAREA") return "textarea";
    if (el.tagName === "INPUT") return "input";
    const box = el.closest("[contenteditable]") || el;
    const hint = [box.className, ...Object.keys(attrsOf(box) || {})].join(" ");
    if (/ProseMirror/.test(hint)) return "contenteditable (ProseMirror / Tiptap)";
    if (/data-slate-editor|slate/i.test(hint)) return "contenteditable (Slate)";
    if (/data-lexical-editor|lexical/i.test(hint)) return "contenteditable (Lexical)";
    if (/ql-editor/.test(hint)) return "contenteditable (Quill)";
    if (/DraftEditor|public-Draft/.test(hint)) return "contenteditable (Draft.js)";
    if (/cm-content|CodeMirror/.test(hint)) return "contenteditable (CodeMirror)";
    return "contenteditable";
  };
  const isTextField = (el) => el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT");
  /** 输入框里的文字（contenteditable 去掉占位提示，比如 Slate 空的时候显示的“向千问提问”） */
  const readInput = (el) => {
    if (!el) return "";
    if (isTextField(el)) return el.value;
    const c = el.cloneNode(true);
    c.querySelectorAll('[data-slate-placeholder],[data-placeholder-text],[contenteditable="false"],[aria-hidden="true"]').forEach((n) => n.remove());
    return (c.innerText || c.textContent || "").replace(/[\u200b\ufeff]/g, "");
  };
  const norm = (s) => String(s || "").replace(/\s+/g, "");
  const isDisabled = (el) => !!el && (el.disabled || el.getAttribute("aria-disabled") === "true" || /disabled/i.test(typeof el.className === "string" ? el.className : ""));
  const btnState = (el) => !el ? null : {
    found: true, disabled: el.disabled || undefined, ariaDisabled: el.getAttribute("aria-disabled") || undefined,
    cls: typeof el.className === "string" ? short(el.className, 240) : undefined, html: short(cleanHtml(el, 800), 800),
  };

  // ------------------------------------------------------------ 页面加载时间（从打开网页算起，毫秒）
  const loadInfo = { inputReadyMs: null };
  (function watchInputReady() {
    const t = setInterval(() => {
      const el = document.querySelector('textarea, [contenteditable="true"], [role="textbox"]');
      if (el && visible(el)) { loadInfo.inputReadyMs = Math.round(performance.now()); clearInterval(t); }
      else if (performance.now() > 120000) clearInterval(t);
    }, 200);
  })();
  function pageLoad() {
    const n = performance.getEntriesByType("navigation")[0];
    return {
      type: n && n.type, domContentLoadedMs: n ? Math.round(n.domContentLoadedEventEnd) : null, loadMs: n ? Math.round(n.loadEventEnd) : null,
      inputReadyMs: loadInfo.inputReadyMs, nowMs: Math.round(performance.now()),
    };
  }

  // ------------------------------------------------------------ 和网页里的钩子（hook.js）通话
  const toHook = (kind, data = {}) => window.postMessage({ __aib: 2, kind, ...data }, "*");
  let hookOK = false;
  const netHandlers = [];
  addEventListener("message", (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.__aib !== 1) return;
    if (d.kind === "pong") { hookOK = true; return; }
    for (const h of netHandlers) h(d);
  });
  const bg = (msg) => new Promise((res) => { try { chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; res(r || {}); }); } catch (e) { res({ ok: false, error: String(e) }); } });
  async function checkHook() {
    hookOK = false;
    toHook("ping");
    await sleep(300);
    if (hookOK) return true;
    await bg({ type: "aib-inject-hook" }); // 页面是装插件之前打开的
    toHook("ping");
    await sleep(300);
    return hookOK ? "late" : false;
  }

  // ------------------------------------------------------------ 调试面板显示 / 隐藏（弹出窗口里的按钮；默认隐藏，按网站记住）
  // 适配器总是加载（中转站发命令不需要打开面板），面板只是调试用
  const ui = init();
  const toggle = (force) => {
    const on = force ?? ui.host.style.display === "none";
    ui.show(on);
    try { chrome.storage.local.get("aibShown", (r) => { const h = new Set(r.aibShown || []); on ? h.add(location.host) : h.delete(location.host); chrome.storage.local.set({ aibShown: [...h] }); }); } catch {}
  };
  window.__aibToggle = () => toggle();
  try {
    chrome.runtime.onMessage.addListener((msg, _s, reply) => { if (msg && msg.type === "aib-toggle") { toggle(); reply({ ok: true, shown: ui.host.style.display !== "none" }); } });
    chrome.storage.local.get("aibShown", (r) => { if ((r.aibShown || []).includes(location.host)) ui.show(true); });
  } catch {}

  function init() {
    // ------------------------------------------------------------ 面板
    const host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText = "position:fixed;right:16px;top:70px;z-index:2147483647;display:none;";
    const root = host.attachShadow({ mode: "open" });
    let ttPolicy = null;
    try { if (window.trustedTypes) ttPolicy = trustedTypes.createPolicy("ai-bridge", { createHTML: (x) => x }); } catch {}
    const setHTML = (el, html) => { el.innerHTML = ttPolicy ? ttPolicy.createHTML(html) : html; };
    setHTML(root, `
  <style>
    :host { all: initial; }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    .box { width: 380px; max-height: calc(100vh - 90px); overflow-y: auto; background: #fff; color: #18181b; border: 1px solid #d4d4d8; border-radius: 14px;
      box-shadow: 0 10px 34px rgba(0,0,0,.22); font: 13px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; padding: 10px; }
    .box.min .body { display: none; }
    .head { display: flex; align-items: center; gap: 6px; font-weight: 600; cursor: move; user-select: none; }
    .head span { margin-right: auto; }
    .row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; align-items: center; }
    button { border: 1px solid #d4d4d8; background: #fff; color: #18181b; border-radius: 9px; padding: 4px 9px; font: inherit; cursor: pointer; }
    button:hover { background: #f4f4f5; }
    button:disabled { opacity: .45; cursor: default; }
    button.on { background: #dc2626; color: #fff; border-color: #dc2626; }
    button.pri { background: #18181b; color: #fff; border-color: #18181b; }
    button.sm { padding: 1px 7px; font-size: 12px; }
    .tip { color: #71717a; font-size: 12px; margin-top: 4px; }
    .sec { margin-top: 10px; border-top: 1px solid #f4f4f5; padding-top: 8px; }
    .sec > b { font-size: 12px; }
    .el { display: flex; gap: 6px; align-items: center; margin-top: 6px; font-size: 12px; }
    .el .k { width: 64px; flex: none; color: #52525b; }
    .el .v { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 11px ui-monospace, Consolas, monospace; }
    .ok { color: #16a34a; } .bad { color: #dc2626; }
    textarea { width: 100%; font: 12px/1.4 inherit; border: 1px solid #e4e4e7; border-radius: 8px; padding: 6px; resize: vertical; }
    .stat { font-size: 12px; margin-top: 8px; padding: 6px 8px; background: #f4f4f5; border-radius: 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
    .item { border: 1px solid #e4e4e7; border-radius: 9px; padding: 5px 8px; margin-top: 6px; font-size: 12px; overflow-wrap: anywhere; }
    .muted { color: #71717a; }
    #cBox { max-height: 220px; overflow-y: auto; border: 1px solid #e4e4e7; border-radius: 8px; padding: 4px 6px; color: #18181b; }
    #cBox label { display: flex; gap: 6px; align-items: baseline; padding: 2px 0; }
    #cBox label span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  </style>
  <div class="box" id="box">
    <div class="head" id="drag"><span>AI Web 调试 · ${SITE.name}</span><button id="min" class="sm">收起</button><button id="close" class="sm" title="隐藏调试面板（以后要用：工具栏图标 → 当前页调试面板）">隐藏</button></div>
    <div class="body">
      <div class="tip" id="hookTip">检查中…</div>

      <div class="sec"><b>① 页面元素</b>　<button id="detect" class="sm">自动识别</button>
        <div class="el"><span class="k">输入框</span><span class="v" id="v-input">-</span><button class="sm" data-see="input">看</button><button class="sm" data-pick="input">重选</button></div>
        <div class="el"><span class="k">发送按钮</span><span class="v" id="v-send">-</span><button class="sm" data-see="send">看</button><button class="sm" data-pick="send">重选</button></div>
        <div class="el"><span class="k">新建对话</span><span class="v" id="v-newChat">-</span><button class="sm" data-see="newChat">看</button><button class="sm" data-pick="newChat">重选</button></div>
        <div class="tip">发送按钮在输入框空着的时候可能是灰的，识别不到就先随便打几个字再点“自动识别”。重选：点网页上的元素，↑ 选外面一层，Esc 取消。</div>
      </div>

      <div class="sec"><b>② 测试</b>
        <div class="row"><button id="testInput">测试输入方式</button><button id="testNew">测试新建对话</button></div>
        <div class="tip">“测试输入方式”会往输入框里写几次测试文字再清空，不会发送。</div>
      </div>

      <div class="sec"><b>③ 采样一次对话</b>
        <textarea id="prompt" rows="3"></textarea>
        <div class="row"><button id="autoSample" class="pri">自动发送并采样</button><button id="manualSample">我自己发，开始采样</button><button id="stopSample" class="on" hidden>结束采样</button></div>
        <div class="row"><button id="pickReply" class="sm">手动选 AI 回答</button><span class="tip" style="margin:0">自动找错了再用：点 AI 回答的那段文字（不是输入框）</span></div>
        <div class="tip">建议在“新对话”里采样。每个网站至少采 1 次；有“深度思考”的网站，开着它再采 1 次（方便以后把思考过程去掉）。</div>
        <div id="samples"></div>
      </div>

      <div class="sec"><b>④ 功能测试</b>　<span class="muted" id="adName"></span>
        <div class="row"><button id="aAll" class="pri">一键测试</button><button id="aNew">新建对话</button><button id="aSend">发送</button><button id="aRead">读取回复</button><button id="aCopy" class="sm">复制回答</button></div>
        <div class="tip">一键测试 = 新建对话 → 发送上面的问题 → 等回复完成 → 读取。回答从网站的流式接口解析，不含思考过程；“页面对照”是和网页上显示的文字比一下。</div>
        <div class="stat" id="aOut" hidden></div>
        <div class="row"><button id="aFile">附件一键测试</button><span class="tip" style="margin:0">新对话 → 上传 120 行的 txt → 问第 3 行写了什么</span></div>
        <div class="row"><button id="cList">获取会话列表</button><button id="cDel" class="sm">删除选中</button><button id="cOpen" class="sm">打开选中的第一个</button><button id="cStop" class="sm">停止生成</button></div>
        <div id="cBox" class="tip" hidden></div>
      </div>

      <div class="sec"><b>⑤ 会话列表采样</b>
        <div class="row"><button id="listStart" class="pri">开始（页面会刷新）</button><button id="listStop" class="on" hidden>结束</button></div>
        <div class="tip">记下网站怎么加载、翻页、删除会话列表，用来做“批量获取 / 批量删除会话”。报告里会有你的会话标题。</div>
      </div>

      <div class="sec"><b>⑥ 报告</b>
        <div class="row"><button id="download" class="pri">下载报告</button><button id="copy">复制摘要</button><button id="clear">清空</button></div>
      </div>
      <div class="stat" id="status">准备好了。</div>
    </div>
  </div>`);
    document.documentElement.appendChild(host);
    const $ = (id) => root.getElementById(id);
    const status = (t) => { $("status").textContent = t; };
    const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    $("prompt").value = DEFAULT_PROMPT;

    function show(on) {
      host.style.display = on ? "block" : "none";
      if (!host.isConnected) document.documentElement.appendChild(host);
    }
    setInterval(() => { if (host.style.display !== "none" && !host.isConnected) document.documentElement.appendChild(host); }, 2000);
    $("drag").addEventListener("pointerdown", (e) => {
      if (e.composedPath()[0].tagName === "BUTTON") return;
      const r = host.getBoundingClientRect();
      const ox = e.clientX - r.left, oy = e.clientY - r.top;
      const move = (ev) => {
        host.style.left = Math.max(0, Math.min(innerWidth - 80, ev.clientX - ox)) + "px";
        host.style.top = Math.max(0, Math.min(innerHeight - 30, ev.clientY - oy)) + "px";
        host.style.right = "auto";
      };
      const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); };
      addEventListener("pointermove", move);
      addEventListener("pointerup", up);
    });
    $("min").onclick = () => { $("box").classList.toggle("min"); $("min").textContent = $("box").classList.contains("min") ? "展开" : "收起"; };
    $("close").onclick = () => toggle(false);

    checkHook().then((r) => {
      $("hookTip").textContent = r === true ? `${location.host} · 接口钩子正常`
        : r === "late" ? `${location.host} · 钩子是后补的，请刷新页面后再采样（否则可能抓不到接口）`
        : `${location.host} · 钩子没装上，请刷新页面`;
      $("hookTip").className = "tip " + (r === true ? "ok" : "bad");
    });

    // ------------------------------------------------------------ 高亮 / 手动选取
    const hl = document.createElement("div");
    hl.style.cssText = "position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #dc2626;background:rgba(220,38,38,.12);border-radius:3px;display:none;";
    const hlTip = document.createElement("div");
    hlTip.style.cssText = "position:fixed;pointer-events:none;z-index:2147483646;background:#18181b;color:#fff;font:11px/1.4 ui-monospace,Consolas,monospace;padding:2px 6px;border-radius:4px;display:none;max-width:60vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
    document.documentElement.append(hl, hlTip);
    let hlTimer = 0;
    function highlight(el, label) {
      clearTimeout(hlTimer);
      if (!el || !el.isConnected) { hl.style.display = hlTip.style.display = "none"; return; }
      const r = el.getBoundingClientRect();
      Object.assign(hl.style, { display: "block", left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
      hlTip.textContent = (label ? label + "  " : "") + `${selfSel(el).sel}  ${Math.round(r.width)}×${Math.round(r.height)}`;
      Object.assign(hlTip.style, { display: "block", left: Math.max(0, r.left) + "px", top: Math.max(0, r.top - 20) + "px" });
    }
    const flash = (el, label) => { if (el) el.scrollIntoView({ block: "nearest" }); highlight(el, label); hlTimer = setTimeout(() => highlight(null), 2500); };

    const els = { input: null, send: null, newChat: null, reply: null }; // 当前认定的元素
    const how = {}; // 每个元素是自动识别的还是手动选的
    const NAMES = { input: "输入框", send: "发送按钮", newChat: "新建对话", reply: "AI 回答" };
    let picking = null, hoverEl = null;
    const realTarget = (e) => (e.composedPath && e.composedPath()[0]) || e.target;
    addEventListener("mousemove", (e) => {
      if (!picking) return;
      const t = realTarget(e);
      if (isOurs(t)) return;
      hoverEl = t.nodeType === 1 ? t : t.parentElement;
      highlight(hoverEl, "选" + NAMES[picking]);
    }, true);
    for (const type of ["mousedown", "pointerdown", "mouseup", "pointerup"]) addEventListener(type, (e) => { if (picking && !isOurs(realTarget(e))) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); } }, true);
    addEventListener("click", (e) => {
      if (!picking) return;
      const t = realTarget(e);
      if (isOurs(t)) return;
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      const role = picking;
      picking = null;
      highlight(null);
      setEl(role, hoverEl || t, "手动");
      if (role === "reply" && lastSample) { lastSample.reply.manual = analyzeReply(els.reply); renderSamples(); }
      status(`${NAMES[role]}：${bestSelector(els[role])}`);
    }, true);
    addEventListener("keydown", (e) => {
      if (!picking) return;
      if (e.key === "Escape") { e.preventDefault(); picking = null; highlight(null); status("取消选取。"); }
      if (e.key === "ArrowUp" && hoverEl && hoverEl.parentElement) { e.preventDefault(); hoverEl = hoverEl.parentElement; highlight(hoverEl, "选" + NAMES[picking]); }
    }, true);
    root.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.pick) { picking = b.dataset.pick; status(`在网页上点一下${NAMES[picking]}（↑ 选外面一层，Esc 取消）`); }
      if (b.dataset.see) { const el = cur(b.dataset.see); el ? flash(el, NAMES[b.dataset.see]) : status(`还没有${NAMES[b.dataset.see]}。`); }
    });
    function setEl(role, el, source) {
      els[role] = el;
      how[role] = { source, selector: el ? bestSelector(el) : null };
      if (role in { input: 1, send: 1, newChat: 1 }) {
        const v = $("v-" + role);
        v.textContent = el ? `${source === "手动" ? "✋" : "✓"} ${how[role].selector}` : "✗ 没找到";
        v.className = "v " + (el ? "ok" : "bad");
        v.title = el ? how[role].selector : "";
      }
    }
    /** 元素可能被网站重新渲染替换掉：先用记下的，失效了按选择器再找，再不行重新识别 */
    function cur(role) {
      const el = els[role];
      if (el && el.isConnected && visible(el)) return el;
      const sel = how[role] && how[role].selector;
      if (sel) { try { const x = document.querySelector(sel); if (x && visible(x)) return (els[role] = x); } catch {} }
      if (role === "input") return (els.input = findInput());
      if (role === "send") return (els.send = findSend(cur("input")));
      if (role === "newChat") return (els.newChat = findNewChat());
      return null;
    }

    // ------------------------------------------------------------ ① 自动识别
    function findInput() {
      const list = [...document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"], [role="textbox"]')]
        .filter((el) => visible(el) && !isOurs(el) && !el.disabled && !el.readOnly)
        .filter((el) => !(el.parentElement && el.parentElement.closest('[contenteditable="true"],[contenteditable=""]'))); // 只要最外层的编辑区
      let best = null, bestScore = -1e9;
      for (const el of list) {
        const r = el.getBoundingClientRect();
        const ph = el.getAttribute("placeholder") || el.getAttribute("data-placeholder") || el.getAttribute("aria-label") || "";
        const score = r.width / 4 + (r.bottom / innerHeight) * 300 + (ph ? 80 : 0) + (/发|问|输入|message|ask/i.test(ph) ? 100 : 0);
        if (score > bestScore) { bestScore = score; best = el; }
      }
      return best;
    }
    function sendCandidates(input) {
      if (!input) return [];
      // 从输入框往上找到第一个装着按钮的容器，再多上一层（发送按钮常在旁边的工具栏里）
      let box = input.parentElement, lvl = 0;
      while (box && lvl < 6 && ![...box.querySelectorAll('button,[role="button"]')].some((b) => !input.contains(b) && visible(b))) { box = box.parentElement; lvl++; }
      if (!box) return [];
      if (box.parentElement && box.parentElement !== document.body) box = box.parentElement;
      const ir = input.getBoundingClientRect();
      const out = [];
      const seen = new Set();
      for (let el of box.querySelectorAll('button,[role="button"],[class*="send" i],[class*="submit" i],[aria-label*="发送"],[title*="发送"],div:has(> svg),span:has(> svg)')) {
        el = el.closest('button,[role="button"]') || el;
        if (seen.has(el) || !visible(el) || el.contains(input) || isOurs(el)) continue;
        seen.add(el);
        const r = el.getBoundingClientRect();
        if (r.width > 120 || r.height > 120) continue;
        const hint = [el.getAttribute("aria-label"), el.getAttribute("title"), el.getAttribute("data-testid"), typeof el.className === "string" ? el.className : "", el.innerText].join(" ");
        let score = 0;
        if (/send|submit|发送|發送/i.test(hint)) score += 120;
        if (/stop|停止|upload|上传|附件|attach|file|文件|voice|语音|mic|深度|思考|think|search|联网|搜索/i.test(hint)) score -= 80;
        if (el.querySelector("svg")) score += 10;
        if (el.tagName === "BUTTON") score += 10;
        score += (r.right / innerWidth) * 60 + (r.bottom >= ir.top - 10 ? 30 : 0);
        score -= Math.hypot(r.right - ir.right, r.bottom - ir.bottom) / 8; // 离输入框右下角越近越像
        out.push({ el, score: Math.round(score) });
      }
      return out.sort((a, b) => b.score - a.score);
    }
    const findSend = (input) => (sendCandidates(input)[0] || {}).el || null;
    const NEW_RE = /^(新对话|新建对话|开启新对话|新会话|新建会话|新建聊天|新聊天|开始新对话|new chat)$/i;
    function findNewChat() {
      for (const el of document.querySelectorAll('a,button,[role="button"],[aria-label],[title],div,span')) {
        if (isOurs(el) || !visible(el)) continue;
        const own = [el.getAttribute("aria-label"), el.getAttribute("title"), el.children.length <= 3 ? el.innerText : ""].map((x) => (x || "").trim());
        if (own.some((x) => NEW_RE.test(x))) return el.closest('a,button,[role="button"]') || el;
      }
      return null;
    }
    function detect() {
      const input = findInput();
      setEl("input", input, "自动");
      setEl("send", findSend(input), "自动");
      setEl("newChat", findNewChat(), "自动");
      const miss = ["input", "send", "newChat"].filter((k) => !els[k]).map((k) => NAMES[k]);
      status(miss.length ? `没找到：${miss.join("、")}。可以点“重选”手动指定。` : "三个元素都找到了，点“看”确认一下对不对。");
    }
    $("detect").onclick = detect;
    detect();

    // ------------------------------------------------------------ ② 测试输入方式
    // 不同编辑器要用不同的写法，用错了会把网站的编辑器弄坏：
    //  textarea：改 value + input 事件；Lexical（Kimi）：execCommand；
    //  Slate（千问）：只能发 beforeinput / paste 事件让它自己改，直接改 DOM（execCommand）会让它报错
    const nativeValue = (el, v) => {
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
    };
    const isSlate = (el) => !!el && !isTextField(el) && !!(el.closest("[data-slate-editor]") || el.querySelector("[data-slate-node]"));
    /** 把光标放进编辑区（全选或放到末尾），再等一下：Lexical / Slate 是在 selectionchange 事件里同步选区的，这个事件是异步的 */
    async function selectIn(el, all) {
      el.focus();
      if (isTextField(el)) { if (all) el.select(); else el.selectionStart = el.selectionEnd = el.value.length; return; }
      const r = document.createRange();
      r.selectNodeContents(el);
      if (!all) r.collapse(false);
      const s = getSelection();
      s.removeAllRanges();
      s.addRange(r);
      await sleep(80);
    }
    async function clearInput(el) {
      if (!el) return false;
      if (isTextField(el)) {
        el.focus();
        nativeValue(el, "");
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
      } else {
        for (let i = 0; i < 3 && norm(readInput(el)); i++) {
          await selectIn(el, true);
          if (isSlate(el)) el.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "deleteContentBackward" }));
          else if (i < 2) document.execCommand("delete");
          else el.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "deleteContentBackward" }));
          await sleep(120);
        }
      }
      await sleep(150);
      return !norm(readInput(el));
    }
    const METHODS = {
      setter: { name: "改 value + input 事件", only: "text", run: async (el, t) => { el.focus(); nativeValue(el, el.value + t); el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: t })); } },
      execCommand: { name: "execCommand insertText", noSlate: true, run: async (el, t) => { await selectIn(el, false); return document.execCommand("insertText", false, t); } },
      paste: { name: "模拟粘贴（paste 事件）", run: async (el, t) => { await selectIn(el, false); const dt = new DataTransfer(); dt.setData("text/plain", t); el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); } },
      beforeinput: { name: "beforeinput 事件", only: "ce", run: async (el, t) => { await selectIn(el, false); el.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: t, bubbles: true, cancelable: true })); } },
    };
    const methodOrder = (el) => isTextField(el) ? ["setter", "execCommand", "paste"] : isSlate(el) ? ["beforeinput", "paste"] : ["execCommand", "paste", "beforeinput"];
    let inputTests = null;
    async function testInput() {
      const input = cur("input");
      if (!input) { status("先找到输入框。"); return; }
      const results = [];
      for (const key of Object.keys(METHODS)) {
        const m = METHODS[key];
        if ((m.only === "text" && !isTextField(input)) || (m.only === "ce" && isTextField(input))) continue;
        if (m.noSlate && isSlate(input)) { results.push({ method: key, name: m.name, skipped: "Slate 编辑器不能用这种方式（会报错）" }); continue; }
        status(`测试：${m.name}…`);
        const t = `AIB测试${key}${Math.floor(Math.random() * 900 + 100)}`;
        const cleared = await clearInput(input);
        if (!cleared) { results.push({ method: key, name: m.name, skipped: "输入框清不干净，停止测试" }); break; }
        const sendBefore = btnState(cur("send"));
        let ret, error;
        try { ret = await m.run(input, t); } catch (e) { error = String(e); }
        await sleep(500);
        const after = readInput(input);
        const hits = after.split(t).length - 1;
        const sendAfter = btnState(cur("send"));
        results.push({
          method: key, name: m.name, clearedBefore: cleared, returned: ret, error,
          textAppeared: hits > 0, duplicated: hits > 1 || undefined, inputText: short(after, 120),
          sendBtnBefore: sendBefore && { disabled: sendBefore.disabled, ariaDisabled: sendBefore.ariaDisabled, cls: sendBefore.cls },
          sendBtnAfter: sendAfter && { disabled: sendAfter.disabled, ariaDisabled: sendAfter.ariaDisabled, cls: sendAfter.cls },
          sendBtnChanged: JSON.stringify(sendBefore) !== JSON.stringify(sendAfter),
        });
      }
      const clearedEnd = await clearInput(input);
      inputTests = { at: bjTime(), editor: editorKind(input), clearedAtEnd: clearedEnd, results };
      status("输入方式测试完成：\n" + results.map((r) => `${r.skipped ? "－" : r.textAppeared ? (r.duplicated ? "⚠ 重复" : "✓") : "✗"} ${r.name}${r.skipped ? "：" + r.skipped : r.sendBtnChanged ? "（发送按钮有变化）" : ""}`).join("\n")
        + (clearedEnd ? "" : "\n⚠ 输入框没清干净，请手动删掉测试文字再继续，否则会跟着问题一起发出去。"));
    }
    $("testInput").onclick = () => guard(testInput);

    let newChatTest = null;
    async function testNewChat() {
      const btn = cur("newChat");
      if (!btn) { status("先找到“新建对话”按钮。"); return; }
      const AD = window.AIB_SITES && window.AIB_SITES[SITE.id];
      if (AD && AD.isFresh()) { status("现在已经是新对话页面，点了也看不出变化。先打开一个有内容的旧对话，再测“新建对话”。"); return; }
      const before = { url: location.href, title: document.title, textLen: document.body.innerText.length };
      clickLike(btn);
      status("点了“新建对话”，等 2.5 秒看页面变化…");
      await sleep(2500);
      const input = cur("input");
      newChatTest = {
        at: bjTime(), button: desc(btn), before,
        after: { url: location.href, title: document.title, textLen: document.body.innerText.length },
        urlChanged: before.url !== location.href, inputFound: !!input, inputSelector: input ? bestSelector(input) : null,
      };
      status(`新建对话：网址${newChatTest.urlChanged ? "变了 → " + location.pathname : "没变"}；输入框${input ? "还在" : "没找到"}。`);
    }
    $("testNew").onclick = () => guard(testNewChat);

    function clickLike(el) {
      const r = el.getBoundingClientRect();
      const o = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
      el.dispatchEvent(new PointerEvent("pointerdown", { ...o, pointerType: "mouse", isPrimary: true }));
      el.dispatchEvent(new MouseEvent("mousedown", o));
      el.dispatchEvent(new PointerEvent("pointerup", { ...o, pointerType: "mouse", isPrimary: true }));
      el.dispatchEvent(new MouseEvent("mouseup", o));
      el.dispatchEvent(new MouseEvent("click", o));
    }
    function pressEnter(el) {
      el.focus();
      for (const type of ["keydown", "keypress", "keyup"]) {
        const ev = new KeyboardEvent(type, { key: "Enter", code: "Enter", bubbles: true, cancelable: true, composed: true });
        Object.defineProperty(ev, "keyCode", { get: () => 13 });
        Object.defineProperty(ev, "which", { get: () => 13 });
        el.dispatchEvent(ev);
      }
    }
    let busy = false;
    async function guard(fn) {
      if (busy) { status("上一个操作还没完成。"); return; }
      busy = true;
      try { await fn(); } catch (e) { status("出错：" + (e && e.stack ? e.stack : e)); } finally { busy = false; }
    }

    // ------------------------------------------------------------ ③ 采样一次对话
    const samples = [];
    let S = null, lastSample = null;
    const mo = new MutationObserver((muts) => {
      if (!S) return;
      const t = performance.now() - S.t0;
      for (const m of muts) {
        const el = m.target.nodeType === 1 ? m.target : m.target.parentElement;
        if (!el || isOurs(el) || el === hl || el === hlTip) continue;
        if (m.type === "attributes") continue;
        S.mutCount++;
        if (!(S.composer && S.composer.contains(el))) S.lastMut = performance.now();
        let r = S.muts.get(el);
        if (!r) { if (S.muts.size > 8000) continue; r = { n: 0, first: t }; S.muts.set(el, r); }
        r.n++;
        r.last = t;
      }
    });
    netHandlers.push((d) => {
      if (!S) return;
      const t = Math.round(performance.now() - S.t0);
      if (d.kind === "req") { if (S.net.size < 600) S.net.set(d.id, { ...d, kind: undefined, __aib: undefined, atMs: d.t ? Math.round(d.t - S.epoch) : t, t: undefined }); }
      const r = S.net.get(d.id);
      if (!r) return;
      if (d.kind === "res") Object.assign(r, { status: d.status, ct: d.ct, resHeaders: d.resHeaders, firstByteMs: d.ms });
      if (d.kind === "progress") { Object.assign(r, { bytes: d.bytes, chunks: d.chunks, tail: d.tail }); S.lastNet = performance.now(); }
      if (d.kind === "end") {
        const { kind, __aib, t: _t, ...rest } = d;
        Object.assign(r, rest, { done: true, endMs: t, tail: undefined });
        S.lastNet = performance.now();
      }
      if (d.kind === "req") S.lastNet = performance.now();
    });
    const composerOf = (input, send) => {
      if (!input) return null;
      let box = input.parentElement;
      for (let i = 0; box && i < 8; i++, box = box.parentElement) if (!send || box.contains(send)) return box;
      return input.parentElement;
    };

    async function startSample(mode, resumed) {
      if (S) return;
      const hook = await checkHook();
      const input = cur("input"), send = cur("send");
      S = {
        mode, resumed, t0: resumed ? 0 : performance.now(), epoch: resumed ? performance.timeOrigin : Date.now(), startAt: bjTime(), startUrl: location.href, hook, clicks: [],
        net: new Map(), muts: new Map(), mutCount: 0, lastMut: performance.now(), lastNet: 0,
        composer: composerOf(input, send), composerLog: [], visLog: [{ ms: 0, state: document.visibilityState, focus: document.hasFocus() }],
        typed: "", send: null, notes: [],
      };
      toHook("arm", { on: true });
      toHook("attach"); // 页面一打开就开始记的那些（会话列表采样），现在交过来
      mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      $("autoSample").hidden = $("manualSample").hidden = $("listStart").hidden = true;
      $(mode === "list" ? "listStop" : "stopSample").hidden = false;
      S.timer = setInterval(tick, 250);
      if (mode === "list") { status(LIST_STEPS); return; }
      if (mode === "auto") {
        const prompt = $("prompt").value.trim() || DEFAULT_PROMPT;
        S.prompt = prompt;
        S.send = await autoSend(prompt);
        if (!S) return;
        if (!S.send.ok) S.notes.push("自动发送可能没成功：" + S.send.problem);
      } else status("采样中：现在在网页里输入问题并发送，等 AI 回复完，点“结束采样”。");
    }
    document.addEventListener("click", (e) => {
      if (!S || S.mode !== "list" || picking) return;
      const t = realTarget(e);
      if (!t || t.nodeType !== 1 || isOurs(t) || S.clicks.length >= 200) return;
      const el = t.closest('a,button,[role="button"],[role="menuitem"],li,[class*="item"]') || t;
      S.clicks.push({ ms: Math.round(performance.now() - S.t0), el: desc(el, 80), target: desc(t, 40), parents: [el.parentElement, el.parentElement && el.parentElement.parentElement].filter(Boolean).map((x) => x.tagName.toLowerCase() + classParts(x).join("")) });
    }, true);
    function tick() {
      if (!S) return;
      const now = performance.now();
      const ms = Math.round(now - S.t0);
      const input = cur("input");
      const txt = readInput(input).trim();
      if (txt) S.typed = txt;
      // 发送按钮 / 输入区域的样子：变了就记一笔（看“停止生成”按钮怎么出现、怎么消失）
      const send = cur("send");
      if (!S.composer || !S.composer.isConnected) S.composer = composerOf(input, send);
      const snap = { send: btnState(send), composerHtml: cleanHtml(S.composer, 5000) };
      const key = JSON.stringify(snap);
      if (key !== S.lastComposerKey && S.composerLog.length < 80) { S.lastComposerKey = key; S.composerLog.push({ ms, sendBtn: snap.send, composerHtml: snap.composerHtml, inputText: short(txt, 60) }); }
      const vis = document.visibilityState, focus = document.hasFocus();
      const lv = S.visLog[S.visLog.length - 1];
      if (lv.state !== vis || lv.focus !== focus) S.visLog.push({ ms, state: vis, focus });
      const open = [...S.net.values()].filter((r) => !r.done && r.src !== "websocket").length;
      const quiet = (now - Math.max(S.lastMut, S.lastNet)) / 1000;
      const streams = [...S.net.values()].filter((r) => (r.chunks || 0) > 2).length;
      if (S.mode === "list") {
        status(`会话列表采样中 ${sec(ms)} 秒 · 接口 ${S.net.size} 个 · 点击 ${S.clicks.length} 次\n\n${LIST_STEPS}`);
        if (ms > 600000) stopSample("到 10 分钟上限，自动结束");
        return;
      }
      status(`采样中 ${sec(ms)} 秒\n接口 ${S.net.size} 个（进行中 ${open}，流式 ${streams}）· 页面变化 ${S.mutCount} 次\n${quiet >= 3 ? `已经 ${Math.floor(quiet)} 秒没有变化，回复可能完成了` : "回复生成中…"}${S.mode === "auto" ? "（自动模式：回复完会自动结束）" : "\n回复完了点“结束采样”"}`);
      // 自动结束：流式接口已经收完 → 安静 6 秒；没抓到流（可能走 WebSocket）→ 安静 15 秒
      const need = [...S.net.values()].some((r) => r.done && ((r.chunks || 0) > 2 || /event-stream|stream|ndjson|connect/i.test(r.ct || ""))) ? 6 : 15;
      if (S.mode === "auto" && S.send && ms > 8000 && quiet >= need && open === 0) stopSample(`自动结束（${need} 秒没有变化）`);
      if (ms > 300000) stopSample("到 5 分钟上限，自动结束");
    }
    async function autoSend(prompt) {
      const info = { ok: false, at: Math.round(performance.now() - S.t0) };
      const input = cur("input");
      if (!input) { info.problem = "没找到输入框"; return info; }
      info.clearedFirst = await clearInput(input);
      if (!info.clearedFirst) { info.problem = "输入框清不干净（里面还有字），没有发送"; return info; }
      const head = prompt.slice(0, 12);
      // 按测试结果里管用的方式优先
      const good = inputTests ? inputTests.results.filter((r) => r.textAppeared && !r.duplicated).map((r) => r.method) : [];
      const order = [...new Set([...good, ...methodOrder(input)])];
      for (const key of order) {
        try { await METHODS[key].run(input, prompt); } catch (e) { info.notes = (info.notes || "") + key + " 出错 " + e + "；"; }
        await sleep(400);
        if (norm(readInput(input)).includes(norm(head))) { info.method = key; break; }
        await clearInput(input);
      }
      if (!info.method) { info.problem = "几种输入方式都没把文字写进输入框"; return info; }
      await sleep(400);
      const send = cur("send");
      info.sendBtnBefore = btnState(send);
      if (send && !isDisabled(send)) { clickLike(send); info.how = "点发送按钮"; }
      else { pressEnter(input); info.how = send ? "发送按钮是禁用状态，改按回车" : "没找到发送按钮，按回车"; }
      status(`已发送（${METHODS[info.method].name}，${info.how}），等待回复…`);
      await sleep(2000);
      if (!S) return info;
      if (readInput(cur("input")).includes(head)) {
        info.stillInInput = true;
        if (info.how === "点发送按钮") { pressEnter(cur("input")); info.how += "（2 秒后文字还在，又按了回车）"; await sleep(2000); }
      }
      if (!S) return info;
      info.inputAfter = short(readInput(cur("input")), 80);
      info.ok = !readInput(cur("input")).includes(head);
      if (!info.ok) info.problem = "发送后输入框里还有文字，可能没发出去";
      info.sentAtMs = Math.round(performance.now() - S.t0);
      return info;
    }
    function stopSample(reason) {
      if (!S || S.stopping) return;
      S.stopping = true;
      if (S.mode === "list") { try { sessionStorage.removeItem("aib-arm"); sessionStorage.removeItem("aib-listsample"); } catch {} }
      clearInterval(S.timer);
      toHook("arm", { on: false }); // 钩子会把还没结束的流交上来（stillOpen）
      const s = S;
      setTimeout(() => {
        mo.disconnect();
        S = null;
        finishSample(s, reason);
      }, 400);
    }
    $("autoSample").onclick = () => startSample("auto");
    $("manualSample").onclick = () => startSample("manual");
    $("stopSample").onclick = () => stopSample("手动结束");
    $("pickReply").onclick = () => { picking = "reply"; status("在网页上点一下 AI 最后一次回答的正文（不是输入框；↑ 选外面一层，Esc 取消）"); };

    /** 回复区域：采样期间变化最多的那些元素（不算输入区域和侧边栏）的共同祖先 */
    function autoReplyLeaf(s, prompt) {
      const hot = [...s.muts.entries()]
        .filter(([el]) => el.isConnected && visible(el) && !isOurs(el) && !(s.composer && s.composer.contains(el)) && !el.closest("nav,aside,header"))
        .sort((a, b) => b[1].n - a[1].n);
      const hotList = hot.slice(0, 20).map(([el, r]) => ({ n: r.n, firstMs: Math.round(r.first), lastMs: Math.round(r.last), textLen: (el.innerText || "").length, selector: bestSelector(el), generic: el.tagName.toLowerCase() + classParts(el).join("") }));
      // 流式输出的地方会变很多次；只变了一两次的（比如消息列表插入新消息）不算
      const top = hot.length ? hot[0][1].n : 0;
      const pool = hot.filter(([, r]) => r.n >= Math.max(2, top * 0.1)).slice(0, 12);
      const q = (prompt || "").replace(/\s+/g, "").slice(0, 14);
      const hasQ = (e) => q && (e.innerText || "").replace(/\s+/g, "").includes(q);
      let lca = null;
      for (const [el] of pool.length ? pool : hot.slice(0, 1)) {
        if (!lca) { lca = el; continue; }
        let a = lca;
        while (a && !a.contains(el)) a = a.parentElement;
        if (!a || a === document.body || a === document.documentElement) continue; // 离得太远的（比如侧边栏标题）不算
        if ((a.innerText || "").length > Math.max(3 * (lca.innerText || "").length, 4000)) continue;
        if (hasQ(a) && !hasQ(lca)) continue; // 把你的提问也包进来了：太大
        lca = a;
      }
      return { leaf: lca, hotList };
    }
    function analyzeReply(leaf, prompt) {
      if (!leaf) return null;
      const leafLen = (leaf.innerText || "").length;
      // 往上找到“一条消息”：再往上一层就会把别的消息（你的提问）也包进去
      let item = leaf;
      while (item.parentElement && item.parentElement !== document.body) {
        const p = item.parentElement;
        if ((p.innerText || "").length > leafLen + 30 && [...p.children].filter((c) => c !== item && (c.innerText || "").trim().length > 0).length) break;
        item = p;
      }
      const ancestry = [];
      for (let e = leaf, i = 0; e && e !== document.body && i < 14; e = e.parentElement, i++) {
        ancestry.push({ tag: e.tagName.toLowerCase(), generic: e.tagName.toLowerCase() + classParts(e).join(""), cls: short(e.className, 160), attrs: attrsOf(e, 80), children: e.children.length, textLen: (e.innerText || "").length, isItem: e === item || undefined });
      }
      // 包含你的提问的那一层：一问一答的完整结构
      let turn = null;
      const q = (prompt || "").replace(/\s+/g, "").slice(0, 14);
      if (q) for (let e = item.parentElement; e && e !== document.body; e = e.parentElement) if ((e.innerText || "").replace(/\s+/g, "").includes(q)) { turn = e; break; }
      const list = item.parentElement;
      const sameKind = list ? [...list.children].map((c) => c.tagName.toLowerCase() + classParts(c).join("")) : [];
      return {
        leaf: desc(leaf, 120), item: desc(item, 120), ancestry,
        itemSiblings: list ? { total: list.children.length, kinds: sameKind.slice(-12), prev: desc(item.previousElementSibling, 160) } : undefined,
        text: (item.innerText || "").slice(0, 30000),
        codeBlocks: [...item.querySelectorAll("pre")].slice(0, 6).map((p) => ({ html: cleanHtml(p, 3000), text: short(p.innerText, 300) })),
        thinking: [...item.querySelectorAll("*")].filter((e) => /think|reason|thought|思考/i.test((typeof e.className === "string" ? e.className : "") + " " + Object.values(attrsOf(e, 60) || {}).join(" ")) || (e.children.length < 4 && /^(已深度思考|深度思考|思考中|已思考|正在思考|已完成思考|thinking|thought for)/i.test((e.innerText || "").trim()))).slice(0, 12).map((e) => desc(e, 100)),
        buttons: [...item.querySelectorAll('button,[role="button"]')].slice(0, 20).map((b) => ({ ...desc(b, 40), svg: b.querySelector("svg") ? short(b.querySelector("svg").getAttribute("class") || "(svg)", 80) : undefined })),
        itemHtml: cleanHtml(item, 80000),
        turnHtml: turn && turn !== item ? cleanHtml(turn, 60000) : undefined,
      };
    }
    const pathOf = (u) => { try { return new URL(u).pathname; } catch { return String(u); } };
    function finishSample(s, reason) {
      const totalMs = Math.round(performance.now() - s.t0);
      const prompt = s.prompt || s.typed;
      const isList = s.mode === "list";
      const { leaf, hotList } = isList ? { leaf: null, hotList: [] } : autoReplyLeaf(s, prompt);
      const net = [...s.net.values()].sort((a, b) => a.atMs - b.atMs);
      for (const r of net) {
        r.url = redact(r.url); r.reqBody = redact(r.reqBody); r.body = redact(r.body); r.tail = undefined;
        if (r.frames) r.frames = r.frames.map((f) => ({ ...f, data: redact(f.data), text: redact(f.text) }));
        if (r.times && r.times.length > 1) { const gaps = r.times.slice(1).map((t, i) => t - r.times[i]); r.timing = { first: r.times[0], last: r.times[r.times.length - 1], maxGap: Math.max(...gaps) }; }
      }
      const streams = net.filter((r) => (r.chunks || 0) > 2 || /event-stream|stream|ndjson|connect/i.test(r.ct || ""));
      const sample = {
        no: samples.length + 1, mode: isList ? "会话列表" : s.mode === "auto" ? "自动发送" : "手动发送", reason, startAt: s.startAt, totalSec: sec(totalMs),
        prompt, hook: s.hook, startUrl: s.startUrl, endUrl: location.href, send: s.send, notes: s.notes,
        visibility: s.visLog, composerLog: s.composerLog,
        hotElements: hotList,
        reply: { auto: isList ? null : analyzeReply(leaf, prompt), manual: null },
        list: isList ? { resumed: s.resumed, pageLoad: pageLoad(), clicks: s.clicks, sidebar: captureSidebar() } : undefined,
        streamIds: streams.map((r) => r.id),
        network: net,
      };
      samples.push(sample);
      lastSample = sample;
      if (leaf) { els.reply = leaf; how.reply = { source: "自动", selector: bestSelector(leaf) }; flash(leaf, "自动找到的回复"); }
      $("autoSample").hidden = $("manualSample").hidden = $("listStart").hidden = false;
      $("stopSample").hidden = $("listStop").hidden = true;
      renderSamples();
      if (isList) {
        const json = net.filter((r) => /json/i.test(r.ct || "") && r.body);
        status(`会话列表采样完成（${reason}，${sample.totalSec} 秒）：接口 ${net.length} 个（JSON ${json.length} 个），点击 ${s.clicks.length} 次，侧边栏列表 ${sample.list.sidebar ? sample.list.sidebar.count + " 项" : "没找到"}。\n点 ⑥“下载报告”发给我。`);
        return;
      }
      status(`采样 ${sample.no} 完成（${reason}，${sample.totalSec} 秒）。\n流式接口 ${streams.length} 个：${streams.map((r) => short(pathOf(r.url), 50)).join("、") || "无"}\nAI 回答所在元素：${leaf ? "已找到（红框）" : "没找到，请点“手动选 AI 回答”"}\n可以再采一次，或者“下载报告”。`);
    }
    /** 左边侧栏里的会话列表：左侧 35% 里同类子元素最多的那个容器，再加上所有像会话链接的 a 标签 */
    function captureSidebar() {
      let best = null, bestN = 0;
      for (const el of document.querySelectorAll("div,ul,ol,nav,aside,section")) {
        if (isOurs(el) || !visible(el) || el.children.length < 4) continue;
        if (el.getBoundingClientRect().left > innerWidth * 0.35) continue;
        const g = {};
        for (const c of el.children) { const k = c.tagName + classParts(c).join(""); g[k] = (g[k] || 0) + 1; }
        const n = Math.max(...Object.values(g));
        if (n > bestN) { bestN = n; best = el; }
      }
      const links = [...document.querySelectorAll("a[href]")].filter((a) => !isOurs(a) && a.getBoundingClientRect().left < innerWidth * 0.35)
        .slice(0, 150).map((a) => ({ href: a.getAttribute("href"), text: short(a.innerText, 60) }));
      if (!best) return { links };
      let scroller = best;
      while (scroller && scroller !== document.body && !(scroller.scrollHeight > scroller.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
      return {
        container: desc(best, 60), count: best.children.length, sameKind: bestN,
        items: [...best.children].slice(0, 40).map((c) => ({ ...desc(c, 80), href: (c.matches("a[href]") ? c : c.querySelector("a[href]"))?.getAttribute("href") || undefined })),
        scroller: scroller && scroller !== document.body ? desc(scroller, 20) : null,
        html: cleanHtml(best, 40000), links,
      };
    }
    function renderSamples() {
      setHTML($("samples"), samples.map((s) => {
        const st = s.network.filter((r) => s.streamIds.includes(r.id));
        const rep = s.reply.manual || s.reply.auto;
        if (s.list) return `<div class="item"><b>采样 ${s.no}</b> <span class="muted">会话列表 · ${s.totalSec} 秒 · ${esc(s.reason)}</span><div>接口 ${s.network.length} 个 · 点击 ${s.list.clicks.length} 次 · 侧边栏 ${s.list.sidebar ? s.list.sidebar.count + " 项" : "没找到"}</div></div>`;
        return `<div class="item"><b>采样 ${s.no}</b> <span class="muted">${esc(s.mode)} · ${s.totalSec} 秒 · ${esc(s.reason)}</span>
          <div>流式接口：${st.length ? st.map((r) => `<code>${esc(short(pathOf(r.url), 40))}</code> ${r.chunks || 0} 块`).join("；") : '<span class="bad">没抓到</span>'}</div>
          <div>回复：${rep ? `${s.reply.manual ? "手动" : "自动"} · ${esc(short(rep.text, 60))}` : '<span class="bad">没找到</span>'}</div>
          ${s.send && !s.send.ok ? `<div class="bad">${esc(s.send.problem)}</div>` : ""}</div>`;
      }).join(""));
    }

    // ------------------------------------------------------------ ④ 功能测试（适配器）
    const AD = window.AIB_SITES && window.AIB_SITES[SITE.id];
    const adapterTests = [];
    const live = { cur: null, list: [] }; // 回复接口的实时数据
    if (AD) {
      $("adName").textContent = `适配器：${AD.name}`;
      toHook("watch", { patterns: [AD.stream.source] });
      netHandlers.push((d) => {
        if (d.kind !== "live") return;
        let c = live.list.find((x) => x.id === d.id);
        if (d.phase === "req") {
          c = { id: d.id, url: d.url, text: "", t0: performance.now(), ended: false, status: 0, error: null };
          live.list.push(c);
          if (live.list.length > 20) live.list.shift();
          live.cur = c;
          return;
        }
        if (!c) return;
        if (d.phase === "start") { c.status = d.status; c.ct = d.ct; c.tFirst = performance.now(); if (d.status >= 400) c.error = "接口返回 HTTP " + d.status; }
        if (d.phase === "data" || (d.phase === "end" && d.text)) { c.text += d.text || ""; c.tLast = performance.now(); }
        if (d.phase === "end") { c.ended = true; c.tEnd = performance.now(); if (d.status >= 400 && !c.error) c.error = "接口返回 HTTP " + d.status; }
        if (d.phase === "error") { c.error = c.error || d.error; c.ended = true; c.tEnd = performance.now(); }
      });
    } else { $("adName").textContent = "（没有这个网站的适配器）"; }
    const firstOf = (sels) => { for (const sel of sels || []) { try { for (const el of document.querySelectorAll(sel)) if (visible(el) && !isOurs(el)) return el; } catch {} } return null; };
    const waitFor = async (fn, ms, step = 200) => { const end = Date.now() + ms; for (;;) { let v; try { v = fn(); } catch {} if (v) return v; if (Date.now() > end) return null; await sleep(step); } };
    const findAdInput = () => firstOf(AD.input) || cur("input");
    /** 网页上最后一条回答的文字（备用 / 对照） */
    function domReply() {
      let els = [];
      try { els = [...document.querySelectorAll(AD.dom)].filter((e) => visible(e) && !isOurs(e)); } catch {}
      const el = els[els.length - 1];
      return el ? (el.innerText || "").trim() : "";
    }
    /**
     * 和网页上显示的比：去掉代码块（网页上代码块带“复制 / 下载”之类的按钮文字）、标点空白和 Markdown 符号，
     * 在网页里找同时包含回答开头和结尾的最小元素。找到就算一致，顺便记下这个元素（以后修 dom 选择器用）。
     */
    function compareDom(answer) {
      const k = (x) => String(x || "").replace(/[^\p{L}\p{N}]/gu, "");
      const prose = k(String(answer || "").replace(/```[\s\S]*?(```|$)/g, " "));
      if (prose.length < 8) return { result: "没法比（回答里几乎只有代码）" };
      const head = prose.slice(0, 16), tail = prose.slice(-16), seed = prose.slice(0, 6);
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const hits = [];
      for (let t = w.nextNode(); t; t = w.nextNode()) if (k(t.nodeValue).includes(seed) && !isOurs(t.parentElement)) hits.push(t);
      let headOnly = null;
      for (const t of hits.reverse()) { // 从后往前：最新的消息在最后
        for (let e = t.parentElement, i = 0; e && e !== document.body && i < 14; e = e.parentElement, i++) {
          const x = k(e.textContent);
          if (!x.includes(head)) continue;
          headOnly = headOnly || e;
          if (x.includes(tail)) return { result: "一致", selector: bestSelector(e), generic: e.tagName.toLowerCase() + classParts(e).join(""), extraChars: Math.max(0, x.length - prose.length) };
        }
      }
      return headOnly ? { result: "部分一致（网页上只找到开头）", selector: bestSelector(headOnly) } : { result: "不一致（网页上没找到这段回答）" };
    }
    const isStopShown = () => !!firstOf(AD.stop);
    function readReply() {
      const c = live.cur;
      if (!c) { const dom = domReply(); return { source: dom ? "网页" : "无", answer: dom, thinking: "", done: false, error: dom ? null : "还没收到回复接口的数据" }; }
      let r;
      try { r = AD.parse(c.text); } catch (e) { r = { answer: "", thinking: "", done: false, error: "解析出错：" + e }; }
      const error = c.error || r.error || null;
      return {
        source: "接口", url: c.url, status: c.status, answer: r.answer, thinking: r.thinking,
        done: !!r.done, streamEnded: c.ended, error,
        firstTokenSec: c.tFirst ? sec(c.tFirst - c.t0) : null, totalSec: sec((c.tEnd || performance.now()) - c.t0), bytes: c.text.length,
      };
    }
    const isGenerating = () => { const c = live.cur; if (c && !c.ended) { const r = readReply(); if (!r.done && !r.error) return true; } return isStopShown(); };

    const LOGIN_RE = /^(登录|立即登录|登录\/注册|注册\/登录|手机号登录|验证码登录|扫码登录|log ?in|sign ?in)$/i;
    /** 等页面能用：输入框出来且没被禁用。网页加载慢的时候最多等 timeoutMs；看到登录按钮、又没有输入框，就是没登录 */
    async function adReady(timeoutMs = 60000) {
      const t0 = performance.now();
      let loginSeen = 0;
      for (;;) {
        const el = findAdInput();
        if (el && !el.disabled && el.getAttribute("aria-disabled") !== "true" && el.getAttribute("contenteditable") !== "false") {
          return { ok: true, waitedSec: sec(performance.now() - t0), sinceOpenSec: sec(performance.now()) };
        }
        const login = [...document.querySelectorAll('button,a,[role="button"]')].some((b) => visible(b) && !isOurs(b) && LOGIN_RE.test((b.innerText || "").trim()));
        if (login && ++loginSeen > 15) return { ok: false, error: "好像没登录（页面上有登录按钮，没有输入框）" }; // 连续 3 秒都这样才算
        if (performance.now() - t0 > timeoutMs) return { ok: false, error: `等了 ${Math.round(timeoutMs / 1000)} 秒页面还没准备好（网速慢、没登录或者要验证）` };
        await sleep(200);
      }
    }
    async function adNewChat() {
      if (AD.isFresh()) return { ok: true, how: "已经是新对话" };
      if (!AD.newChat.goHome) {
        let btn = AD.newChat.selector ? firstOf([AD.newChat.selector]) : null;
        if (!btn && AD.newChat.text) btn = [...document.querySelectorAll('a,button,[role="button"],div,span')].find((e) => visible(e) && !isOurs(e) && e.children.length <= 3 && AD.newChat.text.test((e.innerText || "").trim()));
        if (btn) {
          clickLike(btn.closest('a,button,[role="button"]') || btn);
          if (await waitFor(() => AD.isFresh(), 3000)) return { ok: true, how: "点了新对话按钮", url: location.href };
        }
      }
      return { ok: true, how: "打开首页", reload: true };
    }
    // ---- 附件（txt）：中转站发的长消息放进 txt 上传（2026-10-14）
    // 三种上传方式按顺序试：粘贴文件到输入框 / 设置网页上的文件选择框 / 拖放到输入区域。
    // 文件名出现在页面上（数量变多）就算放上去了，再等“上传中 / 解析中”消失、发送按钮能点。
    const UPLOADING_RE = /上传中|解析中|处理中|正在上传|正在解析|uploading|parsing/i;
    const countText = (t) => { const all = document.body.innerText || ""; let n = 0, i = 0; while ((i = all.indexOf(t, i)) >= 0) { n++; i += t.length; } return n; };
    function fileInputs() {
      return [...document.querySelectorAll('input[type="file"]')].filter((x) => !isOurs(x) && !x.disabled && (!x.accept || /\.txt|text\/|\*/i.test(x.accept)));
    }
    const ATTACH = {
      paste: async (input, list) => { await selectIn(input, false); const dt = new DataTransfer(); list.forEach((f) => dt.items.add(f)); input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); },
      input: async (input, list) => {
        const fi = fileInputs();
        const near = fi.find((x) => { let a = input; for (let i = 0; i < 8 && a; i++, a = a.parentElement) if (a.contains(x)) return true; return false; }) || fi[0];
        if (!near) throw new Error("页面上没有能选 txt 的文件框");
        const dt = new DataTransfer(); list.forEach((f) => dt.items.add(f));
        near.files = dt.files;
        near.dispatchEvent(new Event("input", { bubbles: true }));
        near.dispatchEvent(new Event("change", { bubbles: true }));
      },
      drop: async (input, list) => {
        const dt = new DataTransfer(); list.forEach((f) => dt.items.add(f));
        const target = input.parentElement || input;
        for (const t of ["dragenter", "dragover", "drop"]) target.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true }));
      },
    };
    async function attachFiles(files) {
      const input = findAdInput();
      if (!input) return { ok: false, error: "没找到输入框" };
      const list = files.map((f) => new File([f.content], f.name, { type: "text/plain" }));
      const keys = files.map((f) => f.name.replace(/\.txt$/i, ""));
      const before = keys.map(countText);
      const order = [...new Set([...(AD.upload || []), "paste", "input", "drop"])];
      const tried = [];
      for (const how of order) {
        try { await ATTACH[how](findAdInput() || input, list); } catch (e) { tried.push(how + "（" + e.message + "）"); continue; }
        const shown = await waitFor(() => keys.every((k, i) => countText(k) > before[i]), 4000);
        if (!shown) { tried.push(how); continue; }
        // 等上传 / 解析完
        const t0 = Date.now();
        await sleep(800);
        while (Date.now() - t0 < 90000 && UPLOADING_RE.test(document.body.innerText.slice(-20000))) await sleep(500);
        await sleep(800);
        return { ok: true, how, waitedSec: sec(Date.now() - t0) };
      }
      return { ok: false, error: "附件放不上去（试了：" + tried.join("、") + "）" };
    }

    async function adSend(text, files) {
      const ready = await adReady();
      if (!ready.ok) return { ok: false, error: ready.error };
      await sleep(300);
      let input = findAdInput();
      if (!input) return { ok: false, error: "没找到输入框" };
      if (!(await clearInput(input))) return { ok: false, error: "输入框清不干净，没有发送" };
      let attach = null;
      if (files && files.length) {
        attach = await attachFiles(files);
        if (!attach.ok) return { ok: false, error: attach.error };
        input = findAdInput() || input;
        await clearInput(input); // 有的网站粘贴文件时会顺便贴进文件名
      }
      // 多行文字：contenteditable 编辑器用粘贴更能保住换行
      const order = [...new Set([...(/\n/.test(text) && !isTextField(input) ? ["paste"] : []), AD.insert, ...methodOrder(input)])].filter((k) => !(METHODS[k].noSlate && isSlate(input)) && !(METHODS[k].only === "text" && !isTextField(input)) && !(METHODS[k].only === "ce" && isTextField(input)));
      let method = null;
      for (const key of order) {
        try { await METHODS[key].run(input, text); } catch {}
        await sleep(300);
        if (norm(readInput(input)).includes(norm(text).slice(0, 20))) { method = key; break; }
        await clearInput(input);
      }
      if (!method) return { ok: false, error: "写不进输入框（试了 " + order.join("、") + "）" };
      await sleep(300);
      const before = live.cur;
      const fire = async (by) => {
        if (by === "click") { const b = await waitFor(() => firstOf(AD.send), 2000); if (b) { clickLike(b); return "点发送按钮"; } }
        pressEnter(findAdInput() || input);
        return "按回车";
      };
      let how = await fire(AD.sendBy);
      let started = await waitFor(() => live.cur !== before && live.cur, 8000);
      if (!started && norm(readInput(findAdInput())).includes(norm(text).slice(0, 20))) {
        how += "，没反应，又" + (await fire(AD.sendBy === "click" ? "enter" : "click"));
        started = await waitFor(() => live.cur !== before && live.cur, 12000);
      }
      return started ? { ok: true, method, how, readySec: ready.waitedSec, attach } : { ok: false, method, how, attach, error: "发送后没看到回复接口的请求（可能没发出去，或者网站换了接口）" };
    }
    async function adWait(timeoutMs = 300000, onTick) {
      const t0 = Date.now();
      let doneAt = 0;
      for (;;) {
        const r = readReply();
        if (onTick) onTick(r);
        if (r.error) return r;
        if (!r.answer && !r.thinking && Date.now() - t0 > 120000) return { ...r, error: "2 分钟还没收到任何回答文字（网站可能很忙，或者被限流了）" };
        const finished = (r.done || r.streamEnded) && !isStopShown();
        if (finished) { if (!doneAt) doneAt = Date.now(); else if (Date.now() - doneAt > 800) return readReply(); }
        else doneAt = 0;
        if (Date.now() - t0 > timeoutMs) return { ...r, error: "等了 " + Math.round(timeoutMs / 1000) + " 秒还没完成" };
        await sleep(300);
      }
    }
    function showReply(title, r, extra) {
      const cmp = r.answer && r.source === "接口" ? compareDom(r.answer) : null;
      $("aOut").hidden = false;
      $("aOut").textContent = [
        title,
        r.error ? "✗ " + r.error : r.done ? "✓ 回复完成" : r.streamEnded ? "接口已结束（网站没给结束标记）" : "生成中…",
        r.source === "接口" ? `首字 ${r.firstTokenSec ?? "-"} 秒 · 用时 ${r.totalSec} 秒 · 回答 ${r.answer.length} 字 · 思考 ${r.thinking.length} 字（已去掉）` : `来源：${r.source}`,
        cmp ? "页面对照：" + cmp.result : "",
        extra || "",
        "—— 回答 ——",
        r.answer ? (r.answer.length > 1500 ? r.answer.slice(0, 1500) + "\n…（后面省略，复制回答可得全文）" : r.answer) : "（空）",
      ].filter(Boolean).join("\n");
      return cmp;
    }
    function logAdapter(step, result) {
      const r = { at: bjTime(), step, url: location.href, ...result };
      if (r.answer && r.answer.length > 20000) r.answer = r.answer.slice(0, 20000) + "…";
      adapterTests.push(r);
      if (adapterTests.length > 50) adapterTests.shift();
    }
    const PENDING = "aib-pending";
    async function runAll(prompt, resumed) {
      if (!resumed) {
        $("aOut").hidden = false;
        $("aOut").textContent = "新建对话…";
        // 点“新对话”可能让整个页面刷新：先记下要接着做的事，刷新后接着做
        try { sessionStorage.setItem(PENDING, JSON.stringify({ prompt, at: Date.now() })); } catch {}
        const n = await adNewChat();
        logAdapter("newChat", n);
        if (n.reload) { location.assign(AD.home); return; }
        try { sessionStorage.removeItem(PENDING); } catch {}
        await sleep(800);
      }
      $("aOut").textContent = "发送中…";
      const s = await adSend(prompt);
      logAdapter("send", s);
      if (!s.ok) { $("aOut").textContent = "✗ 发送失败：" + s.error; return; }
      const r = await adWait(300000, (x) => showReply(`一键测试（${METHODS[s.method].name}，${s.how}）`, x));
      const cmp = showReply(`一键测试（${METHODS[s.method].name}，${s.how}）`, r);
      logAdapter("reply", { ...r, domCompare: cmp, domText: short(domReply(), 300) });
      status(r.error ? "一键测试有问题：" + r.error : "一键测试完成。可以“下载报告”发给我。");
    }
    if (AD) {
      $("aAll").onclick = () => guard(() => runAll($("prompt").value.trim() || DEFAULT_PROMPT));
      $("aFile").onclick = () => guard(async () => {
        const code = "AIB" + Math.random().toString(36).slice(2, 8).toUpperCase();
        const lines = Array.from({ length: 120 }, (_, i) => i === 2 ? `第 3 行：暗号是 ${code}` : `第 ${i + 1} 行：这是附件测试的填充内容。`);
        $("aOut").hidden = false; $("aOut").textContent = "新建对话…";
        try { sessionStorage.setItem("aib-pending-file", "1"); } catch {}
        const n = await adNewChat();
        if (n.reload) { status("千问要先打开首页，页面刷新后请再点一次“附件一键测试”。"); location.assign(AD.home); return; }
        try { sessionStorage.removeItem("aib-pending-file"); } catch {}
        await sleep(800);
        $("aOut").textContent = "上传附件并发送…";
        const s = await adSend("请阅读附件《附件测试.txt》，只回答：第 3 行写的暗号是什么？", [{ name: "附件测试.txt", content: lines.join("\n") }]);
        logAdapter("sendFile", s);
        if (!s.ok) { $("aOut").textContent = "✗ " + s.error; status("附件测试失败：" + s.error); return; }
        const r = await adWait(300000, (x) => showReply(`附件测试（上传：${s.attach.how}）`, x));
        const okCode = (r.answer || "").includes(code);
        showReply(`附件测试（上传：${s.attach.how}）`, r, okCode ? `✓ AI 读到了附件（暗号 ${code}）` : `✗ 回答里没有暗号 ${code}，AI 可能没读到附件`);
        logAdapter("replyFile", { ...r, code, okCode });
        status(okCode ? "附件测试通过。" : "附件测试没通过，请下载报告发给我。");
      });
      $("aNew").onclick = () => guard(async () => {
        const n = await adNewChat();
        logAdapter("newChat", n);
        status("新建对话：" + n.how + (n.reload ? "（页面会刷新）" : ""));
        if (n.reload) location.assign(AD.home);
      });
      $("aSend").onclick = () => guard(async () => {
        const s = await adSend($("prompt").value.trim() || DEFAULT_PROMPT);
        logAdapter("send", s);
        status(s.ok ? `已发送（${METHODS[s.method].name}，${s.how}）。等回复完点“读取回复”。` : "发送失败：" + s.error);
      });
      $("aRead").onclick = () => {
        const r = readReply();
        const cmp = showReply(isGenerating() ? "读取（还在生成）" : "读取", r);
        logAdapter("read", { ...r, generating: isGenerating(), domCompare: cmp, domText: short(domReply(), 300) });
      };
      $("aCopy").onclick = async () => {
        const t = readReply().answer || "";
        try { await navigator.clipboard.writeText(t); } catch { const ta = document.createElement("textarea"); ta.value = t; root.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); }
        status(`回答已复制（${t.length} 字）。`);
      };
      // 一键测试中途打开了首页：页面刷新后接着做
      try {
        const p = JSON.parse(sessionStorage.getItem(PENDING) || "null");
        sessionStorage.removeItem(PENDING);
        if (p && Date.now() - p.at < 60000) {
          $("prompt").value = p.prompt;
          status("接着做一键测试…");
          setTimeout(() => guard(async () => {
            const ready = await adReady();
            logAdapter("ready", { ...ready, pageLoad: pageLoad() });
            if (!ready.ok) { $("aOut").hidden = false; $("aOut").textContent = "✗ " + ready.error; return; }
            await sleep(1200); // 输入框出来以后网站可能还在初始化
            await runAll(p.prompt, true);
          }), 500);
        }
      } catch {}
    }

    // ------------------------------------------------------------ 会话列表 / 删除 / 打开 / 停止
    const apiWait = new Map();
    netHandlers.push((d) => {
      if ((d.kind === "apiRes" || d.kind === "listCache") && apiWait.has(d.reqId)) { apiWait.get(d.reqId)(d); apiWait.delete(d.reqId); }
    });
    let apiSeq = 0;
    const askHook = (kind, data, ms = 20000) => new Promise((res) => {
      const reqId = "a" + ++apiSeq + "-" + Date.now();
      const t = setTimeout(() => { apiWait.delete(reqId); res({ status: 0, error: "超时" }); }, ms);
      apiWait.set(reqId, (d) => { clearTimeout(t); res(d); });
      toHook(kind, { ...data, reqId });
    });
    function hover(el) {
      const r = el.getBoundingClientRect();
      const o = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
      for (const t of ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove"]) el.dispatchEvent(t.startsWith("pointer") ? new PointerEvent(t, { ...o, pointerType: "mouse" }) : new MouseEvent(t, o));
    }
    /** 在 sel 范围里找文字符合 re 的、看得见的元素（菜单、弹窗一般加在页面最后，取最后一个） */
    function byText(sel, re) {
      let els = [];
      try { els = [...document.querySelectorAll(sel)]; } catch {}
      const hit = els.filter((e) => visible(e) && !isOurs(e) && (!re || re.test((e.innerText || "").trim())));
      return hit[hit.length - 1] || null;
    }
    const H = {
      api: async (url, opts = {}) => {
        const d = await askHook("api", { url, method: opts.method, body: opts.body, headers: opts.headers, queryFrom: opts.queryFrom, dropParams: opts.dropParams, dropHeaders: opts.dropHeaders });
        let json = null;
        try { json = JSON.parse(d.text); } catch {}
        return { status: d.status, text: d.text, json, error: d.error };
      },
      listCache: async () => (await askHook("listCache", {}, 5000)).items || [],
      waitFor: async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(300); } return false; },
      scrollSidebar: async (sel) => { const el = document.querySelector(sel); if (el) { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event("scroll", { bubbles: true })); } await sleep(800); },
      /** 像人一样删：悬停在会话上 → 点“更多” → 点“删除” → 点确认，等它从列表里消失 */
      uiDelete: async (spec, id, title) => {
        let item = spec.item(id, title);
        for (let k = 0; !item && spec.scroller && k < 10; k++) { await H.scrollSidebar(spec.scroller); item = spec.item(id, title); }
        if (!item) return { ok: false, how: "界面", error: "侧边栏里找不到这个会话" };
        item.scrollIntoView({ block: "center" });
        hover(item);
        await sleep(400);
        const trig = item.querySelector(spec.trigger);
        if (!trig) return { ok: false, how: "界面", error: "找不到“更多”按钮" };
        hover(trig);
        clickLike(trig);
        const mi = await waitFor(() => byText(spec.menu, spec.menuText), 3000);
        if (!mi) { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return { ok: false, how: "界面", error: "菜单没出来" }; }
        clickLike(mi);
        const cf = await waitFor(() => byText(spec.confirm, spec.confirmText), 3000);
        if (!cf) return { ok: false, how: "界面", error: "确认框没出来" };
        clickLike(cf);
        const gone = await waitFor(() => !item.isConnected || !visible(item) || !spec.item(id, title), 6000);
        await sleep(500);
        return gone ? { ok: true, how: "界面" } : { ok: false, how: "界面", error: "点了确认，但会话还在列表里" };
      },
    };
    async function adList(max = 200) {
      try {
        const list = await AD.listChats(H, max);
        return { ok: true, count: list.length, list, current: AD.chatId() };
      } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
    }
    async function adDelete(ids) {
      ids = [...new Set((ids || []).filter(Boolean))];
      if (!ids.length) return { ok: false, error: "没给要删除的会话 id" };
      try {
        const results = await AD.deleteChats(H, ids);
        const okN = results.filter((r) => r.ok).length;
        return { ok: okN === ids.length, deleted: okN, failed: ids.length - okN, results };
      } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
    }
    function adStop() {
      const b = firstOf(AD.stop);
      if (b) { clickLike(b); return { ok: true, how: "点了停止按钮" }; }
      return { ok: false, error: isGenerating() ? "找不到停止按钮" : "现在没有在生成" };
    }
    const state = () => ({ site: SITE.id, url: location.href, chatId: AD.chatId(), generating: isGenerating(), inputReady: !!findAdInput(), title: document.title });

    // ------------------------------------------------------------ 中转站的命令（经过后台转过来）
    // 后台：{ type: "aib-cmd", cmd, ... } → 这里执行，结果原样返回；ask 生成过程中用 aib-progress 发进度
    async function runCmd(msg) {
      switch (msg.cmd) {
        case "state": return { ok: true, ...state() };
        case "ready": return adReady(msg.timeoutMs);
        case "newChat": return adNewChat();
        case "send": return { ...(await adSend(msg.text || "", msg.files)), chatId: AD.chatId() };
        case "wait": return { ...(await adWait(msg.timeoutMs, progressFn(msg))), chatId: AD.chatId(), url: location.href };
        case "read": return { ok: true, ...readReply(), generating: isGenerating(), chatId: AD.chatId() };
        case "generating": return { ok: true, generating: isGenerating() };
        case "stop": return adStop();
        case "listChats": return adList(msg.max || 200);
        case "deleteChats": return adDelete(msg.ids);
        case "ask": {
          // 发送 + 等完成（中途发进度）。newChat 需要刷新页面的，由后台先做 newChat 再发 ask
          const s1 = await adSend(msg.text || "", msg.files);
          if (!s1.ok) return s1;
          const r = await adWait(msg.timeoutMs, progressFn(msg));
          return { ...r, ok: !r.error, send: s1, chatId: AD.chatId(), url: location.href };
        }
        default: return { ok: false, error: "不认识的命令：" + msg.cmd };
      }
    }
    function progressFn(msg) {
      if (!msg.reqId) return undefined;
      let last = 0, lastLen = -1;
      return (r) => {
        const now = Date.now();
        if (now - last < 500 || (r.answer || "").length === lastLen) return;
        last = now; lastLen = (r.answer || "").length;
        try { chrome.runtime.sendMessage({ type: "aib-progress", reqId: msg.reqId, site: SITE.id, answer: r.answer, thinkingLen: (r.thinking || "").length, done: r.done }); } catch {}
      };
    }
    if (AD) {
      try {
        chrome.runtime.onMessage.addListener((msg, _s, reply) => {
          if (!msg || msg.type !== "aib-cmd") return false;
          runCmd(msg).then((r) => { reply(r); if (msg.cmd === "newChat" && r.reload) setTimeout(() => location.assign(AD.home), 50); }, (e) => reply({ ok: false, error: String(e && e.message ? e.message : e) }));
          return true;
        });
        // 告诉后台：这个标签页是哪个网站，页面能不能用了
        const hello = (ready) => { try { chrome.runtime.sendMessage({ type: "aib-hello", site: SITE.id, ready, ...state() }); } catch {} };
        hello(false);
        adReady(90000).then((r) => hello(r.ok));
      } catch {}

      // ---- 面板里的会话列表测试
      let shown = [];
      const renderList = (r) => {
        $("cBox").hidden = false;
        if (!r.ok) { $("cBox").textContent = "✗ " + r.error; return; }
        shown = r.list;
        const t = (ms) => ms ? new Date(ms + 8 * 3600e3).toISOString().slice(5, 16).replace("T", " ") : "";
        setHTML($("cBox"), `<div class="muted">共 ${r.list.length} 个${r.current ? "（当前打开的标 ●）" : ""}　<a href="#" id="cAll">全选</a></div>` +
          r.list.map((c, i) => `<label><input type="checkbox" data-i="${i}"><span>${c.id === r.current ? "● " : ""}${c.pinned ? "📌" : ""}${esc(c.title || "(无标题)")}</span><small class="muted">${t(c.updatedAt)}</small></label>`).join(""));
        root.getElementById("cAll").onclick = (e) => { e.preventDefault(); $("cBox").querySelectorAll("input").forEach((x) => (x.checked = true)); };
      };
      const picked = () => [...$("cBox").querySelectorAll("input:checked")].map((x) => shown[Number(x.dataset.i)]).filter(Boolean);
      $("cList").onclick = () => guard(async () => {
        status("获取会话列表…");
        const r = await adList(500);
        logAdapter("listChats", { ok: r.ok, count: r.count, error: r.error, sample: r.list && r.list.slice(0, 5) });
        renderList(r);
        status(r.ok ? `会话列表：${r.count} 个。` : "获取失败：" + r.error);
      });
      $("cDel").onclick = () => guard(async () => {
        const sel = picked();
        if (!sel.length) { status("先勾选要删除的会话。"); return; }
        if (!confirm(`确定删除这 ${sel.length} 个会话？删除后找不回来。\n\n` + sel.slice(0, 10).map((c) => "· " + c.title).join("\n") + (sel.length > 10 ? "\n…" : ""))) return;
        status(`删除 ${sel.length} 个会话…`);
        const r = await adDelete(sel.map((c) => c.id));
        logAdapter("deleteChats", r);
        status(r.error ? "删除失败：" + r.error : `删除完成：成功 ${r.deleted}，失败 ${r.failed}` + (r.failed ? "\n" + r.results.filter((x) => !x.ok).map((x) => "· " + x.error).join("\n") : ""));
        renderList(await adList(500));
      });
      $("cOpen").onclick = () => { const c = picked()[0]; if (!c) { status("先勾选一个会话。"); return; } logAdapter("openChat", { id: c.id, url: c.url }); location.assign(c.url); };
      $("cStop").onclick = () => { const r = adStop(); status(r.ok ? "已停止。" : r.error); };
    }
    // ------------------------------------------------------------ ⑤ 会话列表采样
    const LIST_FLAG = "aib-listsample";
    const LIST_STEPS = "请按顺序做：\n1. 等页面完全加载好\n2. 在左边会话列表里一直往下滚到底（让它加载更多）\n3. 在列表里删除一个不要的对话（用网站自己的删除，确认框也点掉）\n4. 如果网站有“批量删除 / 管理”，也用一次\n5. 点“结束”，再点 ⑥“下载报告”";
    $("listStart").onclick = () => {
      if (S) { status("先结束当前采样。"); return; }
      try { sessionStorage.setItem("aib-arm", "1"); sessionStorage.setItem(LIST_FLAG, String(Date.now())); } catch {}
      status("页面刷新中…");
      location.reload();
    };
    $("listStop").onclick = () => stopSample("手动结束");
    try {
      const t = Number(sessionStorage.getItem(LIST_FLAG) || 0);
      if (t && Date.now() - t < 120000) setTimeout(() => startSample("list", true), 300);
      else { sessionStorage.removeItem("aib-arm"); sessionStorage.removeItem(LIST_FLAG); }
    } catch {}

    // ------------------------------------------------------------ ⑥ 报告
    function buildReport() {
      const input = cur("input"), send = cur("send");
      return {
        tool: VERSION, site: SITE.id, siteName: SITE.name, at: bjTime(),
        pageLoad: pageLoad(),
        page: { url: location.href, title: document.title, ua: navigator.userAgent, viewport: `${innerWidth}x${innerHeight}`, dpr: devicePixelRatio, visibility: document.visibilityState },
        elements: {
          input: input && { ...desc(input), how: how.input && how.input.source, editor: editorKind(input), placeholder: input.getAttribute("placeholder") || input.getAttribute("data-placeholder") || undefined, html: cleanHtml(input, 3000) },
          send: send && { ...desc(send), how: how.send && how.send.source, state: btnState(send) },
          sendCandidates: sendCandidates(input).slice(0, 6).map((c) => ({ score: c.score, ...desc(c.el, 40) })),
          newChat: cur("newChat") && { ...desc(cur("newChat")), how: how.newChat && how.newChat.source },
          composerHtml: cleanHtml(composerOf(input, send), 12000),
        },
        inputTests, newChatTest, adapterTests,
        liveStreams: live.list.map((c) => ({ id: c.id, url: redact(c.url), status: c.status, ct: c.ct, ended: c.ended, error: c.error, bytes: c.text.length, text: redact(c.text.slice(0, 300000)) })),
        samples,
      };
    }
    function summary(rep) {
      const L = [`AI Bridge 采样摘要 · ${rep.siteName} · ${rep.at}`, rep.page.url, ""];
      const e = rep.elements;
      L.push(`输入框：${e.input ? `${e.input.selector}（${e.input.editor}）` : "没找到"}`);
      L.push(`发送按钮：${e.send ? e.send.selector : "没找到"}`);
      L.push(`新建对话：${e.newChat ? e.newChat.selector : "没找到"}`);
      if (rep.inputTests) L.push("输入方式：" + rep.inputTests.results.map((r) => `${r.method}${r.textAppeared ? (r.duplicated ? "⚠重复" : "✓") : "✗"}`).join(" "));
      if (rep.newChatTest) L.push(`新建对话测试：网址${rep.newChatTest.urlChanged ? "变成 " + rep.newChatTest.after.url : "没变"}`);
      for (const s of rep.samples) {
        L.push("", `采样 ${s.no}：${s.mode}，${s.totalSec} 秒，${s.reason}`);
        if (s.send) L.push(`  发送：${s.send.ok ? "成功" : "可能失败"}，${s.send.method || "-"}，${s.send.how || ""}`);
        for (const r of s.network.filter((x) => s.streamIds.includes(x.id))) L.push(`  流：${r.method} ${short(r.url, 100)} [${r.ct || "?"}] ${r.chunks || 0} 块 ${r.bytes || 0} 字节${r.stillOpen ? "（结束时还没关）" : ""}`);
        const rp = s.reply.manual || s.reply.auto;
        if (rp) L.push(`  回复元素：${rp.item.selector}`, `  回复开头：${short(rp.text, 100)}`);
      }
      return L.join("\n");
    }
    function downloadText(text, name, type) {
      const blob = new Blob([text], { type: type + ";charset=utf-8" });
      const fr = new FileReader();
      fr.onload = () => bg({ type: "aib-download", url: fr.result, filename: name.replace(/[\\/:*?"<>|]/g, "_") }).then((r) => {
        if (r.ok) return;
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob); a.download = name; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      });
      fr.readAsDataURL(blob);
    }
    $("download").onclick = () => {
      if (S) { status("先结束采样。"); return; }
      const rep = buildReport();
      const text = JSON.stringify(rep, null, 1);
      downloadText(text, `aib-${SITE.id}-${stamp()}.json`, "application/json");
      status(`已下载报告（${Math.round(text.length / 1024)} KB，${rep.samples.length} 次采样）。\n报告里有这次对话内容和网站返回的数据（登录凭证已尽量隐藏），发给 AI 之前可以先看一眼。`);
    };
    $("copy").onclick = async () => {
      const text = summary(buildReport());
      try { await navigator.clipboard.writeText(text); }
      catch { const ta = document.createElement("textarea"); ta.value = text; root.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); }
      status("摘要已复制。完整数据请用“下载报告”。\n\n" + text);
    };
    $("clear").onclick = () => {
      if (S) { status("先结束采样。"); return; }
      samples.length = 0; inputTests = null; newChatTest = null; lastSample = null; adapterTests.length = 0;
      renderSamples();
      status("已清空采样记录。");
    };

    return { host, show };
  }
})();
