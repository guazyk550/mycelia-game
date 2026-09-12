#!/usr/bin/env node
/**
 * 端到端 UI 烟测（CDP + 真实鼠标事件）
 *
 * 为什么需要它：单元测试覆盖的是 core 层逻辑，无头 `--dump-dom` 只能看静态 DOM。
 * 而"点击建造按钮 → 在画布上点击 → 节点真的被建出来"这条链路只有真实事件才能验证。
 *
 * 做法：启动 Edge（headless + remote debugging）→ 用 Node 内置 WebSocket 连 CDP →
 * 派发 Input.dispatchMouseEvent（真实鼠标路径）→ 用 Runtime.evaluate 读回状态。
 *
 * 用法：node scripts/ui-smoke.mjs <baseUrl>
 */

import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const PORT = 9333;
const BASE = process.argv[2] ?? 'http://127.0.0.1:4175/';

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};

async function waitFor(url, timeoutMs = 20000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch {
      /* 还没起来 */
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
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
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
    if (r.exceptionDetails) throw new Error(`页面异常: ${r.exceptionDetails.text} ${r.result?.description ?? ''}`);
    return r.result?.value;
  }
  async click(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await delay(30);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await delay(60);
  }
  async drag(from, to, modifiers = 0) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none', clickCount: 0, modifiers });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1, modifiers });
    await delay(30);
    const steps = 6;
    for (let i = 1; i <= steps; i++) {
      await this.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: from.x + ((to.x - from.x) * i) / steps,
        y: from.y + ((to.y - from.y) * i) / steps,
        button: 'left',
        clickCount: 1,
        modifiers,
      });
      await delay(16);
    }
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1, modifiers });
    await delay(80);
  }
}

async function main() {
  const { existsSync } = await import('node:fs');
  const edge = EDGE_CANDIDATES.find((p) => existsSync(p));
  if (!edge) throw new Error('找不到 Edge 可执行文件');
  console.log(`浏览器: ${edge}`);
  console.log(`目标: ${BASE}\n`);

  const proc = spawn(edge, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-http-cache',
    `--remote-debugging-port=${PORT}`,
    '--window-size=1600,900',
    'about:blank',
  ], { stdio: 'ignore' });

  try {
    await waitFor(`http://127.0.0.1:${PORT}/json/version`);
    const targets = await waitFor(`http://127.0.0.1:${PORT}/json/list`);
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('没有可用的 page target');

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    const cdp = new CDP(ws);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    // headless 浏览器默认 prefers-reduced-motion: reduce，会把按钮过渡与脉冲动画降级为 none。
    // 那是**正确的无障碍行为**，但会让"动画是否存在"的检查永远失败 —— 所以这里显式声明
    // 我们想要一个"不降低动效"的偏好，让检查验证的是真实玩家会看到的那一套样式。
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
    });

    // ---- 1. 加载页面并等待应用就绪
    await cdp.send('Page.navigate', { url: BASE });
    for (let i = 0; i < 60; i++) {
      const ready = await cdp.eval('!!(window.mycelia && window.mycelia.getDebugInfo)');
      if (ready) break;
      await delay(200);
    }
    const ready = await cdp.eval('!!(window.mycelia && window.mycelia.getDebugInfo)');
    check('页面加载并挂载应用', ready === true);

    // ---- 开场引导层（反馈 #3）：首次进入应可见，且提供出口
    await delay(400);
    const introVisible = await cdp.eval(
      `document.body.textContent.includes('你是一颗孢子')`,
    );
    check('首次进入显示开场引导层', introVisible === true, String(introVisible));
    const introClosed = await cdp.eval(`
      (() => {
        const btn = [...document.querySelectorAll('button')].find(b => b.textContent === '开始生长');
        if (!btn) return 'no-button';
        btn.click();
        return 'clicked';
      })()
    `);
    check('开场引导层可以关闭（有明确出口）', introClosed === 'clicked', String(introClosed));
    await delay(300);

    const t0 = await cdp.eval('JSON.stringify(window.mycelia.getDebugInfo())').then(JSON.parse);
    check('初始有 1 个免费分解丝', t0.nodeCount === 1, `nodeCount=${t0.nodeCount}`);
    check('建造面板暴露了可建造按钮', t0.buildButtons.length > 0, `${t0.buildButtons.length} 个按钮`);

    // ---- 2. 点击建造面板里的「吸水菌丝 I」
    const hydraBtn = t0.buildButtons.find((b) => b.typeId === 'hydra_i');
    check('建造列表包含 hydra_i', Boolean(hydraBtn));
    if (hydraBtn) {
      await cdp.click(hydraBtn.sx, hydraBtn.sy);
      // ---- 3. 在画布空白处点击放置
      const cx = t0.canvasRect.left + t0.canvasRect.width * 0.35;
      const cy = t0.canvasRect.top + t0.canvasRect.height * 0.45;
      // 先移动鼠标：建造模式应立刻显示落点预览（反馈 #6）
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy, button: 'none', clickCount: 0 });
      await delay(120);
      const preview = await cdp.eval('JSON.stringify(window.mycelia.getDebugInfo())').then(JSON.parse);
      check(
        '建造模式下显示落点预览',
        preview.buildPreviewActive === true && preview.buildPreviewTarget !== null,
        `active=${preview.buildPreviewActive} target=${JSON.stringify(preview.buildPreviewTarget)}`,
      );

      await cdp.click(cx, cy);
      const t1 = await cdp.eval('JSON.stringify(window.mycelia.getDebugInfo())').then(JSON.parse);
      check('点击画布后新节点被建造', t1.nodeCount === t0.nodeCount + 1, `${t0.nodeCount} → ${t1.nodeCount}`);
    }

    // ---- 4. 拖拽移动节点（反馈 #5：默认拖拽 = 移动）
    const t2 = await cdp.eval('JSON.stringify(window.mycelia.getDebugInfo())').then(JSON.parse);
    if (t2.nodes.length >= 2) {
      const moving = t2.nodes[t2.nodes.length - 1];
      const before = { x: moving.x, y: moving.y };
      const dx = t2.canvasRect.width * 0.18;
      const dy = t2.canvasRect.height * 0.12;
      await cdp.drag({ x: moving.sx, y: moving.sy }, { x: moving.sx + dx, y: moving.sy + dy });
      const t2b = await cdp.eval('JSON.stringify(window.mycelia.getDebugInfo())').then(JSON.parse);
      const after = t2b.nodes.find((n) => n.id === moving.id);
      check(
        '拖拽移动节点改变了它的坐标',
        after && (after.x !== before.x || after.y !== before.y),
        `${before.x},${before.y} → ${after?.x},${after?.y}`,
      );
      check(
        '移动后坐标仍在网格上（吸附）',
        after && Math.abs(after.x % 46) === 0 && Math.abs(after.y % 46) === 0,
        `x=${after?.x} y=${after?.y}`,
      );
    } else {
      check('拖拽移动节点改变了它的坐标', false, '节点不足');
    }

    // ---- 5. Shift+拖拽建立连线
    const t3 = await cdp.eval('JSON.stringify(window.mycelia.getDebugInfo())').then(JSON.parse);
    if (t3.nodes.length >= 2) {
      const a = t3.nodes[0];
      const b = t3.nodes[t3.nodes.length - 1];
      await cdp.drag({ x: a.sx, y: a.sy }, { x: b.sx, y: b.sy }, 8 /* Shift */);
      const t4 = await cdp.eval('JSON.stringify(window.mycelia.getDebugInfo())').then(JSON.parse);
      check('Shift+拖拽后建立连线', t4.linkCount === t3.linkCount + 1, `${t3.linkCount} → ${t4.linkCount}`);
    } else {
      check('Shift+拖拽后建立连线', false, '节点不足');
    }

    // ---- 5. 时间推进（tick 循环真的在跑）
    const tickBefore = await cdp.eval('window.mycelia.getDebugInfo().tick');
    await delay(1200);
    const tickAfter = await cdp.eval('window.mycelia.getDebugInfo().tick');
    check('主循环在推进 tick', tickAfter > tickBefore, `${tickBefore} → ${tickAfter}`);

    // ---- 6. 顶部资源条有输出（数据 → DOM 的最后一公里）
    const headerText = await cdp.eval(
      '[...document.querySelectorAll("header span")].map(s => s.textContent).join("|")',
    );
    check('顶部资源条有数值输出', typeof headerText === 'string' && headerText.trim().length > 0, String(headerText).slice(0, 70));

    // ---- 7. 存档往返：保存 → 重新加载 → 网络规模保持
    const beforeSave = await cdp.eval('JSON.stringify(window.mycelia.getDebugInfo())').then(JSON.parse);
    await cdp.eval('window.mycelia.saveNow()');
    const savedBytes = await cdp.eval('(localStorage.getItem("mycelia.save.auto") || "").length');
    check('存档写入 localStorage', savedBytes > 100, `${savedBytes} 字节`);

    await cdp.send('Page.navigate', { url: BASE });
    for (let i = 0; i < 60; i++) {
      const ok = await cdp.eval('!!(window.mycelia && window.mycelia.getDebugInfo)');
      if (ok) break;
      await delay(200);
    }
    const afterLoad = await cdp.eval('JSON.stringify(window.mycelia.getDebugInfo())').then(JSON.parse);
    check(
      '重新加载后状态从存档恢复',
      afterLoad.nodeCount === beforeSave.nodeCount && afterLoad.linkCount === beforeSave.linkCount,
      `节点 ${beforeSave.nodeCount} → ${afterLoad.nodeCount}，连线 ${beforeSave.linkCount} → ${afterLoad.linkCount}`,
    );

    // ---- 8. 篡改存档会被识别（不静默覆盖）
    // 注意：不能靠"篡改后 reload"验证 —— reload 前的 beforeunload 自动保存会覆盖篡改内容。
    await cdp.eval(`
      (() => {
        const raw = JSON.parse(localStorage.getItem('mycelia.save.auto'));
        raw.state.resources.spore = '999999999';
        localStorage.setItem('mycelia.save.auto', JSON.stringify(raw));
        return true;
      })()
    `);
    const tamperResult = await cdp.eval('JSON.stringify(window.mycelia.debugInspectSave())').then(JSON.parse);
    check(
      '篡改存档被识别为 tampered 且不返回状态',
      tamperResult.tampered === true && tamperResult.ok === false,
      JSON.stringify(tamperResult),
    );

    // ---- 12. 右键：不误建造 + 菜单能点（用真实鼠标事件，Bug 1/Bug 2 的回归检查）
    const t5 = await cdp.eval('JSON.stringify(window.mycelia.getDebugInfo())').then(JSON.parse);
    if (t5.nodes.length >= 1) {
      const victim = t5.nodes[t5.nodes.length - 1];

      // (a) 真实右键按在节点上：不应产生任何新节点（Bug 1 回归）
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: victim.sx, y: victim.sy, button: 'none', clickCount: 0 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: victim.sx, y: victim.sy, button: 'right', clickCount: 1 });
      await delay(60);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: victim.sx, y: victim.sy, button: 'right', clickCount: 1 });
      await delay(250);
      const afterRightDown = await cdp.eval('JSON.stringify(window.mycelia.getDebugInfo())').then(JSON.parse);
      check('真实右键不会误建造节点', afterRightDown.nodeCount === t5.nodeCount, `${t5.nodeCount} → ${afterRightDown.nodeCount}`);

      // (b) 打开菜单（headless 下 CDP 原生右键不派发 contextmenu，故直接派发同名事件）
      await cdp.eval(`
        (() => {
          const canvas = document.querySelector('canvas');
          canvas.dispatchEvent(new MouseEvent('contextmenu', {
            clientX: ${Math.round(victim.sx)}, clientY: ${Math.round(victim.sy)},
            bubbles: true, cancelable: true, button: 2,
          }));
          return true;
        })()
      `);
      await delay(300);
      const menuOpen = await cdp.eval('!!document.querySelector("[data-ctx-menu]")');
      check('右键节点弹出上下文菜单', menuOpen === true, String(menuOpen));
      if (menuOpen) {
        // (c) **真实鼠标**点击菜单项 —— Bug 2 的关键路径（pointerdown → pointerup → click）
        const itemRect = await cdp.eval(`
          (() => {
            const b = document.querySelector('[data-ctx-menu] button');
            if (!b) return null;
            const r = b.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          })()
        `);
        check('菜单项可被定位', itemRect !== null);
        if (itemRect) {
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: itemRect.x, y: itemRect.y, button: 'none', clickCount: 0 });
          await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: itemRect.x, y: itemRect.y, button: 'left', clickCount: 1 });
          await delay(50);
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: itemRect.x, y: itemRect.y, button: 'left', clickCount: 1 });
          await delay(350);
          const t6 = await cdp.eval('JSON.stringify(window.mycelia.getDebugInfo())').then(JSON.parse);
          check('真实点击菜单项后节点被拆除', t6.nodeCount === afterRightDown.nodeCount - 1, `${afterRightDown.nodeCount} → ${t6.nodeCount}`);
          const menuClosed = await cdp.eval('!document.querySelector("[data-ctx-menu]")');
          check('点击菜单项后菜单自动关闭', menuClosed === true, String(menuClosed));
        }
      }
    }

    // ---- 13. 交互反馈（反馈 #2）：按钮具备过渡与按下反馈，点击购买会有脉冲
    const styleCheck = await cdp.eval(`
      (() => {
        const btn = [...document.querySelectorAll('nav button')].find(b => b.textContent === '网络') || document.querySelector('button');
        if (!btn) return { ok: false };
        const cs = getComputedStyle(btn);
        return {
          ok: true,
          transition: cs.transitionDuration,
          transitionProps: cs.transitionProperty,
          willChange: cs.willChange,
        };
      })()
    `);
    check(
      '按钮具备过渡动画（hover/active 反馈的基础）',
      styleCheck.ok === true && styleCheck.transition !== '0s' && styleCheck.transition !== '0s, 0s, 0s, 0s, 0s',
      `duration=${styleCheck.transition}`,
    );

    const pulseOk = await cdp.eval(`
      (() => {
        const btn = [...document.querySelectorAll('aside button')].find(b => b.textContent && b.textContent.length > 0);
        if (!btn) return 'no-button';
        btn.classList.add('pulse-ok');
        const has = btn.classList.contains('pulse-ok');
        const anim = getComputedStyle(btn).animationName;
        btn.classList.remove('pulse-ok');
        return has ? String(anim) : 'class-missing';
      })()
    `);
    check('购买脉冲动画可用', pulseOk.includes('mycelia-pulse') || pulseOk === 'class-missing', String(pulseOk));

    // ---- 14. 强化列表排版（反馈 #2：字太小太淡）
    const upgradeStyle = await cdp.eval(`
      (() => {
        // 右侧面板是第二个 <aside>；先切到"升级"页签
        const asides = document.querySelectorAll('aside');
        const right = asides[asides.length - 1];
        if (!right) return { ok: false };
        const tabs = [...right.querySelectorAll('button')].filter(b => b.textContent === '升级');
        if (tabs[0]) tabs[0].click();
        const first = [...right.querySelectorAll('button')].find(b => {
          const span = b.querySelector('span');
          return span && parseFloat(getComputedStyle(span).fontSize) >= 13;
        });
        if (!first) return { ok: false };
        const nameEl = first.querySelector('span');
        const costEl = first.querySelectorAll('span')[1];
        return {
          ok: true,
          nameSize: getComputedStyle(nameEl).fontSize,
          costSize: costEl ? getComputedStyle(costEl).fontSize : null,
        };
      })()
    `);
    check(
      '升级项名称字号已放大到 14px（反馈 #2）',
      upgradeStyle.ok === true && parseFloat(upgradeStyle.nameSize) >= 14,
      `nameSize=${upgradeStyle.nameSize} costSize=${upgradeStyle.costSize}`,
    );

    // ---- 15. 底部导航分组与未读徽章（反馈 #7）
    const navInfo = await cdp.eval(`
      (() => {
        const nav = document.querySelector('nav');
        if (!nav) return { ok: false };
        const labels = [...nav.querySelectorAll('button')].map(b => (b.textContent || '').replace(/\\d+$/, ''));
        const separators = [...nav.children].filter(c => c.tagName === 'SPAN' && c.style.width === '1px').length;
        const badges = [...nav.querySelectorAll('button span span')].length;
        return { ok: true, labels, separators, badges };
      })()
    `);
    check(
      '底部导航已分组（两组以上分隔线）',
      navInfo.ok === true && navInfo.separators >= 2,
      `separators=${navInfo.separators} labels=${(navInfo.labels || []).join('/')}`,
    );
    check(
      '导航项完整（网络/自动化/菌市/进度/孢子/设置）',
      navInfo.ok === true &&
        ['网络', '自动化', '菌市', '进度', '孢子', '设置'].every((x) => (navInfo.labels || []).includes(x)),
      (navInfo.labels || []).join('/'),
    );

    // ---- 17. 悬停建造项显示材料与产出（需求 1）
    // 先清掉可能存在的模态框（上面的存档往返会 reload 并弹出“欢迎回来”离线报告，它会拦住鼠标）
    await cdp.eval(`document.querySelectorAll('[data-modal]').forEach(el => el.remove())`);
    await cdp.eval(`document.querySelectorAll('aside')[0].scrollTop = 0`);
    await delay(250);
    const firstBuild = await cdp.eval(`
      (() => {
        // 选第一个**可见**的建造项（未解锁项是 display:none，rect 全为 0）
        for (const b of document.querySelectorAll('[data-node-type]')) {
          const r = b.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            return { id: b.dataset.nodeType, x: r.left + r.width / 2, y: r.top + r.height / 2 };
          }
        }
        return null;
      })()
    `);
    check('建造项可被定位', firstBuild !== null, firstBuild?.id ?? '');
    if (firstBuild) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: firstBuild.x, y: firstBuild.y, button: 'none', clickCount: 0 });
      await delay(450);
      const tipText = await cdp.eval(`
        (() => {
          const cards = [...document.querySelectorAll('div')].filter(d => d.style.position === 'fixed' && d.style.zIndex === '45');
          const t = cards.find(d => d.style.display !== 'none');
          return t ? t.textContent : null;
        })()
      `);
      check(
        '悬停建造项显示「所需材料 + 产出」',
        typeof tipText === 'string' && tipText.includes('建造所需') && tipText.includes('每秒产出'),
        tipText ? tipText.slice(0, 60) : '（未显示）',
      );
      if (!tipText) {
        // 诊断：列出所有 fixed 定位元素的定位信息，判断是"未显示"还是"选择器不匹配"
        const diag = await cdp.eval(`
          (() => {
            const cards = [...document.querySelectorAll('div')].filter(d => d.style.position === 'fixed');
            return cards.map(d => ({ z: d.style.zIndex, display: d.style.display || '(默认)', cls: d.className || '', text: (d.textContent || '').slice(0, 24) }));
          })()
        `);
        console.log('    [诊断] fixed 元素:', JSON.stringify(diag).slice(0, 400));
        const btnBox = await cdp.eval(`
          (() => {
            const b = document.querySelector('[data-node-type]');
            if (!b) return null;
            const r = b.getBoundingClientRect();
            return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), vh: window.innerHeight };
          })()
        `);
        console.log('    [诊断] 目标按钮位置:', JSON.stringify(btnBox));
      }
    }

    // ---- 18. 合成表可打开（需求 2）
    await cdp.eval(`[...document.querySelectorAll('nav button')].find(b => b.textContent.startsWith('合成')).click()`);
    await delay(500);
    const codexInfo = await cdp.eval(`
      (() => {
        const m = document.querySelector('[data-modal]');
        if (!m) return null;
        const rows = m.querySelectorAll('button').length;
        return { text: m.textContent.slice(0, 40), modals: document.querySelectorAll('[data-modal]').length, rows };
      })()
    `);
    check(
      '合成表可打开且列出资源',
      codexInfo && codexInfo.text.includes('合成表') && codexInfo.rows > 3 && codexInfo.modals === 1,
      codexInfo ? `rows=${codexInfo.rows} modals=${codexInfo.modals}` : '（未打开）',
    );
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await delay(250);

    // ---- 9. 自动化面板可打开（逻辑正确性由 tests/automation.test.ts 覆盖，这里只验 UI 通路）
    await cdp.eval(`[...document.querySelectorAll('nav button')].find(b => b.textContent === '自动化').click()`);
    await delay(400);
    const autoPanelOpen = await cdp.eval(
      'document.body.textContent.includes("六级自动化") || document.body.textContent.includes("当前层级")',
    );
    check('自动化面板可以打开', autoPanelOpen === true, String(autoPanelOpen));
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await delay(200);

    // ---- 16. 清档（Bug 3 回归）：清空后 reload 应回到新游戏且不被写回
    const beforeClear = await cdp.eval('(localStorage.getItem("mycelia.save.auto")||"").length');
    check('清档前存在存档', beforeClear > 100, `${beforeClear} 字节`);
    await cdp.eval(`[...document.querySelectorAll('nav button')].find(b => b.textContent === '设置').click()`);
    await delay(400);
    const clearClicked = await cdp.eval(`
      (() => {
        const btn = [...document.querySelectorAll('button')].find(b => b.textContent === '清空存档并重开');
        if (!btn) return false;
        btn.click();
        return true;
      })()
    `);
    check('设置面板里有清档按钮且可点击', clearClicked === true);
    await delay(1600); // 等 reload
    for (let i = 0; i < 60; i++) {
      if (await cdp.eval('!!(window.mycelia && window.mycelia.getDebugInfo)')) break;
      await delay(200);
    }
    await delay(400);
    const afterClearBytes = await cdp.eval('(localStorage.getItem("mycelia.save.auto")||"").length');
    const afterClear = await cdp.eval('JSON.stringify(window.mycelia.getDebugInfo())').then(JSON.parse);
    check('清档后存档被清空且未被 beforeunload 写回', afterClearBytes === 0, `${afterClearBytes} 字节`);
    check('清档后 reload 回到新游戏', afterClear.nodeCount === 1, `nodes=${afterClear.nodeCount}`);


    ws.close();
  } finally {
    proc.kill();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? '✓ 全部通过' : `✗ ${failed.length} 项失败`}（共 ${results.length} 项）`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('烟测失败:', e.message);
  process.exit(1);
});
