// AI Web 弹出窗口：连接状态、四个网站的状态
const $ = (id) => document.getElementById(id);
const bg = (cmd, extra) => chrome.runtime.sendMessage({ type: "aib-popup", cmd, ...extra });
const STATE = { on: "已连接中转站", connecting: "连接中…", error: "没连上", off: "未连接" };
async function render() {
  const r = await bg("status");
  $("dot").className = "dot " + r.conn.state;
  $("ct").textContent = (STATE[r.conn.state] || r.conn.state) + (r.relay ? "  " + r.relay : "");
  $("ce").textContent = r.relay ? r.conn.error || "" : "先在“设置”里填中转站 IP";
  $("cbtn").textContent = r.conn.state === "on" || r.conn.state === "connecting" ? "断开" : "连接";
  $("cbtn").onclick = async () => { await bg(r.conn.state === "on" || r.conn.state === "connecting" ? "disconnect" : "connect"); setTimeout(render, 600); };
  $("sites").replaceChildren(...r.sites.map((s) => {
    const d = document.createElement("div");
    d.className = "site";
    const n = document.createElement("span"); n.className = "n"; n.textContent = s.name;
    const st = document.createElement("span"); st.className = "s"; st.textContent = !s.open ? "没打开" : s.ready ? (s.chatId ? "就绪 · 会话中" : "就绪") : "加载中…";
    d.append(n, st);
    if (s.open) { const b = document.createElement("button"); b.textContent = "切换"; b.onclick = () => bg("focus", { site: s.site }); d.append(b); }
    return d;
  }));
  $("ver").textContent = "AI Web " + r.version;
}
$("openAll").onclick = async () => { $("openAll").disabled = true; $("openAll").textContent = "打开中…"; const t = setInterval(render, 1000); await bg("openAll"); clearInterval(t); $("openAll").disabled = false; $("openAll").textContent = "打开四个网站"; render(); };
$("opts").onclick = () => chrome.runtime.openOptionsPage();
$("debug").onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try { await chrome.tabs.sendMessage(tab.id, { type: "aib-toggle" }); window.close(); }
  catch { $("ce").textContent = "当前页不是这四个 AI 网站之一（或者要先刷新页面）"; }
};
render();
setInterval(render, 2000);
