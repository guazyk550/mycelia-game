/**
 * 手机尺寸截图：竖屏画布 / 建造抽屉 / 横屏三栏。
 * 用法：node scripts/mobile-shots.mjs http://127.0.0.1:4175/ [输出目录]
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const EDGE = process.env.EDGE_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9470;
const BASE = process.argv[2] ?? 'http://127.0.0.1:4175/';
const OUT = process.argv[3] ?? 'docs/shots/05-mobile';

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
  const shot = async (name) => { await delay(500); const { data } = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(OUT, name), Buffer.from(data, 'base64')); console.log('  已写入', name); };

  mkdirSync(OUT, { recursive: true });
  await send('Runtime.enable'); await send('Page.enable');

  const cases = [
    { name: 'phone-portrait.png', w: 390, h: 844, dpr: 3, mobile: true, drawer: null },
    { name: 'phone-portrait-build.png', w: 390, h: 844, dpr: 3, mobile: true, drawer: 'build' },
    { name: 'phone-landscape.png', w: 844, h: 390, dpr: 3, mobile: true, drawer: null },
  ];

  for (const c of cases) {
    await send('Emulation.setDeviceMetricsOverride', { width: c.w, height: c.h, deviceScaleFactor: c.dpr, mobile: c.mobile });
    await send('Page.navigate', { url: BASE + '?demo=900&fresh' });
    for (let i = 0; i < 120; i++) { if (await ev('!!(window.mycelia && window.mycelia.getDebugInfo)')) break; await delay(200); }
    await delay(1200);
    await ev(`document.querySelectorAll('[data-modal]').forEach(el => el.remove())`);
    if (c.drawer) {
      await ev(`[...document.querySelectorAll('nav button')].find(b => b.textContent === '${c.drawer === 'build' ? '建造' : '强化'}').click()`);
      await delay(500);
    }
    await shot(c.name);
  }
  ws.close();
} finally {
  proc.kill();
}
