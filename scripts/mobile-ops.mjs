/**
 * 手机可操作性验证（比静态审计可靠）。
 *
 * 起因：真机反馈"很多菜单按钮我点不到，因为它超出了屏幕"。
 * 静态审计（mobile-audit.mjs）会误报滚动容器内的元素，所以这里改用**真实操作**：
 * 打开每个面板 → 滚到底 → 检查最后一个按钮是否真的可点。
 * 手机上玩家本来就会滚动，这才是接近真实的判据。
 *
 * 用法：node scripts/mobile-ops.mjs http://127.0.0.1:4175/
 */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9489;
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

  for (const [device, w, h] of [['320×568', 320, 568], ['390×844', 390, 844]]) {
    console.log(`\n━━ ${device} ━━`);
    await send('Emulation.setDeviceMetricsOverride',{width:w,height:h,deviceScaleFactor:3,mobile:true});
    await send('Page.navigate',{url:process.argv[2]+'/?fresh'});
    for(let i=0;i<90;i++){ if(await ev('!!(window.mycelia&&window.mycelia.getDebugInfo)')) break; await delay(150); }
    await delay(700);
    await ev(`document.querySelectorAll('[data-intro], .tutorial-card').forEach(el=>el.remove())`);

    // ① 导航栏：滚动到最右，最后一个入口能点开
    const navOk = await ev(`
      (() => {
        const nav = document.querySelector('nav');
        nav.scrollLeft = nav.scrollWidth;
        const last = [...nav.querySelectorAll('button')].pop();
        const r = last.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2);
        return !!(top && (top === last || last.contains(top)));
      })()
    `);
    check('导航栏滚动后最后一个入口可点', navOk === true);

    // ② 每个面板：滚到底，最后一个可交互元素可点
    for (const panel of ['挑战', '法则', '孢子', '自动化', '设置']) {
      await ev(`document.querySelectorAll('[data-modal]').forEach(el=>el.remove())`);
      await ev(`[...document.querySelectorAll('nav button')].find(b=>b.textContent.startsWith('${panel}'))?.click()`);
      await delay(500);
      const res = await ev(`
        (() => {
          const ov = document.querySelector('[data-modal]');
          if (!ov) return JSON.stringify({ found: false });
          const panel = ov.firstElementChild;
          const scroller = [...panel.querySelectorAll('*')].find(el => el.scrollHeight > el.clientHeight + 4 && ['auto','scroll'].includes(getComputedStyle(el).overflowY));
          if (scroller) scroller.scrollTop = scroller.scrollHeight;   // 滚到底
          const btns = [...panel.querySelectorAll('button')].filter(b => b.offsetParent !== null);
          const last = btns[btns.length - 1];
          if (!last) return JSON.stringify({ found: true, last: '(无按钮)' });
          const r = last.getBoundingClientRect();
          const top = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2);
          const reachable = !!(top && (top === last || last.contains(top) || top.contains(last)));
          return JSON.stringify({ found: true, last: last.textContent.slice(0,10), reachable, inViewport: r.bottom <= window.innerHeight + 1 });
        })()
      `);
      const r = JSON.parse(res);
      check(`${panel} 面板滚到底后最后一个按钮可点`, r.found && r.reachable === true, `${r.last ?? ''} ${r.inViewport === false ? '(仍在视口外)' : ''}`);
    }
  }
  ws.close();
} finally { proc.kill(); }
