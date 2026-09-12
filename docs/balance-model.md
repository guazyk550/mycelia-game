# 数值模型 · Mycelia Balance Model

> PHASE 1 交付物。所有公式以 `data/*.json` 为唯一参数来源；本文档定义**公式形态**，
> `data/game-config.json` 提供**可调常数**。代码中出现本文档未列出的平衡常数即为 bug。

---

## 0. 数值哲学

三条硬规则：

1. **每个数量级必须有意义**：任何资源跨过 10^k 时，要么解锁新内容，要么触发瓶颈切换。
   早期 10^0–10^6、中期 10^6–10^30、后期 10^30–10^300、终局 10^300–10^10000。
2. **禁止裸 number 累加**：所有资源量走 `SciNum`（对数/科学计数法域）。核心层每次
   tick 后执行不变量断言（NaN / Infinity / 负数 / 溢出）。
3. **数字变大不是深度**：如果一次改版只提高了产率而没有改变玩家的决策，这次改版是失败的。

---

## 1. 生产公式（分层乘积）

单个节点在单 tick 内的资源产出：

```
output(node, res) = baseRate(res)                        # 来自 nodes.json 的 recipe.outputs
                  × nodeUpgradeMul(node)                 # Π(1 + up.effect.value)  节点类升级
                  × globalMul(res)                       # Π(1 + up.value) 全局升级/科技/成就
                  × catalystMul(node)                    # 见 §3
                  × inDegreeMul(node)                    # min(1 + 0.02 × (inDeg-1), 1.2)
                  × depthMul(node.layer)                 # layers.depthMul
                  × richnessMul(node.tile)               # 见 §4
                  × comboMul                             # 1 + 0.01 × min(combo, 100)
                  × critExpected                         # 1 + critChance × (critMul - 1)
                  × prestigeMul                          # 菌株 × 基因 × 法则
                  × eventMul(now)                        # 见 §8
                  × seasonMul(now, res)                  # game-config.time.seasonMultipliers
                  × timeCompressionMul                   # 1 / 1.5 / 2 / 3
```

约束：

- `globalMul` 是**乘算**而不是加算，避免线性堆叠导致的失控；同一 kind 的多个来源（升级 + 科技 + 成就）
  按 `1 + Σvalue` 先合并，再与其他 kind 相乘。
- `catalystMul` 与 `inDegreeMul` 相加后乘入，是有意让拓扑成为独立乘区。
- 任何单 tick 产出超过 `1e30 × 已有量` 时记录警告（用于发现失控）。

---

## 2. 成本与建造

```
cost(n)        = baseCost × costGrowth^n × (1 - buildCostDiscount) × challengeCostMul
buildTime(node) = baseTime × (1 - buildSpeed) × eventBuildSpeedMul × (1 + 0.02 × nodeCount/100)
```

分区增长率（与 `data` 表一致）：

| 类别 | 增长率 | 例子 |
|---|---|---|
| 普通节点升级 | 1.18 | `up_dec1_a` |
| 稀有 / II 级 | 1.22–1.26 | `up_bor2_a` |
| 高级 / III 级 | 1.28–1.32 | `up_sac3_a` |
| Meta / 法则 | 1.35–1.45 | `up_law_a` |
| Prestige 类 | 由模拟器标定 | 暂用 1.60 |

关键校验：**成本增长率必须小于该升级带来的产出增长率**，否则会出现"越买越穷"的死路。
对 `outputMul` 型升级，要求 `value > growth - 1`（例如 value 0.25 对应 growth ≤ 1.25）。

---

## 3. 催化求值（拓扑收益）

```
matching(link) = rule where (rule.upstreamTag == upstream.catalystTag)
                       and (rule.downstreamClass in [downstream.class, "*"])
catalystMul(node) = max(rateMul of matching in-links)
                  × min(1 + 0.02 × (inDegree - 1), 1.2)
                  + catalystBonus            # 科技/升级/成就提供的全局加成
enzymeMul(node)   = 1 - min(0.8, min(enzymeDiscount of matching in-links) + globalEnzymeDiscount)
```

- 入边数为 0 的配方型节点**不工作**（extractor 除外）。
- **v0.1 简化**：资源是全局库存，连线不承载物流，只提供催化与结算顺序。
  判定输入是否充足时读的是全局库存（环内节点读 tick 起始快照）。
- 环（`up_m_cycle` 解锁）按分层拓扑序结算：环内节点使用**上一 tick 的输出值**，保证确定性。
- `catalystUses` 统计网络生命周期内发生的催化匹配次数，用于 Prestige 的 `topologyFactor`。

---

## 4. 土壤模型

```
richness[t+1] = clamp(
    richness[t]
  - Σ (node.depletion × tickSeconds × (1 - depletionReduce) × depletionMul)
  + repairBase + Σ up.richnessRepair
  + tech.richnessRepair
  + event.richnessChange,
  floor = layer.richnessFloor × (1 + up.richnessFloor) ,
  cap   = layer.richnessBase × (1 + tech.richnessCap) )

richnessRatio = clamp(richness / layer.richnessBase, 0, 1)     # 按层基准归一化
richnessMul   = 0.35 + 0.65 × richnessRatio                     # 满富饶 = 100% 产出
```

> 归一化按**层基准**而不是绝对值：表土层 base 70 意味着它的满富饶也是 100% 产出，
> 只是枯竭得更快（floor 与 base 的差值小）。深层地块 base 更高，因此更耐久。

设计意图：枯竭不是惩罚而是**节奏工具**——它逼玩家在"抽干一块地换爆发"与"轮作维持长期产出"之间选择。
`tech_sub_14 永续基质` 取消枯竭但产出 −25%，是永续流的最终选择。

---

## 5. Prestige 模型

```
networkValue = Σ node.investedCost
             × (1 + 0.03 × linkCount)
             × topologyFactor
topologyFactor = 1 + 0.05 × ln(1 + catalystUses)

sporogeneGain = floor( max(minGain,
      (networkValue / networkValueBase)^exponent
    × (1 + geneBonus)
    × (1 + Σ up.prestigeGain)
    × strainMul
    × challengeMul
    × maturity ) )

maturity = clamp(sqrt(roundTimeSec / 600), 0.2, 1)      # 本轮时长，10 分钟满额
```

参数（`game-config.prestige`）：`networkValueBase = 1.5e5`、`exponent = 0.55`。

- **软上限**：单轮收益不会因等待而无限增长；`softCapMultiplier = 3` 表示超过 3× 单轮值后
  收益进入递减区（`exponent` 局部降到 0.3）。
- **首次孢子化目标 45–120 分钟**（模拟器实测最快策略 1.82h，中位数 6.35h）。
- **成熟度 `maturity`**：本轮时长不足 10 分钟就重置，收益按 sqrt 打折，最低 20%。
  这一条是实测逼出来的：没有它时机器人每 3 分钟重置一次，7 天孢子化 1300+ 次。
- **孢子基因加成**（PHASE 4 基因树的简化替身）：`globalOutput += 0.6 × log10(1 + sporogene)`。
  刻意用对数 —— 线性/幂次会让孢子基因指数膨胀，直接把循环变成刷分。
- P2–P5 的阈值见 `game-config.prestige.levelThresholds`。

---

## 6. 市场模型（菌市）

```
μ[t]      = basePrice × clamp(1 - 0.5 × netSupplyRatio, 0.3, 2.0)
netSupplyRatio = 玩家近 60 秒净产量 / market.depthBase
p[t+1]    = clamp( p[t] × (1 + θ × (1 - p[t]/μ[t]) + σ × ε), 0.2 × basePrice, 3.0 × basePrice )
fee       = feeBase + 0.01 × (近 60 秒同资源交易次数)
```

- 玩家大量生产会**压低**自己资源的价格——这是"囤货 vs 加工 vs 等待"策略空间的来源。
- 60 秒内重复大额交易手续费递增，防止无脑刷。
- `marketShock` 事件直接对 `p[t]` 施加跳空。

---

## 7. 离线模型

```
rawOffline   = min(now - savedAt, hardCapHours × 3600)          # 硬上限 12h
efficiency   = min(baseEfficiency + techBonus + upBonus, maxEfficiency)   # 上限 5.0
softCap(t)   = 1.0                                t ≤ 2h
               1.0 - 0.5 × (t - 2) / 6           2h < t ≤ 8h
               0.5 + 0.1 × (t - 8) / 4           8h < t ≤ 12h  （衰减后略回升，奖励长离线）
offlineGain  = Σ node.baseRate × 3600 × rawOffline × efficiency × softCap(rawOffline)
```

- 离线期间以 10 分钟粒度模拟事件，最多结算 8 个；负面事件强度减半。
- 时钟回拨 / 未来时间 → 收益记 0 并写入日志，不做惩罚性清档。

---

## 8. 事件与季节

```
eventMul(now) = Π (1 + modifier.value)     # 同类叠加后再乘其他 kind
effectiveEventStrength = raw × (1 - eventResist)   # 上限 60% 减免
seasonMul     = time.seasonMultipliers[season][res] ?? 1.0
```

周而复始：`dayLengthSec = 600`（昼夜）、`seasonLengthSec = 3600`（四季）。

---

## 9. Combo / 暴击

```
comboMul   = 1 + perStackBonus × min(combo, 100)          # 上限 2.0
combo      += 1  当且仅当 3 秒内发生一次 validAction（见 game-config.combo.validActions）
combo      = 0   当 5 秒内没有 validAction
critExpected = 1 + critChance × (critMul - 1)              # 基础 critChance 0%，critMul 2.0
```

设计意图：combo 奖励**正确操作**（铺对节点、连对拓扑、买对升级），而不是狂热点击。

---

## 10. 解锁节奏表（目标曲线，由模拟器验证）

| 时间 | 里程碑 | 数值门槛 |
|---|---|---|
| 0–2 min | 第一根分解丝 + 吸水菌丝 | 开局 spore 120 |
| 2–5 min | 糖化腔（第一口糖） | water 3 |
| 5–10 min | 孢子囊（孢子自持）、感光菌帽 | sugar 40 / sugar 5 |
| 10–20 min | 酶腺、毒素腺、掘进菌柄 | sugar 60 / mineral 20 / humus 25 |
| 15–25 min | 含水层 | water 400 |
| 25–45 min | 藻类共生体 → 蜜露 → 契约巢 | honeydew 150 |
| 35–60 min | 矿脉层 → 菌核压机 | mineral 1200 / enzyme 500 |
| 60–90 min | **核心腔 → 第一次孢子化** | sclerotium 5 + richness ≥ 60 |
| 1.5–3 h | 岩层 → 电信号 → 核心腔规模化 | sclerotium 15 |
| 3–6 h | 虫巢意识（P3）、自动化规则引擎 | prestige 3 |
| 6–12 h | 地幔层、深菌质、星尘雏形 | core 5 |
| 12–30 h | 行星共生（P4）、季节系统 | prestige 4 |
| 30–100 h | 星尘/法则 → 星际播种 | 30 挑战 + law 10 |

**瓶颈循环**（必须成立，由模拟器检查"任意时刻存在唯一最紧资源"）：
`spore → sugar → water → mineral → enzyme → sclerotium → core → signal → deepmass → stardust`

---

## 11. 调参旋钮（允许在不改代码的情况下调整）

`data/game-config.json` 中所有字段均可调。重点旋钮：

| 旋钮 | 影响 | 现状 |
|---|---|---|
| `prestige.networkValueBase` | 首次孢子化时间 | 1.5e5 |
| `prestige.exponent` | Prestige 收益曲线陡峭度 | 0.55 |
| `offline.softCapFloor` | 长离线价值 | 0.5 |
| `market.theta` / `sigma` | 市场波动速度 / 幅度 | 0.05 / 0.03 |
| `combo.perStackBonus` | 主动操作收益 | 0.01 |
| `soil.richnessMulFloor` | 枯竭惩罚强度 | 0.35 |
| `time.seasonMultipliers` | 季节波动幅度 | 见文件 |
| 各 `data/*.json` 的 `growth` | 单条升级曲线 | 见文件 |

---

## 12. 反失控规则（必须由代码强制）

1. **不变量断言**（每次 tick，`debug.assertInvariants`）：
   - 所有资源 ≥ 0 且为有限数（`SciNum.isFinite`）
   - 资源 ≤ 上限（若配置了 cap）
   - `networkValue`、`sporogeneGain` 有限
2. **单 tick 增量上限**：任意资源单 tick 增幅 > 已有量的 10^30 倍 → 截断并记录（防爆炸式 bug）。
3. **购买漏洞防守**：购买前重算成本，扣除与授予在同一原子操作内完成；负数余额直接拒绝。
4. **Prestige 漏洞防守**：`sporogeneGain` 以"重置前的快照"计算，落账后立即清空网络，禁止重复结算。
5. **无限循环防守**：拓扑结算有最大层数（`nodeCap`）+ 每 tick 最大传播步数；规则引擎每 tick 最多求值 200 条。
6. **溢出守卫**：`SciNum` 指数超过 1e15 时进入"饱和"状态并上报，不产生 Infinity。

---

## 13. 模拟器验证清单（PHASE 2 必须全部通过）

| # | 检查项 | 通过标准 |
|---|---|---|
| 1 | 首次孢子化时间 | 6 条策略中位数落在 45–120 分钟 |
| 2 | 资源曲线 | 1m/5m/10m/30m/1h/5h/10h/24h/7d 全部无 NaN/Infinity |
| 3 | 瓶颈唯一性 | 每个时间点存在唯一最紧资源，且 30 分钟内会切换 |
| 4 | 每数量级解锁 | 每跨 10^6 至少触发一次新内容解锁 |
| 5 | 单一策略统治 | 无任何策略在 >70% 的时间点领先 |
| 6 | 死路检测 | 不存在"所有可买项都买不起且产出为 0"的状态 |
| 7 | 无限收益 | 7 天模拟中无指数爆炸（任何资源 log10 增长 < 线性 + 常数） |
| 8 | Prestige 收益 | 每轮孢子化收益单调不减，且软上限生效 |
| 9 | 确定性 | 同种子同策略两次模拟结果完全一致 |
| 10 | 数值保真 | `SciNum` 往返序列化后相对误差 < 1e-12 |

模拟器输出落盘 `docs/balance/`（CSV + Markdown 报告 + 图表数据）。
未通过项 → 调整 `game-config` 或数据表 → 重跑，直到全绿。

---

## 14. 数值校正记录（PHASE 2 由模拟器驱动）

首轮模拟（v0 数据表）暴露的问题与修正，按发现顺序：

| # | 现象 | 根因 | 修正 |
|---|---|---|---|
| 1 | 机器人 7 天只有 7 个节点 | 开局 60 孢子被全花在吸水菌丝上，孢子囊（25 孢子）永远造不出来 | 开局孢子 60 → 120；策略引入「战略储备」（`resources.json` 的 `strategicReserve`）+ 补链豁免 |
| 2 | 糖永远归零、孢子产出停滞 | 1 个孢子囊要 5 个糖化腔供糖，糖化腔又要 4 个分解丝 —— 比例断裂 | 糖化腔产出 1→1.5/s；孢子囊需求 5→1.5 糖/s；孢子囊产出 0.4→2/s（含 II/III 级同步） |
| 3 | 扩张在 60 节点左右压死 | 基础节点 costGrowth 1.18，建 10 个后成本 ×5.2、20 个后 ×27 | I 级节点 costGrowth 1.18 → 1.14 |
| 4 | 首次孢子化要 24 小时 | `networkValueBase` 过高，网络价值增长追不上 | 1e6 → 1.5e5（实测最早 1.82h、中位数 6.35h） |
| 5 | 孢子化后第二局跟第一局一样慢 | 孢子基因当时没有任何实际加成，Prestige 是空机制 | 加入对数型基因加成（PHASE 4 由基因树取代）；实测重建时间 5.7h → 24min |
| 6 | 7 天孢子化 1300–3500 次（刷分循环） | 收益随网络价值指数增长，重置→立刻再重置 | 加入「成熟度」因子（本轮不足 10 分钟收益按 sqrt 打折，最低 20%） |

**未解决的已知问题**（留给 PHASE 5）：
- 策略 C（Prestige 狂）仍平均 7.5 分钟重置一次 —— 属于该性格的设计预期，但需要真人手感验证。
- 科技树在 7 天模拟中最多解锁 15/80，机制型科技（禁忌/时间分支）几乎摸不到 —— 需要检查科技成本曲线是否过陡。
