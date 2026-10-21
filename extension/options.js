// AI Web 设置页：保存的服务器（名字 / IP / 端口 / 口令，口令明文显示）、这台电脑的名字
// 当前用的服务器写在 relayHost / relayPort / token（background.js 读这三个），保存的列表在 servers，选中的是 serverId
const $ = (id) => document.getElementById(id);
const DEF = { relayHost: "", relayPort: 8765, token: "", clientName: "", autoConnect: true, newWindow: true, servers: [], serverId: "" };
const ipOk = (h) => /^(\d{1,3}\.){3}\d{1,3}$/.test(h) ? h.split(".").every((x) => Number(x) <= 255) : /^[a-z0-9.-]+$/i.test(h);
const preview = () => { $("preview").textContent = `ws://${$("host").value.trim() || "IP"}:${$("port").value || 8765}/ext`; };
const say = (t, ok) => { $("msg").textContent = t; $("msg").className = ok === undefined ? "" : ok ? "ok" : "bad"; };
const guessName = (port) => (Number(port) === 8766 ? "AI图图 工作台" : "AI 会议");
let servers = [];
function fill(sv) {
  $("sname").value = sv ? sv.name : "";
  $("host").value = sv ? sv.host : "";
  $("port").value = sv ? sv.port : 8765;
  $("token").value = sv ? sv.token : "";
  $("del").disabled = !sv;
  preview();
}
function drawList(sel) {
  $("srv").innerHTML = "";
  for (const sv of servers) $("srv").append(new Option(`${sv.name}（${sv.host}:${sv.port}）`, sv.id));
  $("srv").append(new Option("＋ 新的服务器", ""));
  $("srv").value = sel && servers.some((x) => x.id === sel) ? sel : "";
}
function read() {
  const host = $("host").value.trim().replace(/^wss?:\/\//, "").replace(/[:/].*$/, "");
  const port = Number($("port").value || 8765);
  if (!host || !ipOk(host)) { say("IP 填得不对。", false); return null; }
  if (!(port >= 1 && port <= 65535)) { say("端口要在 1 到 65535 之间。", false); return null; }
  return { name: $("sname").value.trim() || guessName(port), relayHost: host, relayPort: port, token: $("token").value.trim(), clientName: $("name").value.trim(), autoConnect: $("auto").checked, newWindow: $("newWin").checked };
}
chrome.storage.local.get(Object.keys(DEF), (r) => {
  const s = { ...DEF, ...r };
  servers = Array.isArray(s.servers) ? s.servers : [];
  let sel = s.serverId;
  // 老版本只有一组设置：存成第一个服务器
  if (!servers.length && s.relayHost) {
    sel = "s" + Date.now().toString(36);
    servers = [{ id: sel, name: guessName(s.relayPort), host: s.relayHost, port: s.relayPort, token: s.token }];
    chrome.storage.local.set({ servers, serverId: sel });
  }
  drawList(sel);
  fill(servers.find((x) => x.id === $("srv").value));
  $("name").value = s.clientName;
  $("auto").checked = s.autoConnect; $("newWin").checked = s.newWindow;
});
$("srv").onchange = () => { fill(servers.find((x) => x.id === $("srv").value)); say("选好以后点“保存并连接”"); };
$("host").oninput = $("port").oninput = preview;
$("del").onclick = async () => {
  const id = $("srv").value;
  if (!id || !confirm("删除这个服务器？")) return;
  servers = servers.filter((x) => x.id !== id);
  await chrome.storage.local.set({ servers });
  drawList("");
  fill(null);
  say("已删除");
};
$("save").onclick = async () => {
  const s = read();
  if (!s) return;
  let id = $("srv").value;
  const sv = { id: id || "s" + Date.now().toString(36), name: s.name, host: s.relayHost, port: s.relayPort, token: s.token };
  servers = id ? servers.map((x) => (x.id === id ? sv : x)) : [...servers, sv];
  id = sv.id;
  await chrome.storage.local.set({ relayHost: s.relayHost, relayPort: s.relayPort, token: s.token, clientName: s.clientName, autoConnect: s.autoConnect, newWindow: s.newWindow, servers, serverId: id });
  drawList(id);
  say(`已保存“${sv.name}”，正在连接…`);
  setTimeout(async () => {
    const r = await chrome.runtime.sendMessage({ type: "aib-popup", cmd: "status" });
    say(r.conn.state === "on" ? `已连上“${sv.name}” ` + r.relay : r.conn.state === "connecting" ? "连接中…（可以在工具栏弹出窗口里看状态）" : "没连上：" + (r.conn.error || r.conn.state), r.conn.state === "on" ? true : r.conn.state === "connecting" ? undefined : false);
  }, 1500);
};
$("test").onclick = async () => {
  const s = read();
  if (!s) return;
  say("测试中…");
  const r = await chrome.runtime.sendMessage({ type: "aib-popup", cmd: "test", host: s.relayHost, port: s.relayPort, token: s.token, name: s.clientName });
  say(r.ok ? `能连上，口令也对。${r.server ? "中转站：" + r.server : ""}\n（测试不会保存，点“保存并连接”才会用这个设置）` : "不行：" + r.error, r.ok);
};
