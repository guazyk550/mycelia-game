#!/usr/bin/env node
/**
 * 真实播放截图：用 CDP 驱动浏览器，走真实交互后再截图（而不是只看静态首屏）。
 *
 * 用法：node scripts/ui-shots.mjs <baseUrl> [outDir]
 * 产出：docs/shots/02-play/*.png
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const PORT = 9334;
const BASE = process.argv[2] ?? 'http://127.0.0.1:4175/';
const OUT = process.argv[3] ?? 'docs/shots/02-play';

async function waitForJson(url, timeoutMs = 20000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch {
      /* retry */
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时: ${url}`);
    await delay(300);
  }
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`页面异常: ${r.exceptionDetails.text}`);
    return r.result?.value;
  }
  async shot(file, width, height) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await delay(400);
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(file, Buffer.from(data, 'base64'));
    console.log(`  已写入 ${file}`);
  }
}

async function main() {
  const edge = EDGE_CANDIDATES.find((p) => existsSync(p));
  if (!edge) throw new Error('找不到 Edge');
  mkdirSync(OUT, { recursive: true });

  const proc = spawn(edge, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-http-cache',
    `--remote-debugging-port=${PORT}`, '--window-size=1920,1080', 'about:blank',
  ], { stdio: 'ignore' });

  try {
    await waitForJson(`http://127.0.0.1:${PORT}/json/version`);
    const targets = await waitForJson(`http://127.0.0.1:${PORT}/json/list`);
    const page = targets.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    const cdp = new CDP(ws);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    const goto = async (url) => {
      await cdp.send('Page.navigate', { url });
      for (let i = 0; i < 80; i++) {
        const ok = await cdp.eval('!!(window.mycelia && window.mycelia.getDebugInfo)');
        if (ok) return;
        await delay(200);
      }
      throw new Error('应用未就绪');
    };

    console.log('1) 首屏（新游戏，30 秒进度）');
    await goto(`${BASE}?ticks=300&fresh`);
    await cdp.shot(join(OUT, 'play-01-first-run.png'), 1920, 1080);

    console.log('2) 中期局面（机器人自动玩 1 小时）');
    await goto(`${BASE}?demo=3600&fresh`);
    await cdp.shot(join(OUT, 'play-02-midgame.png'), 1920, 1080);

    console.log('3) 离线报告（真实 settleOffline 路径，离线 8 小时）');
    await goto(`${BASE}?demo=1200&fresh`);
    await cdp.eval('window.mycelia.debugSimulateOffline(8 * 3600)');
    await delay(600);
    await cdp.shot(join(OUT, 'play-03-offline-report.png'), 1920, 1080);

    console.log('4) 设置面板（存档管理）');
    await cdp.eval(`[...document.querySelectorAll('nav button')].find(b => b.textContent === '设置').click()`);
    await delay(400);
    await cdp.shot(join(OUT, 'play-04-settings.png'), 1920, 1080);

    console.log('5) 窄屏 1280×720');
    await goto(`${BASE}?demo=1800`);
    await cdp.shot(join(OUT, 'play-05-1280x720.png'), 1280, 720);

    ws.close();
  } finally {
    proc.kill();
  }
  console.log('完成');
}

main().catch((e) => {
  console.error('截图失败:', e.message);
  process.exit(1);
});
