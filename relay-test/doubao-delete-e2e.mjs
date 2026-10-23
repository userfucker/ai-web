// 豆包删除会话：模拟豆包页面（左边会话列表、悬停出现 归档 / … 两个图标、… 菜单、确认框），插件列出会话、删除两个。
// 运行：node relay-test/doubao-delete-e2e.mjs
import { chromium } from '/opt/node-tools/node_modules/playwright/index.mjs';
import path from 'node:path';
const ext = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../extension');
const checks = [];
const check = (n, ok, info = '') => { checks.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${info ? '  ' + info : ''}`); };
const items = [['主对话', ''], ['AI会议议题讨论', '1000000001'], ['MFC流氓软件清理工具问题分析', '1000000002'], ['提取可禁用任务计划及作用', '1000000003'], ['计划任务禁用咨询', '1000000004']];
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
.side{position:fixed;left:0;top:0;width:260px;height:100vh;overflow:auto} li{list-style:none;display:flex;gap:4px;padding:6px} li .ops{visibility:hidden} li:hover .ops,li.hov .ops{visibility:visible}
.menu{position:fixed;left:270px;top:60px;background:#fff;border:1px solid #ccc} .dlg{position:fixed;left:300px;top:200px;background:#fff;border:1px solid #ccc;padding:10px}</style></head><body>
<div class="side"><ul id="list">${items.map(([t, id]) => `<li data-id="${id}"><a href="/chat/${id}">${t}</a>${id ? '<span class="ops"><button aria-label="归档对话" class="arch">▣</button><button class="more">⋯</button></span>' : ''}</li>`).join('')}</ul></div>
<div data-testid="chat_input_input"><div class="tiptap ProseMirror" contenteditable="true"></div></div>
<script>
let target = null;
document.addEventListener('mouseover', (e) => { const li = e.target.closest('li'); document.querySelectorAll('li').forEach((x) => x.classList.toggle('hov', x === li)); });
document.addEventListener('click', (e) => {
  if (e.target.closest('.arch')) { window.__archived = (window.__archived || 0) + 1; return; }
  if (e.target.closest('.more')) { target = e.target.closest('li'); document.querySelectorAll('.menu').forEach((m) => m.remove());
    const m = document.createElement('div'); m.className = 'menu'; m.setAttribute('role', 'menu');
    m.innerHTML = ['置顶','重命名','在新对话中继续','移动到项目','复制','归档对话'].map((x) => '<div role="menuitem">' + x + '</div>').join('') + '<div role="menuitem" class="del"><span>删除</span><span>Ctrl+D</span></div>';
    document.body.appendChild(m); return; }
  if (e.target.closest('.menu .del')) { document.querySelector('.menu').remove(); const d = document.createElement('div'); d.className = 'dlg';
    d.innerHTML = '<b>确定删除对话？</b><p>删除后，聊天记录将不可恢复。</p><button class="no">取消</button><button class="yes">删除</button>'; document.body.appendChild(d); return; }
  if (e.target.closest('.dlg .yes')) { document.querySelector('.dlg').remove(); setTimeout(() => target && target.remove(), 200); return; }
  if (e.target.closest('.dlg .no')) document.querySelector('.dlg').remove();
});
</script></body></html>`;
const ctx = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--host-resolver-rules=MAP www.doubao.com ~NOTFOUND'] });
await ctx.route('https://www.doubao.com/**', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
const page = await ctx.newPage();
await page.goto('https://www.doubao.com/chat/');
await page.waitForTimeout(2500);
const cmd = (c, extra = {}) => sw.evaluate(async ([c, extra]) => { const t = (await chrome.tabs.query({ url: 'https://www.doubao.com/*' }))[0]; return chrome.tabs.sendMessage(t.id, { type: 'aib-cmd', cmd: c, ...extra }); }, [c, extra]);
const l = await cmd('listChats', { max: 50 });
check('列出会话：4 个，“主对话”不算', l && l.ok && l.count === 4 && !l.list.some((x) => x.title === '主对话'), JSON.stringify(l && (l.list || l.error)));
const d = await cmd('deleteChats', { ids: ['1000000002', '1000000004'] });
check('删除两个：都成功', d && d.ok && d.deleted === 2, JSON.stringify(d));
const left = await page.$$eval('#list li a', (as) => as.map((a) => a.textContent));
check('列表里只剩 主对话 + 2 个', left.length === 3 && !left.includes('MFC流氓软件清理工具问题分析') && !left.includes('计划任务禁用咨询'), JSON.stringify(left));
check('没有点到“归档”', !(await page.evaluate(() => window.__archived)));
await ctx.close();
const bad = checks.filter((x) => !x).length;
console.log(`\n${checks.length - bad}/${checks.length} 通过`);
process.exit(bad ? 1 : 0);
