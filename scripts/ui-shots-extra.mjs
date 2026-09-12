#!/usr/bin/env node
/**
 * 补充截图：菌市 / 进度 / 自动化面板 + 后期局面。
 * 用法：node scripts/ui-shots-extra.mjs <baseUrl> <outDir>
 */

import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));
if (!EDGE) throw new Error('找不到 Edge');

const PORT = 9336;
const BASE = process.argv[2] ?? 'http://127.0.0.1:4175/';
const OUT = process.argv[3] ?? 'docs/shots/04-features';

async function waitJson(url) {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch {
      /* retry */
    }
    await delay(250);
  }
  throw new Error('timeout ' + url);
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result?.value;
  }
  async shot(file) {
    await delay(500);
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(file, Buffer.from(data, 'base64'));
    console.log('  已写入 ' + file);
  }
}

const proc = spawn(
  EDGE,
  ['--headless=new', '--disable-gpu', '--no-sandbox', '--disable-http-cache', `--remote-debugging-port=${PORT}`, '--window-size=1920,1080', 'about:blank'],
  { stdio: 'ignore' },
);

try {
  await waitJson(`http://127.0.0.1:${PORT}/json/version`);
  const list = await waitJson(`http://127.0.0.1:${PORT}/json/list`);
  const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', j, { once: true });
  });
  const cdp = new CDP(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });

  const goto = async (url) => {
    await cdp.send('Page.navigate', { url });
    for (let i = 0; i < 100; i++) {
      if (await cdp.eval('!!(window.mycelia && window.mycelia.getDebugInfo)')) return;
      await delay(200);
    }
    throw new Error('应用未就绪');
  };
  const closeModals = () => cdp.eval(`document.querySelectorAll('div[style*="inset: 0"]').forEach(e => e.remove())`);

  console.log('1) 菌市面板');
  await goto(`${BASE}?demo=5400&fresh`);
  await cdp.eval(`[...document.querySelectorAll('nav button')].find(b => b.textContent === '菌市').click()`);
  await cdp.shot(`${OUT}/play-06-market.png`);

  console.log('2) 进度面板（成就 / 任务 / 图鉴）');
  await closeModals();
  await cdp.eval(`[...document.querySelectorAll('nav button')].find(b => b.textContent === '进度').click()`);
  await cdp.shot(`${OUT}/play-07-progress.png`);

  console.log('3) 自动化面板');
  await closeModals();
  await cdp.eval(`[...document.querySelectorAll('nav button')].find(b => b.textContent === '自动化').click()`);
  await cdp.shot(`${OUT}/play-08-automation.png`);

  console.log('4) 后期局面（机器人代玩 6 小时）');
  await closeModals();
  await goto(`${BASE}?demo=21600&fresh`);
  await cdp.shot(`${OUT}/play-09-late.png`);

  ws.close();
} finally {
  proc.kill();
}
console.log('完成');
