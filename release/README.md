# 交付物 · 《共生之网》

## 这是什么

> 开源仓库出于体积考虑不包含 APK 本体，请从本仓库的 **Releases** 页面下载 `mycelia-debug.apk`；
> 想自己打包请见下方「重新构建 APK」。

| 项 | 值 |
|---|---|
| 应用名 | 共生之网（Mycelia） |
| 包名 | com.mycelia.game |
| 版本 | 0.1.0 |
| 类型 | debug 包（可直接安装试玩；上架需自行签名 release） |
| 大小 | 4.5 MB |
| APK 内条目 | 448 个（其中 web 资源 10 个：index.html / sw.js / manifest / 图标等） |

## 怎么装到手机

1. 把 `mycelia-debug.apk` 传到手机（数据线 / 微信文件传输助手 / 网盘均可）
2. 手机上点开安装包，系统提示"未知来源"时允许一次
3. 首次启动有 1–2 秒白屏（WebView 初始化），之后即游戏本体

> **建议先卸载旧版或清空存档**，避免旧存档带着旧 UI 状态。

## 手机上怎么操作

| 想做的事 | 手势 |
|---|---|
| 平移画布 | 单指拖动 |
| 缩放 | 双指捏合 |
| 建造 | 先在「建造」抽屉选节点，再轻点画布空白处 |
| **连线** | **先点源节点，再点目标节点** |
| 节点菜单（删除等） | 长按节点 500ms |
| 切换面板 | 底部导航：「网络」回画布，「建造」/「强化」开底部抽屉，其余打开全屏面板 |
| 收起引导卡 | 引导卡右上角「收起」，只留一行目标 |

> 触控下暂不支持拖拽移动节点（可用长按删除后重建）。详见 `docs/MOBILE.md`。

## 不装 APK 也能玩（PWA）

```bash
npm run build && npx vite preview --host 0.0.0.0 --port 4175
# 手机浏览器打开 http://<电脑IP>:4175/ →「添加到主屏幕」，离线可玩
```

## 重新构建 APK

前置：`ANDROID_HOME` 指向 Android SDK（需 platforms;android-36）、`JAVA_HOME` 指向 JDK。

```bash
npm run build:apk          # Windows
npm run build:apk:unix     # Git Bash / macOS
# 产物：android/app/build/outputs/apk/debug/app-debug.apk
```

详见 `docs/MOBILE.md`。
