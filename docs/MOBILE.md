# 在手机上玩《共生之网》

有两条路，推荐都试一次：**PWA** 立刻可用，**APK** 是完整形态。

---

## 一、PWA（最快，无需安装任何工具）

1. 在电脑上启动服务并让手机能访问：

   ```bash
   cd mycelia
   npm run build
   npx vite preview --host 0.0.0.0 --port 4175
   ```

2. 手机连同一个 Wi-Fi，浏览器打开 `http://<电脑的局域网 IP>:4175/`。
   （在 Windows 上用 `ipconfig` 查 IPv4 地址，例如 `192.168.1.23`）

3. 浏览器菜单里选 **「添加到主屏幕」/「安装应用」**。之后它会像 App 一样全屏启动，
   并且**离线也能玩**（Service Worker 已预缓存应用外壳）。

> 适合"先在手机上确认手感"。缺点是仍然跑在浏览器沙盒里，Android 有时会限制后台。

---

## 二、APK（完整形态）

### 前置环境（本机已满足）

| 需要 | 本机状态 |
|---|---|
| Android SDK | `%LOCALAPPDATA%\Android\Sdk`（platforms: android-34、android-36；build-tools 34.0.0） |
| JDK | `C:\Program Files\Java\jdk-24` |
| Gradle | 无需手动装：`android/gradlew.bat` 会自己下载（首次约 200MB） |

### 构建

```bash
cd mycelia
npm run build:apk          # Windows
# 或 npm run build:apk:unix （Git Bash / WSL / macOS）
```

产物在：`android/app/build/outputs/apk/debug/app-debug.apk`

如果 `local.properties` 丢了（例如你删过 `android/` 目录），需要重新写一份：

```properties
sdk.dir=C:\\Users\\<你的用户名>\\AppData\\Local\\Android\\Sdk
```

`JAVA_HOME` 也要指向 JDK：

```bash
export JAVA_HOME="C:\\Program Files\\Java\\jdk-24"   # Git Bash
```

### 装到手机

1. 把 `app-debug.apk` 传到手机（数据线 / 微信文件传输助手 / 网盘都行）。
2. 手机上点开安装包，系统会提示"未知来源"，允许一次即可。
3. 首次启动会有 1–2 秒白屏（WebView 初始化），之后就是游戏本体。

> 这是 **debug 包**，用于自己和朋友试玩足够；要发布到应用商店需要签名过的 release 包
> （需要生成 keystore，`assembleRelease` + 签名配置）。

---

## 三、手机上怎么操作

手机上**没有右键、没有 Shift、没有中键**，所以操作方式与桌面不同：

| 想做的事 | 手势 |
|---|---|
| 平移画布 | **单指拖动** |
| 缩放 | **双指捏合** |
| 建造 | 先在「建造」抽屉里选一种节点，然后在画布上**轻点**空白处 |
| **连线** | **先点源节点，再点目标节点** —— 第一次点会选中，第二次点就连上 |
| 打开节点菜单（删除等） | **长按节点 500ms** |
| 移动节点 | 目前用长按菜单删除后重建；拖拽移动是桌面手势（触控版待补：见已知问题） |

底部导航在竖屏下是**抽屉开关**：

- 点「网络」→ 收起所有面板，回到全屏画布
- 点「建造」→ 从底部滑出建造面板
- 点「强化」→ 从底部滑出升级/科技面板
- 其余按钮（合成 / 自动化 / 菌市 / 进度 / 孢子 / 挑战 / 法则 / 时间 / 设置）打开全屏面板

---

## 四、存档与备份

- 存档**双写**：`localStorage`（同步）+ `IndexedDB`（异步、更耐清理）。
  如果系统清掉了 `localStorage`，启动时会自动从 IndexedDB 救回并提示。
- 设置面板里有 **导出 / 导入存档**（一段 JSON 文本），换手机时用它搬运。
- 设置面板的 **「清空存档并重开」** 会同时清掉两处存档与新手引导标记。

---

## 五、已知问题

| 问题 | 说明 |
|---|---|
| 触控下不能拖拽移动节点 | 只能长按删除后重建。桌面端拖拽移动正常。 |
| 首次构建要下载 Gradle | 约 200MB，取决于网络；卡住时可直接用 PWA 路线 |
| 只有 debug 包 | 上架需要自行签名 release |
| 横屏回到三栏布局 | 竖屏是「全屏画布 + 底部抽屉」，横屏（≥900px）与桌面一致 |

---

## 六、性能参考

骁龙 8 级设备上的实测（桌面 Edge 无头模式，390×844 视口）：

| 规模 | 渲染中位帧时间 | 单 tick 逻辑 |
|---|---|---|
| 1000 节点 | 3.10 ms（≈322fps） | 3.34 ms |

移动端会自动把 dpr 上限压到 1.5、粒子密度减半。
