# 文档索引

Mycelia 的设计、数值、验证与证据都在这里。按"想了解什么"来选入口。

## 想马上玩到

| 位置 | 内容 |
|---|---|
| [`../release/mycelia-debug.apk`](../release/mycelia-debug.apk) | 手机安装包（4.5 MB） |
| [`../release/README.md`](../release/README.md) | 装机步骤与手机手势对照表 |
| [`MOBILE.md`](MOBILE.md) | 完整移动端说明（PWA / APK、已知问题） |

## 想了解这个游戏是什么

| 文档 | 内容 |
|---|---|
| [`../README.md`](../README.md) | 一句话定位、当前状态、如何运行、目录结构、工程约定 |
| [`GDD.md`](GDD.md) | 设计文档：世界观、四层循环、资源体系、网络机制、系统清单 |

## 想调数值或理解平衡

| 文档 | 内容 |
|---|---|
| [`balance-model.md`](balance-model.md) | 数值模型：成本曲线、产出乘区、Prestige 公式、土壤模型、离线曲线，以及**每一条被模拟器推翻后重写的规则** |
| [`balance/report.md`](balance/report.md) | 模拟器报告：6 策略 × 9 时间截面的资源曲线、里程碑时间线、6 项自动检查（由 `npm run sim` 生成） |
| [`balance/curves.csv`](balance/curves.csv) | 同上数据的机器可读版本（可直接导入表格画图） |

## 想确认"真的做了并且是对的"

| 文档 | 内容 |
|---|---|
| [`ACCEPTANCE.md`](ACCEPTANCE.md) | 验收报告：逐阶段交付物、验证矩阵、**已知问题诚实清单**、每一条用户反馈的修复证据 |
| `shots/` | 真实运行截图，按阶段分目录（见下） |

## 截图目录

| 目录 | 内容 |
|---|---|
| `shots/01-mvp/` | MVP 时期：三种分辨率布局、1000 节点压力场景 |
| `shots/02-play/` | 真实播放流程：首局、中期、离线报告、设置、菌市、进度、自动化、后期 |
| `shots/03-ui-rework/` | 第一轮反馈改造：引导层、节点形状与网格、升级面板、右键菜单 |
| `shots/04-features/` | 后续功能：建造项悬停详情、合成表、孢子与菌株面板 |

## 想跑验证

```bash
npm test              # 单元与行为测试（含平衡、反作弊、挑战、法则、惊喜机制）
npm run check:data    # 数据表 schema + 引用 + 配方图 + 数量达标
npm run check:reach   # 资源可达性：防止"永久卡死"（互相锁死的产出链）
npm run sim           # 无头模拟器 → 重新生成 balance/
npm run test:ui       # 真实浏览器端到端（CDP 真实鼠标事件）
npm run shots         # 生成播放截图
npm run audit:mobile  # 手机可操作性静态审计（找可疑点）
npm run test:mobile   # 手机可操作性真实验证（导航滚动、面板滚到底）
npm run test:mobile:fix # 抽屉与引导卡收起的专项回归
```

## 文档之间的约定

- **数据表是唯一真相**：`data/*.json` 里的内容量与平衡数字，由 `npm run check:data` 守护。
- **模拟器结论对实际游戏成立**：浏览器与 Node 共用同一套 `src/core`，因此 `balance/report.md`
  里的曲线就是玩家会遇到的曲线。
- **已知问题不会藏在附录里**：ACCEPTANCE.md 的"已知问题"章节列出尚未解决的问题（含
  未实现的隐藏系统），与已实现内容同样醒目。
