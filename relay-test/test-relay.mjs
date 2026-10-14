#!/usr/bin/env node
/**
 * AI Web · 测试用中转站（2026-10-14）
 *
 * 不用装任何依赖：node test-relay.mjs [--port 8765] [--token 口令]
 *  - 插件连 ws://本机IP:8765/ext
 *  - 浏览器打开 http://本机IP:8765/ ，可以同时给四个 AI 发问题、看回复、管理会话列表
 *
 * 只是用来测插件的，正式的中转站另外写。协议见 ../docs/protocol.md
 */
import http from "node:http";
import crypto from "node:crypto";
import os from "node:os";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const PORT = Number(arg("--port", process.env.PORT || 8765));
const TOKEN = arg("--token", process.env.TOKEN || "");
const NAME = "test-relay";

// ---------------------------------------------------------------- 最小的 WebSocket 服务端（RFC 6455，只用文字帧）
function wsAccept(req, socket) {
  const key = req.headers["sec-websocket-key"];
  if (!key) { socket.destroy(); return null; }
  const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  const conn = { socket, onmessage: null, onclose: null, alive: true };
  let buf = Buffer.alloc(0), frag = [];
  const frame = (op, payload) => {
    const len = payload.length;
    const head = len < 126 ? Buffer.from([0x80 | op, len]) : len < 65536 ? Buffer.from([0x80 | op, 126, len >> 8, len & 255]) : (() => { const b = Buffer.alloc(10); b[0] = 0x80 | op; b[1] = 127; b.writeBigUInt64BE(BigInt(len), 2); return b; })();
    try { socket.write(Buffer.concat([head, payload])); } catch {}
  };
  conn.send = (obj) => { if (conn.alive) frame(1, Buffer.from(typeof obj === "string" ? obj : JSON.stringify(obj))); };
  conn.close = () => { if (conn.alive) { frame(8, Buffer.alloc(0)); socket.end(); } };
  socket.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80, op = buf[0] & 0x0f, masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const mOff = off; if (masked) off += 4;
      if (buf.length < off + len) return;
      let p = buf.subarray(off, off + len);
      if (masked) { const m = buf.subarray(mOff, mOff + 4); p = Buffer.from(p.map((b, i) => b ^ m[i & 3])); }
      buf = buf.subarray(off + len);
      if (op === 8) { conn.close(); return; }
      if (op === 9) { frame(10, p); continue; }
      if (op === 10) continue;
      if (op === 1 || op === 2 || op === 0) {
        frag.push(p);
        if (fin) { const text = Buffer.concat(frag).toString("utf8"); frag = []; let m; try { m = JSON.parse(text); } catch { continue; } conn.onmessage && conn.onmessage(m); }
      }
    }
  });
  const end = () => { if (!conn.alive) return; conn.alive = false; conn.onclose && conn.onclose(); };
  socket.on("close", end);
  socket.on("error", end);
  return conn;
}

// ---------------------------------------------------------------- 中转
const exts = new Map(); // id -> { conn, name, version, sites }
const uis = new Set();
const pending = new Map(); // 命令 id -> ui 连接
let seq = 0;
const extList = () => [...exts.entries()].map(([id, e]) => ({ id, name: e.name, version: e.version, sites: e.sites }));
const toUis = (m) => { for (const u of uis) u.send(m); };

function onExt(conn) {
  let id = null;
  conn.onmessage = (m) => {
    if (m.type === "hello") {
      if (TOKEN && m.token !== TOKEN) { conn.send({ type: "error", error: "口令不对", fatal: true }); setTimeout(() => conn.close(), 100); return; }
      conn.send({ type: "welcome", server: NAME });
      if (m.test) { setTimeout(() => conn.close(), 200); return; }
      id = "e" + ++seq;
      exts.set(id, { conn, name: m.name, version: m.version, sites: Object.fromEntries((m.sites || []).map((s) => [s.site, s])) });
      log(`插件连上了：${m.name}（${m.version}）`);
      toUis({ type: "exts", exts: extList() });
      return;
    }
    if (!id) return;
    if (m.type === "ping") { conn.send({ type: "pong", t: m.t }); return; }
    if (m.type === "event" && m.event === "tab") { exts.get(id).sites[m.site] = m.data; toUis({ type: "exts", exts: extList() }); return; }
    if (m.type === "result" || m.type === "progress") {
      const ui = pending.get(m.id);
      if (ui) ui.send(m);
      if (m.type === "result") { pending.delete(m.id); log(`结果 ${m.id} ${m.site} ${m.cmd} ${m.ok ? "✓" : "✗ " + (m.data && m.data.error)}`); }
    }
  };
  conn.onclose = () => { if (id) { exts.delete(id); log("插件断开了"); toUis({ type: "exts", exts: extList() }); } };
}
function onUi(conn, url) {
  if (TOKEN && url.searchParams.get("token") !== TOKEN) { conn.send({ type: "error", error: "口令不对" }); setTimeout(() => conn.close(), 100); return; }
  uis.add(conn);
  conn.send({ type: "exts", exts: extList() });
  conn.onmessage = (m) => {
    if (m.type !== "cmd") return;
    const e = m.ext ? exts.get(m.ext) : exts.values().next().value;
    if (!e) { conn.send({ type: "result", id: m.id, site: m.site, cmd: m.cmd, ok: false, data: { error: "没有插件连上" } }); return; }
    pending.set(m.id, conn);
    e.conn.send({ type: "cmd", id: m.id, site: m.site, cmd: m.cmd, args: m.args || {} });
    log(`命令 ${m.id} → ${m.site} ${m.cmd}`);
  };
  conn.onclose = () => uis.delete(conn);
}
const log = (t) => console.log(new Date().toLocaleTimeString("zh-CN", { hour12: false }), t);

const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url.startsWith("/?")) { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(PAGE); return; }
  res.writeHead(404); res.end("not found");
});
server.on("upgrade", (req, socket) => {
  const url = new URL(req.url, "http://x");
  const conn = wsAccept(req, socket);
  if (!conn) return;
  if (url.pathname === "/ext") onExt(conn);
  else if (url.pathname === "/ui") onUi(conn, url);
  else conn.close();
});
server.listen(PORT, "0.0.0.0", () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter((x) => x && x.family === "IPv4" && !x.internal).map((x) => x.address);
  console.log(`测试中转站已启动，端口 ${PORT}${TOKEN ? "，口令已设置" : "（没设口令）"}`);
  for (const ip of ips.length ? ips : ["127.0.0.1"]) console.log(`  插件设置里填 IP：${ip}  端口：${PORT}      控制页：http://${ip}:${PORT}/`);
});

// ---------------------------------------------------------------- 控制页
const PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI Web 测试中转站</title>
<style>
:root{color-scheme:light dark;--bg:#fafafa;--card:#fff;--fg:#18181b;--muted:#71717a;--line:#e4e4e7;--ok:#16a34a;--bad:#dc2626}
@media (prefers-color-scheme:dark){:root{--bg:#18181b;--card:#27272a;--fg:#f4f4f5;--muted:#a1a1aa;--line:#3f3f46}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
header{padding:12px 16px;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:center;flex-wrap:wrap}header b{font-size:16px}
#conn{color:var(--muted);font-size:13px}
.ask{padding:12px 16px;display:flex;gap:10px;flex-wrap:wrap;align-items:flex-start}
textarea{flex:1 1 420px;min-height:72px;border:1px solid var(--line);border-radius:10px;padding:8px;background:var(--card);color:inherit;font:inherit}
.ctl{display:flex;flex-direction:column;gap:6px}.ctl label{font-size:13px}
button{border:1px solid var(--line);background:var(--card);color:inherit;border-radius:9px;padding:6px 12px;font:inherit;cursor:pointer}button.pri{background:var(--fg);color:var(--bg);border-color:var(--fg)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px;padding:0 16px 16px}
.col{background:var(--card);border:1px solid var(--line);border-radius:12px;display:flex;flex-direction:column;min-height:240px}
.col h3{margin:0;padding:8px 12px;border-bottom:1px solid var(--line);font-size:14px;display:flex;gap:8px;align-items:center}
.col h3 small{color:var(--muted);font-weight:400;flex:1}
.st{padding:4px 12px;font-size:12px;color:var(--muted)}.st.ok{color:var(--ok)}.st.bad{color:var(--bad)}
.out{padding:8px 12px;white-space:pre-wrap;overflow-wrap:anywhere;flex:1;max-height:420px;overflow:auto;font-size:13px}
.tools{padding:6px 12px;border-top:1px solid var(--line);display:flex;gap:6px;flex-wrap:wrap}.tools button{padding:3px 8px;font-size:12px}
.list{padding:0 12px 8px;max-height:220px;overflow:auto;font-size:12px}.list label{display:flex;gap:6px}.list label span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
details{padding:0 16px 16px}pre{white-space:pre-wrap;font:12px ui-monospace,Consolas,monospace;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px;max-height:300px;overflow:auto}
</style></head><body>
<header><b>AI Web 测试中转站</b><span id="conn">连接中…</span></header>
<div class="ask"><textarea id="q" placeholder="输入问题，同时发给勾选的网站">用一句话介绍你自己。</textarea>
<div class="ctl"><div id="pick"></div><label><input type="checkbox" id="nc" checked> 先新建对话</label><button class="pri" id="go">发送</button></div></div>
<div class="grid" id="grid"></div>
<details><summary>手动命令 / 日志</summary>
<p><select id="rs"></select> <input id="rc" value="state" size="12"> <input id="ra" value="{}" size="40"> <button id="rgo">执行</button></p><pre id="log"></pre></details>
<script>
const SITES={deepseek:"DeepSeek",glm:"智谱清言",kimi:"Kimi",qwen:"千问"};
const token=new URLSearchParams(location.search).get("token")||localStorage.getItem("aibToken")||"";
let ws,seq=0;const wait=new Map(),prog=new Map();let exts=[];
const $=id=>document.getElementById(id);
const log=t=>{$("log").textContent=(new Date().toLocaleTimeString()+" "+t+"\\n"+$("log").textContent).slice(0,30000)};
$("grid").innerHTML=Object.entries(SITES).map(([k,n])=>'<div class="col" id="c-'+k+'"><h3>'+n+' <small id="t-'+k+'">-</small></h3><div class="st" id="s-'+k+'"></div><div class="out" id="o-'+k+'"></div><div class="list" id="l-'+k+'"></div><div class="tools"><button data-a="open">打开</button><button data-a="newChat">新对话</button><button data-a="stop">停止</button><button data-a="list">会话列表</button><button data-a="del">删除选中</button><button data-a="openChat">打开选中</button><button data-a="focus">切到窗口</button></div></div>').join("");
$("pick").innerHTML=Object.entries(SITES).map(([k,n])=>'<label><input type="checkbox" data-s="'+k+'" checked> '+n+'</label>').join(" ");
$("rs").innerHTML=Object.entries(SITES).map(([k,n])=>'<option value="'+k+'">'+n+'</option>').join("");
function connect(){ws=new WebSocket((location.protocol==="https:"?"wss":"ws")+"://"+location.host+"/ui?token="+encodeURIComponent(token));
 ws.onopen=()=>$("conn").textContent="已连上中转站";
 ws.onclose=()=>{$("conn").textContent="和中转站断开了，3 秒后重连";setTimeout(connect,3000)};
 ws.onmessage=e=>{const m=JSON.parse(e.data);
  if(m.type==="error"){const t=prompt("口令不对，请输入中转站口令：");if(t!==null){localStorage.setItem("aibToken",t);location.search="?token="+encodeURIComponent(t)}return}
  if(m.type==="exts"){exts=m.exts;const e0=exts[0];$("conn").textContent=exts.length?"插件："+exts.map(x=>x.name+"（"+x.version+"）").join("、"):"还没有插件连上（检查插件设置里的 IP 和端口）";
   for(const k in SITES){const s=e0&&e0.sites[k];$("t-"+k).textContent=!e0?"-":!s||!s.open?"没打开":s.ready?"就绪"+(s.chatId?" · "+s.chatId.slice(0,8):""):"加载中…"}return}
  if(m.type==="progress"){const f=prog.get(m.id);f&&f(m);return}
  if(m.type==="result"){log(m.site+" "+m.cmd+" → "+JSON.stringify(m.data).slice(0,600));const w=wait.get(m.id);if(w){wait.delete(m.id);w(m)}}}}
connect();
const cmd=(site,c,args={},onProg)=>new Promise(r=>{const id="u"+(++seq)+"-"+Date.now();wait.set(id,m=>{prog.delete(id);r(m)});if(onProg)prog.set(id,onProg);ws.send(JSON.stringify({type:"cmd",id,site,cmd:c,args}))});
const st=(k,t,c)=>{$("s-"+k).textContent=t;$("s-"+k).className="st "+(c||"")};
async function ask(k,text,nc){st(k,"发送中…");$("o-"+k).textContent="";const t0=Date.now();
 const m=await cmd(k,"ask",{text,newChat:nc},p=>{$("o-"+k).textContent=p.answer||"";st(k,"生成中… "+(p.answer||"").length+" 字"+(p.thinkingLen?"（思考 "+p.thinkingLen+" 字，已去掉）":""))});
 const d=m.data||{};if(d.answer!==undefined)$("o-"+k).textContent=d.answer;
 st(k,m.ok?"✓ 完成 · "+((Date.now()-t0)/1000).toFixed(1)+" 秒 · "+(d.answer||"").length+" 字":"✗ "+(d.error||"失败"),m.ok?"ok":"bad")}
$("go").onclick=()=>{const text=$("q").value.trim();if(!text)return;const nc=$("nc").checked;
 document.querySelectorAll("#pick input:checked").forEach(x=>ask(x.dataset.s,text,nc))};
const lists={};
document.querySelectorAll(".col").forEach(col=>col.addEventListener("click",async e=>{const a=e.target.dataset.a;if(!a)return;const k=col.id.slice(2);
 const sel=()=>[...col.querySelectorAll(".list input:checked")].map(x=>lists[k][+x.dataset.i]);
 if(a==="list"){st(k,"获取会话列表…");const m=await cmd(k,"listChats",{max:300});const d=m.data||{};if(!m.ok){st(k,"✗ "+d.error,"bad");return}
  lists[k]=d.list;$("l-"+k).innerHTML="<div>共 "+d.list.length+" 个</div>"+d.list.map((c,i)=>'<label><input type="checkbox" data-i="'+i+'"><span>'+(c.id===d.current?"● ":"")+(c.title||"(无标题)").replace(/</g,"&lt;")+'</span></label>').join("");st(k,"会话列表：共 "+d.list.length+" 个","ok");return}
 if(a==="del"){const s=sel();if(!s.length)return st(k,"先勾选");if(!confirm("删除 "+s.length+" 个会话？"))return;st(k,"删除中…");const m=await cmd(k,"deleteChats",{ids:s.map(c=>c.id)});const d=m.data||{};st(k,d.error?"✗ "+d.error:"删除：成功 "+d.deleted+"，失败 "+d.failed,d.failed||d.error?"bad":"ok");col.querySelector('[data-a="list"]').click();return}
 if(a==="openChat"){const s=sel()[0];if(!s)return st(k,"先勾选一个");st(k,"打开中…");const m=await cmd(k,"openChat",{chatId:s.id});st(k,m.ok?"已打开："+s.title:"✗ "+(m.data||{}).error,m.ok?"ok":"bad");return}
 st(k,a+"…");const m=await cmd(k,a);st(k,m.ok?"✓ "+a+((m.data||{}).how?"（"+m.data.how+"）":""):"✗ "+((m.data||{}).error||""),m.ok?"ok":"bad")}));
$("rgo").onclick=async()=>{let a={};try{a=JSON.parse($("ra").value||"{}")}catch{return alert("参数要是 JSON")}const m=await cmd($("rs").value,$("rc").value.trim(),a);log(JSON.stringify(m,null,1))};
</script></body></html>`;
