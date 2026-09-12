/**
 * 手机端两个已修 bug 的回归检查：
 *   ① 「建造」「强化」抽屉能真的打开（曾被 main > aside 的 !important 压掉）；
 *   ② 引导卡能收起并保持（手机上展开时占 276px，收起后只留一行）。
 *
 * 用法：node scripts/mobile-fix-check.mjs http://127.0.0.1:4175/
 */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9490;
const proc = spawn(EDGE, ['--headless=new','--disable-gpu','--no-sandbox',`--remote-debugging-port=${PORT}`,'about:blank'], { stdio: 'ignore' });
const waitJson = async (u) => { for (let i=0;i<60;i++){ try{const r=await fetch(u); if(r.ok) return await r.json();}catch{} await delay(250);} throw new Error('t'); };
try {
  await waitJson(`http://127.0.0.1:${PORT}/json/version`);
  const list = await waitJson(`http://127.0.0.1:${PORT}/json/list`);
  const ws = new WebSocket(list.find(t=>t.type==='page').webSocketDebuggerUrl);
  await new Promise(r=>ws.addEventListener('open',r,{once:true}));
  let id=0; const pending=new Map();
  ws.addEventListener('message',(e)=>{const m=JSON.parse(e.data); if(m.id&&pending.has(m.id)){const{res}=pending.get(m.id);pending.delete(m.id);res(m.result);}});
  const send=(method,params={})=>{const i=++id;return new Promise(res=>{pending.set(i,{res});ws.send(JSON.stringify({id:i,method,params}));});};
  const ev=async(x)=>(await send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true})).result?.value;
  const check=(n,ok,extra='')=>console.log(`${ok?'✔':'✖'} ${n}${extra?` — ${extra}`:''}`);
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:3,mobile:true});
  await send('Page.navigate',{url:process.argv[2]+'/?fresh'});
  for(let i=0;i<90;i++){ if(await ev('!!(window.mycelia&&window.mycelia.getDebugInfo)')) break; await delay(150); }
  await delay(800);
  // 关掉开场层
  await ev(`(() => { const b = [...document.querySelectorAll('[data-intro] button')].find(x => /^开始生长$/.test(x.textContent)); if (b) b.click(); return true; })()`);
  await delay(500);

  // ---- Bug 2：建造 / 强化 抽屉
  for (const [label, drawer] of [['建造','build'], ['强化','inspector']]) {
    await ev(`document.body.dataset.drawer && delete document.body.dataset.drawer`);
    await delay(200);
    await ev(`[...document.querySelectorAll('nav button')].find(b => b.textContent === '${label}').click()`);
    await delay(500);
    const st = await ev(`
      (() => {
        const b = document.body.dataset.drawer;
        const asides = [...document.querySelectorAll('main > aside')];
        const visible = asides.filter(a => getComputedStyle(a).display !== 'none');
        const r = visible[0] ? visible[0].getBoundingClientRect() : null;
        return JSON.stringify({ drawer: b ?? null, visibleCount: visible.length, rect: r ? [Math.round(r.width), Math.round(r.height)] : null });
      })()
    `);
    const o = JSON.parse(st);
    check(`点「${label}」抽屉真的打开`, o.drawer === drawer && o.visibleCount === 1 && o.r === undefined && o.rect && o.rect[0] > 300, st);
  }

  // ---- Bug 1：引导卡收起
  await ev(`document.body.dataset.drawer && delete document.body.dataset.drawer`);
  await delay(300);
  const before = await ev(`
    (() => { const c = document.querySelector('.tutorial-card'); if (!c) return null; const r = c.getBoundingClientRect(); return JSON.stringify({ h: Math.round(r.height), text: c.textContent.slice(0,40) }); })()
  `);
  const clicked = await ev(`(() => { const b = [...document.querySelectorAll('.tutorial-card button')].find(x => x.textContent === '收起'); if (!b) return false; b.click(); return true; })()`);
  await delay(400);
  const after = await ev(`
    (() => { const c = document.querySelector('.tutorial-card'); if (!c) return null; const r = c.getBoundingClientRect(); const btn = [...c.querySelectorAll('button')].find(x => x.textContent === '展开'); return JSON.stringify({ h: Math.round(r.height), hasExpandBtn: !!btn }); })()
  `);
  if (!before) { console.log('  （引导卡未出现，跳过收起检查）'); } else check('引导卡有「收起」按钮且可点', clicked === true, before ? `收起前高度 ${JSON.parse(before).h}px` : '');
  const a = after ? JSON.parse(after) : { h: 0, hasExpandBtn: false };
  const b4 = before ? JSON.parse(before).h : 0;
  check('收起后高度显著变小', a.h < b4 && a.hasExpandBtn === true, `${b4}px → ${a.h}px`);

  // 刷新后保持收起
  await send('Page.navigate',{url:process.argv[2]+'/?fresh'});
  for(let i=0;i<90;i++){ if(await ev('!!(window.mycelia&&window.mycelia.getDebugInfo)')) break; await delay(150); }
  await delay(700);
  const persisted = await ev(`
    (() => { const c = document.querySelector('.tutorial-card'); if (!c) return '(卡不在)'; const btn = [...c.querySelectorAll('button')].find(x => x.textContent === '展开'); return btn ? '收起状态已保持' : '又展开了'; })()
  `);
  check('收起状态在重开后保持', persisted === '收起状态已保持', persisted);
  ws.close();
} finally { proc.kill(); }
