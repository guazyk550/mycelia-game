/**
 * 移动端可见性审计：在多种屏幕尺寸下打开每一个面板，检查是否有元素超出视口。
 *
 * 起因：真机反馈"很多菜单按钮我点不到，因为它超出了屏幕"。
 * 我们不能只测一种尺寸 —— 手机上从 320×568 到 430×932 差异很大，
 * 而且系统的字体放大（Android 的 textZoom）会让文字变大而容器不变。
 *
 * 用法：node scripts/mobile-audit.mjs http://127.0.0.1:4175/
 */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const EDGE = process.env.EDGE_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9480;
const BASE = process.argv[2] ?? 'http://127.0.0.1:4175/';

const SIZES = [
  { name: '320×568 超小屏', w: 320, h: 568, dpr: 2 },
  { name: '360×640 小屏安卓', w: 360, h: 640, dpr: 3 },
  { name: '390×844 主流', w: 390, h: 844, dpr: 3 },
  { name: '430×932 大屏', w: 430, h: 932, dpr: 3 },
];

const PANELS = ['合成', '自动化', '菌市', '进度', '孢子', '挑战', '法则', '时间', '设置'];

const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-sandbox', '--disable-http-cache', `--remote-debugging-port=${PORT}`, 'about:blank'], { stdio: 'ignore' });
const waitJson = async (u) => { for (let i = 0; i < 60; i++) { try { const r = await fetch(u); if (r.ok) return await r.json(); } catch {} await delay(250); } throw new Error('devtools 未就绪'); };

try {
  await waitJson(`http://127.0.0.1:${PORT}/json/version`);
  const list = await waitJson(`http://127.0.0.1:${PORT}/json/list`);
  const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0; const pending = new Map();
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const { res } = pending.get(m.id); pending.delete(m.id); res(m.result); } });
  const send = (method, params = {}) => { const i = ++id; return new Promise((res) => { pending.set(i, { res }); ws.send(JSON.stringify({ id: i, method, params })); }); };
  const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.value;

  await send('Runtime.enable'); await send('Page.enable');

  /** 检查当前页面上"点不到的元素"：可见、有交互语义、但中心点在视口外 */
  const AUDIT = `
    (() => {
      const vw = window.innerWidth, vh = window.innerHeight;
      const bad = [];
      /** 元素是否在"可滚动"的祖先里 —— 在的话（横或纵）越界属于正常：滚动即可见 */
      const inScrollable = (el) => {
        let p = el.parentElement;
        while (p && p !== document.body) {
          const cs = getComputedStyle(p);
          const canScrollY = (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && p.scrollHeight > p.clientHeight;
          const canScrollX = (cs.overflowX === 'auto' || cs.overflowX === 'scroll') && p.scrollWidth > p.clientWidth;
          if (canScrollY || canScrollX) return true;
          p = p.parentElement;
        }
        return false;
      };
      for (const el of document.querySelectorAll('button, a, select, input, [data-node-type]')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.top > vh || r.bottom < 0) continue;
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const top = document.elementFromPoint(cx, cy);
        const reachable = top && (top === el || el.contains(top) || top.contains(el));
        const clipped = r.right > vw + 1 || r.left < -1;
        if (clipped && inScrollable(el)) continue;   // 可滚动容器内的越界是设计如此
        if (clipped || !reachable) {
          bad.push({
            text: (el.textContent || el.getAttribute('title') || el.tagName).trim().slice(0, 18),
            rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
            reason: clipped ? '横向超出屏幕' : '被其他元素盖住',
          });
        }
      }
      return JSON.stringify({
        vw, vh,
        docOverflowX: document.documentElement.scrollWidth > vw,
        bad: bad.slice(0, 12),
        badCount: bad.length,
      });
    })()
  `;

  let totalProblems = 0;
  for (const size of SIZES) {
    await send('Emulation.setDeviceMetricsOverride', { width: size.w, height: size.h, deviceScaleFactor: size.dpr, mobile: true });
    console.log(`\n━━ ${size.name} ━━`);
    for (const panel of PANELS) {
      await send('Page.navigate', { url: BASE + '?fresh' });
      for (let i = 0; i < 90; i++) { if (await ev('!!(window.mycelia && window.mycelia.getDebugInfo)')) break; await delay(150); }
      await delay(500);
      await ev(`document.querySelectorAll('[data-modal]').forEach(el => el.remove())`);
      // 引导卡是浮层，会盖住面板按钮；它不是本次审计的对象，先移开避免误报
      await ev(`document.querySelectorAll('.tutorial-card').forEach(el => el.remove())`);
      // 开场引导层是一次性的首次启动浮层，真机上玩家会先关掉它 —— 不属于面板问题
      await ev(`document.querySelectorAll('[data-intro]').forEach(el => el.remove())`);
      const clicked = await ev(`(() => { const b = [...document.querySelectorAll('nav button')].find(x => x.textContent.startsWith('${panel}')); if (!b) return false; b.click(); return true; })()`);
      if (!clicked) { console.log(`  ${panel.padEnd(6)} （没有这个入口）`); continue; }
      await delay(600);
      const r = JSON.parse(await ev(AUDIT));
      const flag = r.badCount === 0 && !r.docOverflowX ? '✔' : '✖';
      if (r.badCount > 0 || r.docOverflowX) totalProblems++;
      console.log(`  ${flag} ${panel.padEnd(6)} 点不到 ${r.badCount} 个${r.docOverflowX ? ' ｜ 页面横向溢出' : ''}`);
      for (const b of r.bad) console.log(`      · 「${b.text}」 ${b.reason} rect=[${b.rect.join(',')}]`);
    }
  }
  console.log(`\n合计有问题的面板：${totalProblems}`);
  ws.close();
} finally {
  proc.kill();
}
