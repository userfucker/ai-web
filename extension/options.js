// AI Web 设置页：中转站 IP / 端口 / 口令 / 名字
const $ = (id) => document.getElementById(id);
const DEF = { relayHost: "", relayPort: 8765, token: "", clientName: "", autoConnect: true, newWindow: true };
const ipOk = (h) => /^(\d{1,3}\.){3}\d{1,3}$/.test(h) ? h.split(".").every((x) => Number(x) <= 255) : /^[a-z0-9.-]+$/i.test(h);
const preview = () => { $("preview").textContent = `ws://${$("host").value.trim() || "IP"}:${$("port").value || 8765}/ext`; };
const say = (t, ok) => { $("msg").textContent = t; $("msg").className = ok === undefined ? "" : ok ? "ok" : "bad"; };
function read() {
  const host = $("host").value.trim().replace(/^wss?:\/\//, "").replace(/[:/].*$/, "");
  const port = Number($("port").value || 8765);
  if (!host || !ipOk(host)) { say("IP 填得不对。", false); return null; }
  if (!(port >= 1 && port <= 65535)) { say("端口要在 1 到 65535 之间。", false); return null; }
  return { relayHost: host, relayPort: port, token: $("token").value, clientName: $("name").value.trim(), autoConnect: $("auto").checked, newWindow: $("newWin").checked };
}
chrome.storage.local.get(Object.keys(DEF), (r) => {
  const s = { ...DEF, ...r };
  $("host").value = s.relayHost; $("port").value = s.relayPort; $("token").value = s.token; $("name").value = s.clientName;
  $("auto").checked = s.autoConnect; $("newWin").checked = s.newWindow;
  preview();
});
$("host").oninput = $("port").oninput = preview;
$("save").onclick = async () => {
  const s = read();
  if (!s) return;
  await chrome.storage.local.set(s);
  say("已保存，正在连接…");
  setTimeout(async () => {
    const r = await chrome.runtime.sendMessage({ type: "aib-popup", cmd: "status" });
    say(r.conn.state === "on" ? "已连上中转站 " + r.relay : r.conn.state === "connecting" ? "连接中…（可以在工具栏弹出窗口里看状态）" : "没连上：" + (r.conn.error || r.conn.state), r.conn.state === "on" ? true : r.conn.state === "connecting" ? undefined : false);
  }, 1500);
};
$("test").onclick = async () => {
  const s = read();
  if (!s) return;
  say("测试中…");
  const r = await chrome.runtime.sendMessage({ type: "aib-popup", cmd: "test", host: s.relayHost, port: s.relayPort, token: s.token, name: s.clientName });
  say(r.ok ? `能连上，口令也对。${r.server ? "中转站：" + r.server : ""}\n（测试不会保存，点“保存并连接”才会用这个设置）` : "不行：" + r.error, r.ok);
};
