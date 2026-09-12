/**
 * 入口：启动应用。
 */

import { App } from './ui/app.ts';

const root = document.getElementById('app');
if (!root) throw new Error('缺少 #app 容器');

document.getElementById('boot')?.remove();

// 暴露到 window 便于在浏览器控制台里调试（只在开发时使用）
const app = new App(root);
(window as unknown as { mycelia?: App }).mycelia = app;

// PWA：注册 Service Worker（离线可玩；WebView 环境里 navigator.serviceWorker 可能不存在，静默跳过）
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      /* 注册失败不影响游戏本体 */
    });
  });
}
