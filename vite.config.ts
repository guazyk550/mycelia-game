import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  base: './',
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    port: 5173,
    open: false,
    host: '127.0.0.1',
  },
  // 数据表作为 JSON 资源导入（浏览器侧由 src/data/browser-source.ts 统一加载）
  json: {
    stringify: false,
  },
});
