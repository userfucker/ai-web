/**
 * AI Web · 后台（2026-10-14）
 *
 *  - 连局域网中转站：ws://<设置里的 IP>:<端口>/ext，断了自动重连（1 秒起，最长 30 秒），每 20 秒一次心跳
 *    （Chrome 116 以后，有 WebSocket 消息来往时后台不会被休眠）
 *  - 记住每个网站在哪个标签页（content.js 加载后会发 aib-hello）
 *  - 把中转站的命令转给对应网站的标签页，结果 / 进度发回中转站
 *  - 打开网站、打开某个会话：用标签页跳转，等页面准备好再回结果
 *
 * 协议见 docs/protocol.md
 */
importScripts("sites.js");
const SITES = self.AIB_SITES;
const SITE_IDS = Object.keys(SITES);
const VERSION = chrome.runtime.getManifest().version;
const HOST_RE = {
  deepseek: /^https:\/\/([^/]+\.)?deepseek\.com\//,
  glm: /^https:\/\/([^/]+\.)?chatglm\.cn\//,
  kimi: /^https:\/\/([^/]+\.)?(kimi\.com|moonshot\.cn)\//,
  qwen: /^https:\/\/([^/]+\.)?(tongyi\.com|qianwen\.com)\//,
};
const siteOfUrl = (url) => SITE_IDS.find((s) => HOST_RE[s].test(url || "")) || null;
const DEFAULTS = { relayHost: "", relayPort: 8765, token: "", clientName: "", autoConnect: true, newWindow: true };
const getSettings = async () => ({ ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) });

// ---------------------------------------------------------------- 标签页
const tabs = new Map(); // site -> { tabId, windowId, ready, url, chatId, at }
const helloWaiters = []; // { tabId, needReady, resolve }
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg) return false;
  const tab = sender.tab;
  if (msg.type === "aib-hello" && tab) {
    tabs.set(msg.site, { tabId: tab.id, windowId: tab.windowId, ready: !!msg.ready, url: msg.url, chatId: msg.chatId, title: msg.title, at: Date.now() });
    for (let i = helloWaiters.length - 1; i >= 0; i--) {
      const w = helloWaiters[i];
      if (w.tabId === tab.id && (!w.needReady || msg.ready)) { helloWaiters.splice(i, 1); w.resolve(msg); }
    }
    wsSend({ type: "event", event: "tab", site: msg.site, data: siteInfo(msg.site) });
    return false;
  }
  if (msg.type === "aib-progress") { wsSend({ type: "progress", id: msg.reqId, site: msg.site, answer: msg.answer, thinkingLen: msg.thinkingLen, done: msg.done }); return false; }
  if (msg.type === "aib-download" && tab) {
    chrome.downloads.download({ url: msg.url, filename: msg.filename, saveAs: false })
      .then(() => reply({ ok: true }))
      .catch((e) => reply({ ok: false, error: String(e && e.message ? e.message : e) }));
    return true;
  }
  if (msg.type === "aib-inject-hook" && tab) {
    chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [sender.frameId || 0] }, world: "MAIN", files: ["hook.js"] })
      .then(() => reply({ ok: true }))
      .catch((e) => reply({ ok: false, error: String(e && e.message ? e.message : e) }));
    return true;
  }
  // 弹出窗口 / 设置页
  if (msg.type === "aib-popup") { popupCmd(msg).then(reply, (e) => reply({ ok: false, error: String(e) })); return true; }
  return false;
});
chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [site, t] of tabs) if (t.tabId === tabId) { tabs.delete(site); wsSend({ type: "event", event: "tab", site, data: siteInfo(site) }); }
});
function siteInfo(site) {
  const t = tabs.get(site);
  return { site, name: SITES[site].name, open: !!t, tabId: t && t.tabId, windowId: t && t.windowId, ready: !!(t && t.ready), url: t && t.url, chatId: t && t.chatId, title: t && t.title };
}
const waitHello = (tabId, needReady, ms) => new Promise((resolve) => {
  const w = { tabId, needReady, resolve };
  helloWaiters.push(w);
  setTimeout(() => { const i = helloWaiters.indexOf(w); if (i >= 0) { helloWaiters.splice(i, 1); resolve(null); } }, ms);
});
/** 找这个网站的标签页：先用记下的，失效了按网址找 */
async function findTab(site) {
  const t = tabs.get(site);
  if (t) { try { const tab = await chrome.tabs.get(t.tabId); if (siteOfUrl(tab.url) === site) return tab; } catch {} tabs.delete(site); }
  const all = await chrome.tabs.query({});
  return all.find((x) => siteOfUrl(x.url) === site) || null;
}
/** 确保网站打开着、页面能用；没打开就新开（默认单独一个窗口：同一窗口的后台标签页会被浏览器限流） */
async function ensureTab(site, timeoutMs = 90000) {
  let tab = await findTab(site);
  if (!tab) {
    const st = await getSettings();
    if (st.newWindow) { const w = await chrome.windows.create({ url: SITES[site].home, focused: false, width: 1100, height: 900 }); tab = w.tabs[0]; }
    else tab = await chrome.tabs.create({ url: SITES[site].home, active: false });
    const h = await waitHello(tab.id, true, timeoutMs);
    if (!h) throw new Error(`${SITES[site].name} 打开 ${Math.round(timeoutMs / 1000)} 秒了页面还没准备好（网速慢、没登录或者要验证）`);
    return tab;
  }
  const t = tabs.get(site);
  if (!t) {
    // 标签页在，但 content.js 没报到（插件是在页面打开之后装 / 刷新的）：刷新一下
    await chrome.tabs.reload(tab.id);
    const h = await waitHello(tab.id, true, timeoutMs);
    if (!h) throw new Error(`${SITES[site].name} 刷新后 ${Math.round(timeoutMs / 1000)} 秒页面还没准备好`);
  } else if (!t.ready) {
    const h = await waitHello(tab.id, true, timeoutMs);
    if (!h) throw new Error(`${SITES[site].name} 页面还没准备好`);
  }
  return tab;
}
/** 发命令给标签页里的 content.js；页面刷新 / 跳转会让这次通话断掉 */
function toTab(tabId, msg, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ ok: false, error: `等了 ${Math.round(ms / 1000)} 秒没有结果` }), ms);
    chrome.tabs.sendMessage(tabId, msg).then(
      (r) => { clearTimeout(t); resolve(r || { ok: false, error: "页面没有回应" }); },
      (e) => { clearTimeout(t); resolve({ ok: false, error: "页面断开了（刷新或跳转了）：" + (e && e.message ? e.message : e), disconnected: true }); },
    );
  });
}
/** 跳转到网址，等新页面准备好 */
async function navigate(site, url, timeoutMs = 90000) {
  const tab = await ensureTab(site, timeoutMs);
  const p = waitHello(tab.id, true, timeoutMs);
  await chrome.tabs.update(tab.id, { url });
  const h = await p;
  if (!h) throw new Error(`打开 ${url} 后 ${Math.round(timeoutMs / 1000)} 秒页面还没准备好`);
  return { ok: true, ...siteInfo(site) };
}

// ---------------------------------------------------------------- 命令
const LONG = 11 * 60 * 1000;
async function runCommand(site, cmd, args = {}, id) {
  if (cmd === "status") return { ok: true, version: VERSION, sites: SITE_IDS.map(siteInfo) };
  if (!SITES[site]) throw new Error("不认识的网站：" + site + "（可以用：" + SITE_IDS.join("、") + "）");
  const A = SITES[site];
  switch (cmd) {
    case "open": await ensureTab(site, args.timeoutMs || 90000); return { ok: true, ...siteInfo(site) };
    case "focus": { const tab = await ensureTab(site); await chrome.windows.update(tab.windowId, { focused: true }); await chrome.tabs.update(tab.id, { active: true }); return { ok: true }; }
    case "reload": { const tab = await ensureTab(site); const p = waitHello(tab.id, true, 90000); await chrome.tabs.reload(tab.id); if (!(await p)) throw new Error("刷新后页面还没准备好"); return { ok: true, ...siteInfo(site) }; }
    case "openChat": {
      const url = args.url || (args.chatId && A.chatUrl(args.chatId));
      if (!url) throw new Error("openChat 要给 chatId 或 url");
      return navigate(site, url, args.timeoutMs || 90000);
    }
    case "newChat": return newChat(site);
    case "ask": {
      if (args.newChat) { const n = await newChat(site); if (!n.ok) return n; }
      const tab = await ensureTab(site);
      return toTab(tab.id, { type: "aib-cmd", cmd: "ask", text: args.text, timeoutMs: args.timeoutMs, reqId: id }, (args.timeoutMs || 300000) + 60000);
    }
    case "state": case "ready": case "send": case "wait": case "read": case "generating": case "stop": case "listChats": case "deleteChats": {
      const tab = await ensureTab(site);
      return toTab(tab.id, { type: "aib-cmd", cmd, ...args, reqId: id }, cmd === "wait" ? (args.timeoutMs || 300000) + 60000 : cmd === "deleteChats" ? LONG : 120000);
    }
    default: throw new Error("不认识的命令：" + cmd);
  }
}
async function newChat(site) {
  const tab = await ensureTab(site);
  const p = waitHello(tab.id, true, 90000);
  const r = await toTab(tab.id, { type: "aib-cmd", cmd: "newChat" }, 30000);
  if (r.reload || r.disconnected) {
    // content.js 自己跳去首页了（或者点“新对话”整页刷新了）：等新页面
    const h = await p;
    if (!h) return { ok: false, error: "新对话页面打开后还没准备好" };
    return { ok: true, how: r.how || "页面刷新", ...siteInfo(site) };
  }
  return r;
}

// ---------------------------------------------------------------- 中转站连接
let ws = null, wsState = "off", wsError = "", retry = 0, retryTimer = null, pingTimer = null, manualOff = false;
function setState(s, err) {
  wsState = s;
  if (err !== undefined) wsError = err;
  chrome.storage.session.set({ aibConn: { state: wsState, error: wsError, at: Date.now() } }).catch(() => {});
  chrome.action.setBadgeText({ text: s === "on" ? "" : s === "connecting" ? "…" : "!" }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: s === "on" ? "#16a34a" : "#dc2626" }).catch(() => {});
  if (s === "off" && manualOff) chrome.action.setBadgeText({ text: "" }).catch(() => {});
}
function wsSend(obj) { if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch {} } }
async function connect() {
  clearTimeout(retryTimer);
  const st = await getSettings();
  if (!st.relayHost) { setState("off", "还没设置中转站 IP"); return; }
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  manualOff = false;
  const url = `ws://${st.relayHost}:${st.relayPort}/ext`;
  setState("connecting", "");
  let sock;
  try { sock = new WebSocket(url); } catch (e) { setState("error", "地址不对：" + e.message); return; }
  ws = sock;
  sock.onopen = () => {
    retry = 0;
    setState("on", "");
    sock.send(JSON.stringify({ type: "hello", role: "extension", token: st.token, name: st.clientName || "chrome", version: VERSION, sites: SITE_IDS.map(siteInfo) }));
    clearInterval(pingTimer);
    pingTimer = setInterval(() => wsSend({ type: "ping", t: Date.now() }), 20000);
  };
  sock.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === "ping") { wsSend({ type: "pong", t: m.t }); return; }
    if (m.type === "error") { setState("error", m.error || "中转站报错"); if (m.fatal) { manualOff = true; sock.close(); } return; }
    if (m.type === "cmd") {
      const { id, site, cmd, args } = m;
      runCommand(site, cmd, args || {}, id).then(
        (data) => wsSend({ type: "result", id, site, cmd, ok: data && data.ok !== false, data }),
        (err) => wsSend({ type: "result", id, site, cmd, ok: false, data: { ok: false, error: String(err && err.message ? err.message : err) } }),
      );
    }
  };
  sock.onclose = (e) => {
    clearInterval(pingTimer);
    if (ws === sock) ws = null;
    if (manualOff) { setState("off", ""); return; }
    setState("error", wsError || `连接断开（${e.code}）`);
    scheduleRetry();
  };
  sock.onerror = () => { setState("error", `连不上 ${url}（中转站没开、IP / 端口不对，或者被防火墙挡了）`); };
}
async function scheduleRetry() {
  const st = await getSettings();
  if (!st.autoConnect || manualOff || !st.relayHost) return;
  const delay = Math.min(30000, 1000 * 2 ** Math.min(retry++, 5));
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connect, delay);
}
function disconnect() { manualOff = true; clearTimeout(retryTimer); if (ws) ws.close(); else setState("off", ""); }

// 后台被浏览器休眠后醒来（定时器每分钟一次）：该连的时候连上
chrome.alarms.create("aib-keep", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async (a) => { if (a.name === "aib-keep" && !manualOff && (!ws || ws.readyState > 1)) { const st = await getSettings(); if (st.autoConnect && st.relayHost) connect(); } });
chrome.runtime.onStartup.addListener(() => connect());
chrome.runtime.onInstalled.addListener(() => connect());
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === "local" && (ch.relayHost || ch.relayPort || ch.token || ch.clientName)) { if (ws) { manualOff = true; ws.close(); } setTimeout(() => { manualOff = false; connect(); }, 300); }
});
connect();

// ---------------------------------------------------------------- 弹出窗口
async function popupCmd(msg) {
  switch (msg.cmd) {
    case "status": { const st = await getSettings(); return { ok: true, conn: { state: wsState, error: wsError }, relay: st.relayHost ? `${st.relayHost}:${st.relayPort}` : "", sites: SITE_IDS.map(siteInfo), version: VERSION }; }
    case "connect": manualOff = false; retry = 0; if (ws) ws.close(); setTimeout(connect, 200); return { ok: true };
    case "disconnect": disconnect(); return { ok: true };
    case "openAll": { const r = await Promise.allSettled(SITE_IDS.map((s) => ensureTab(s))); return { ok: true, results: r.map((x, i) => ({ site: SITE_IDS[i], ok: x.status === "fulfilled", error: x.reason && String(x.reason.message || x.reason) })) }; }
    case "focus": return runCommand(msg.site, "focus");
    case "test": {
      // 设置页的“测试连接”：单独连一次，看能不能连上、口令对不对
      const url = `ws://${msg.host}:${msg.port}/ext`;
      return new Promise((resolve) => {
        let s, done = false;
        const end = (r) => { if (done) return; done = true; try { s.close(); } catch {} resolve(r); };
        try { s = new WebSocket(url); } catch (e) { resolve({ ok: false, error: "地址不对：" + e.message }); return; }
        const t = setTimeout(() => end({ ok: false, error: "5 秒没连上（中转站没开、IP / 端口不对，或者被防火墙挡了）" }), 5000);
        s.onopen = () => s.send(JSON.stringify({ type: "hello", role: "extension", token: msg.token, name: (msg.name || "chrome") + "（测试）", version: VERSION, test: true, sites: [] }));
        s.onmessage = (e) => { let m = {}; try { m = JSON.parse(e.data); } catch {} if (m.type === "welcome") { clearTimeout(t); end({ ok: true, server: m.server }); } if (m.type === "error") { clearTimeout(t); end({ ok: false, error: m.error }); } };
        s.onerror = () => { clearTimeout(t); end({ ok: false, error: `连不上 ${url}` }); };
      });
    }
    default: return { ok: false, error: "?" };
  }
}
