// ai-web 1.3.0：设置页保存两个服务器（口令明文），在工具栏弹出窗口里切换。
// 用两个 AI图图 工作台当中转站（协议一样）。运行：node relay-test/servers-e2e.mjs <ai-tutu/web 目录>
import { chromium } from '/opt/node-tools/node_modules/playwright/index.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ext = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../extension');
const web = process.argv[2] || '/home/user/ai-tutu/web';
const checks = [];
const check = (n, ok, info = '') => { checks.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${info ? '  ' + info : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function server(port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiweb-srv-'));
  const p = spawn(process.execPath, ['server/index.js'], { cwd: web, env: { ...process.env, PORT: String(port), DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  for (let i = 0; i < 150 && !/插件口令 (\w+)/.test(out); i++) await sleep(100);
  const r = await fetch(`http://127.0.0.1:${port}/api/auth/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"password":"1234"}' });
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const workers = async () => (await (await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { cookie } })).json()).workers;
  return { p, token: /插件口令 (\w+)/.exec(out)[1], workers };
}
const A = 18300 + Math.floor(Math.random() * 40), B = A + 50;
const meet = await server(A), wb = await server(B);

const ctx = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
const id = sw.url().split('/')[2];
// 老版本的设置（只有一组）：打开设置页时变成第一个服务器
await sw.evaluate(([port, tok]) => chrome.storage.local.set({ relayHost: '127.0.0.1', relayPort: port, token: tok, clientName: '测试电脑' }), [A, meet.token]);
const opt = await ctx.newPage();
await opt.goto(`chrome-extension://${id}/options.html`);
await opt.waitForTimeout(500);
check('老设置自动存成第一个服务器', (await opt.locator('#srv option').count()) === 2 && /AI 会议/.test(await opt.locator('#srv option').first().textContent()));
check('口令明文显示', (await opt.locator('#token').getAttribute('type')) === 'text' && (await opt.inputValue('#token')) === meet.token);
// 加第二个：工作台
await opt.selectOption('#srv', '');
await opt.fill('#sname', 'AI图图 工作台');
await opt.fill('#host', '127.0.0.1');
await opt.fill('#port', String(B));
await opt.fill('#token', wb.token);
await opt.click('#save');
await opt.waitForTimeout(2500);
check('存了两个服务器', (await opt.locator('#srv option').count()) === 3 && /工作台/.test(await opt.locator('#srv option').nth(1).textContent()));
let ws = [];
for (let i = 0; i < 30; i++) { ws = await wb.workers(); if (ws.length) break; await sleep(300); }
check('连上了工作台', ws.length === 1, JSON.stringify(ws.map((w) => w.name)));
// 弹出窗口里切回 AI 会议
const pop = await ctx.newPage();
await pop.goto(`chrome-extension://${id}/popup.html`);
await pop.waitForTimeout(500);
check('弹出窗口里有服务器下拉框', await pop.locator('#srvrow').isVisible());
const first = await pop.locator('#srv option').first().getAttribute('value');
await pop.selectOption('#srv', first);
let wm = [];
for (let i = 0; i < 30; i++) { wm = await meet.workers(); if (wm.length) break; await sleep(300); }
await sleep(800);
check('切换到 AI 会议：连上会议、离开工作台', wm.length === 1 && (await wb.workers()).length === 0);
const st = await sw.evaluate(() => chrome.storage.local.get(['relayPort', 'token']));
check('当前设置换成了会议的端口和口令', st.relayPort === A && st.token === meet.token, JSON.stringify(st));
await ctx.close();
meet.p.kill(); wb.p.kill();
const bad = checks.filter((x) => !x).length;
console.log(`\n${checks.length - bad}/${checks.length} 通过`);
process.exit(bad ? 1 : 0);
