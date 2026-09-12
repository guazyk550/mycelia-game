/**
 * 应用装配与主循环。
 *
 * 时间模型（与 balance-model 一致）：
 *   · 逻辑 tick 固定 100ms，由累积器驱动，与显示帧率解耦；
 *   · 单帧最多补 data.config.simulation.maxStepsPerFrame 个 tick，防止切回标签页时卡死；
 *   · 单次 dt 上限由 antiCheat.maxSingleDeltaSec 限制（同时是反作弊的第一道闸）。
 */

import { SciNum } from '../core/math/scinum.ts';
import { createNewGame, type GameState } from '../core/state.ts';
import { computeModifiers, buildLink, tick, sporogeneGain, moveNode, demolishNode, demolishLink, nodeCatalyst, type ModifierSet } from '../core/economy/engine.ts';
import type { GameData } from '../core/types.ts';
import { loadBrowserGameData } from '../data/browser-source.ts';
import { decideAndAct, STRATEGIES } from '../sim/strategies.ts';
import { resolveMoveTarget, resolvePlacement } from '../core/network/occupancy.ts';
import { NetworkRenderer } from './canvas/renderer.ts';
import { TopBar } from './panels/topbar.ts';
import { BuildPanel } from './panels/build-panel.ts';
import { Inspector } from './panels/inspector.ts';
import { h, setText } from './dom.ts';
import { THEME, nodeColor } from './theme.ts';
import { SaveManager } from './save-manager.ts';
import { celebrate, offlineReportModal, settingsModal, showModal } from './panels/modal.ts';
import { TutorialGuide, type GuideTarget } from './panels/tutorial.ts';
import { TooltipCard, type TooltipRow } from './panels/tooltip-card.ts';
import { settleOffline } from '../core/offline/settle.ts';
import { runAutomation } from '../core/automation/engine.ts';
import { checkAchievements, checkQuests, describeEventEffect, tickEvents } from '../core/progression/content-engine.ts';
import { EMPTY_TRIGGER_CONTEXT, type TriggerContext } from '../core/progression/triggers.ts';
import { tickMarket } from '../core/market/market.ts';
import { AutomationPanel } from './panels/automation-panel.ts';
import { MarketPanel } from './panels/market-panel.ts';
import { CodexPanel } from './panels/codex-panel.ts';
import { openPrestigePanel as showPrestigePanel } from './panels/prestige-panel.ts';
import { openChallengePanel } from './panels/challenge-panel.ts';
import { openLawPanel } from './panels/law-panel.ts';
import { openTimeBankPanel } from './panels/timebank-panel.ts';

const NAV_GROUPS: string[][] = [
  ['网络', '建造', '强化', '合成', '自动化', '菌市'],
  ['进度', '孢子', '挑战', '法则', '时间'],
  ['设置'],
];

/** 确定性伪随机（同种子同序列，便于复现"为什么这一局出了这个事件"） */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class App {
  private data: GameData;
  private state: GameState;
  private mods: ModifierSet;

  private renderer: NetworkRenderer;
  private topbar: TopBar;
  private buildPanel: BuildPanel;
  private inspector: Inspector;
  private noticeEl: HTMLElement;
  private statsEl: HTMLElement;
  private hintEl!: HTMLElement;
  private tooltipEl!: HTMLElement;
  private statusEl!: HTMLElement;
  /** 通用信息浮层（画布节点 + 建造项共用） */
  private tooltip = new TooltipCard();
  private progressBadge!: HTMLElement;
  /** 上次查看进度面板时的计数（用于未读徒章） */
  private lastSeenProgress = { achievements: 0, quests: 0, events: 0 };
  /**
   * 清档时置位：此后不再写存档。
   * 根因（Bug 3）：早期 onClear 先 save.clear() 再 location.reload()，
   * 而 reload 会触发 beforeunload → 把当前状态又写回去，清档等于白做。
   */
  private suppressSave = false;
  /**
   * 只读沙盒：存档校验和不匹配时进入。
   * 不自动保存（否则一次 reload 就把被篡改的档又写回去、玩家失去原件）。
   */
  private readOnlySandbox = false;

  private hoverNodeId: string | null = null;
  /**
   * 触控手势状态。桌面端的鼠标逻辑原样保留，触控走这一套（靠 pointerType 分流）。
   *
   * 手机上没有 Shift、没有右键、没有中键，所以三件事必须重新设计：
   *   · 连线：**点源节点 → 点目标节点**（替代 Shift 拖拽）
   *   · 菜单：**长按 500ms**（替代右键）
   *   · 平移：**单指拖动**（替代中键）；缩放：**双指捏合**
   */
  /** 从 IndexedDB 救回存档时，离线报告要等替换完成后再弹 */
  private pendingOfflineReport: import('../core/offline/settle.ts').OfflineReport | null = null;
  private touch = {
    pointers: new Map<number, { x: number; y: number }>(),
    startedAt: 0,
    startPos: { x: 0, y: 0 },
    startCam: { x: 0, y: 0 },
    longPressTimer: 0 as unknown as ReturnType<typeof setTimeout>,
    longPressFired: false,
    moved: false,
    panning: false,
    pinchStartDist: 0,
    pinchStartScale: 1,
    /** 已选中的节点：再次轻点另一个节点即连线（"点两点"连线） */
    linkFrom: null as string | null,
    lastTapAt: 0,
  };
  private lastTickMs = 0;
  private canvasWrap!: HTMLElement;
  /** 正在拖拽移动的节点（反馈 #5）；与 dragFrom（连线）互斥 */
  private dragNodeId: string | null = null;
  /** 最近一次 pointerdown 的处理结果（调试与端到端测试用） */
  private lastPointerDebug = 'none';
  private selectedNodeId: string | null = null;
  private dragFrom: string | null = null;
  private dragPos: { x: number; y: number } | null = null;
  private lastThrottle: Record<string, number> = {};

  private accumulator = 0;
  private lastFrameTime = performance.now();
  private uiClock = 0;
  private save: SaveManager;
  private autoSaver: (now: number) => void;
  private automationPanel: AutomationPanel;
  private marketPanel: MarketPanel;
  private codexPanel: CodexPanel;
  private tutorial: TutorialGuide;
  /** 自动化节流：不必每 tick 跑（内部会遍历全部升级与节点） */
  private nextAutomationAt = 0;
  private automationLog: string[] = [];
  /** 内容引擎（事件/成就/任务）的节流与确定性随机源 */
  private contentClock = 0;
  private floatClock = 0;
  private rng: () => number = mulberry32(1234567);
  /** 静默模式（demo / 无头）：通知只入队，不写 DOM */
  private quiet = false;
  private pendingNotices: string[] = [];

  constructor(root: HTMLElement) {
    this.data = loadBrowserGameData();
    this.save = new SaveManager(this.data);
    const params = new URLSearchParams(window.location.search);
    // demo / stress / fresh 三种调试模式不碰存档，避免把测试状态写进玩家的自动存档
    const skipSave = params.has('demo') || params.has('stress') || params.has('fresh');
    this.quiet = params.has('demo') || params.has('stress');

    let offlineReport: ReturnType<SaveManager['load']>['offline'] = null;
    let loadWarning: string | null = null;
    if (skipSave) {
      this.state = createNewGame(this.data);
    } else {
      const outcome = this.save.load('auto');
      if (outcome.state) {
        this.state = outcome.state;
        offlineReport = outcome.offline;
        if (outcome.warnings.length > 0) console.warn('[save] 加载警告:', outcome.warnings);
      } else {
        this.state = createNewGame(this.data);
        if (outcome.tampered) {
          this.readOnlySandbox = true;
          loadWarning =
            '检测到存档校验和不匹配（文件可能被修改）。已新建一局并进入**只读沙盒**：' +
            '当前进度不会自动写入存档，**原存档未被覆盖**，可从设置面板导出后自行处理。';
        } else if (outcome.warnings.length > 0) {
          loadWarning = `存档无法加载：${outcome.warnings[0]}`;
        } else {
          // localStorage 里没有：试试 IndexedDB（WebView 被清理后最常见的救回场景）。
          // 这一步是异步的，所以先把新局跑起来，救回成功再无缝替换。
          void this.save.recoverFromIdb('auto').then((rescued) => {
            if (!rescued?.state) return;
            // 只有玩家还没开始操作时才覆盖，避免把刚建的局冲掉
            if (this.state.tick > 5) return;
            this.state = rescued.state;
            this.mods = computeModifiers(this.state, this.data);
            this.notice('已从备份存储（IndexedDB）恢复存档');
            if (rescued.offline) this.pendingOfflineReport = rescued.offline;
          });
        }
      }
    }
    this.mods = computeModifiers(this.state, this.data);
    // 自动保存：抑制标志（清档 / 只读沙盒）下不写入
    this.autoSaver = this.save.makeAutoSaver(() => (this.shouldPersist() ? this.state : null));

    // ---- 画布
    // CSS 尺寸交给布局（100%），像素缓冲由 renderer.resize 负责；
    // 早期版本给 canvas 写死 px 宽度，会在窄屏把 grid 列撑破。
    const canvas = h('canvas', { style: { display: 'block', width: '100%', height: '100%' } });
    this.renderer = new NetworkRenderer(canvas, this.data);
    this.renderer.hooks = {
      highlighted: () => this.hoverNodeId ?? this.selectedNodeId,
      throttleOf: (id) => this.lastThrottle[id],
    };

    // ---- 面板
    this.topbar = new TopBar(this.data);
    this.buildPanel = new BuildPanel(this.data);
    // 层切换后刷新落点预览（建造会用到新的层）
    this.buildPanel.onLayerChange = () => this.syncUi();
    this.inspector = new Inspector(
      this.data,
      () => this.state,
      () => this.mods,
    );
    this.inspector.onNotice = (msg) => this.notice(msg);
    this.inspector.onPurchase = () => {
      // 购买成功：顶部资源数字跳动（反馈 #2 的“购买反馈”）
      this.topbar.flashAll();
    };
    this.automationPanel = new AutomationPanel(
      this.data,
      () => this.state,
      () => this.mods,
      () => this.refreshMods(),
    );
    this.marketPanel = new MarketPanel(this.data, () => this.state, (msg) => this.notice(msg));
    this.codexPanel = new CodexPanel(this.data, () => this.state);

    // ---- 新手引导（反馈 #3）：卡片插在建造面板顶部，并把目标元素描边高亮
    this.tutorial = new TutorialGuide(this.data, () => this.state);
    this.tutorial.onFocus = (target) => this.focusGuideTarget(target);
    // 引导卡的逃生通道：卡住时直接打开合成表看"这东西谁产出"
    this.tutorial.onOpenCodex = () => this.codexPanel.open();
    // 引导卡在桌面端挂在建造面板顶部；手机竖屏下面板会被隐藏，改为浮在画布上。
    const mountGuide = (): void => {
      const mobile = window.matchMedia('(max-width: 899px)').matches;
      if (mobile) {
        if (this.tutorial.el.parentElement !== document.body) document.body.append(this.tutorial.el);
      } else if (this.tutorial.el.parentElement !== this.buildPanel.el) {
        this.buildPanel.el.prepend(this.tutorial.el);
      }
    };
    mountGuide();
    window.addEventListener('resize', mountGuide);
    // 模态框据此避让底部导航（桌面端该变量为 0，行为不变）
    document.documentElement.style.setProperty('--nav-h', (window.matchMedia('(max-width: 899px)').matches ? 52 : 0) + 'px');

    this.noticeEl = h('div', {
      style: {
        position: 'absolute',
        left: '50%',
        bottom: '18px',
        transform: 'translateX(-50%)',
        padding: '6px 14px',
        background: 'rgba(16,19,24,0.94)',
        border: `1px solid ${THEME.borderHover}`,
        borderRadius: '6px',
        fontSize: '12px',
        opacity: '0',
        transition: 'opacity 200ms',
        pointerEvents: 'none',
        whiteSpace: 'nowrap',
      },
    });
    this.statsEl = h('div', {
      style: {
        position: 'absolute',
        right: '10px',
        bottom: '8px',
        fontSize: '11px',
        color: THEME.textFaint,
        fontFamily: THEME.fontMono,
        pointerEvents: 'none',
      },
    });
    this.hintEl = h('div', {
      style: {
        position: 'absolute',
        left: '10px',
        bottom: '8px',
        fontSize: '11px',
        color: THEME.textFaint,
        pointerEvents: 'none',
      },
      text: '拖拽移动节点 · Shift+拖拽连线 · 右键节点删除 · Del 拆除选中 · Esc 取消建造',
    });
    this.tooltipEl = h('div', {
      style: {
        position: 'absolute',
        display: 'none',
        zIndex: '40',
        pointerEvents: 'none',
        maxWidth: '320px',
        padding: '8px 10px',
        background: 'rgba(14,17,22,0.96)',
        border: `1px solid ${THEME.borderHover}`,
        borderRadius: '7px',
        boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
        fontSize: '12px',
        lineHeight: '1.55',
        color: THEME.text,
      },
    });

    // 注意：必须在创建 canvasWrap 之前赋值，否则挂进容器的是 undefined
    this.statusEl = this.buildStatusPanel();

    const canvasWrap = h(
      'div',
      { style: { position: 'relative', overflow: 'hidden', background: THEME.bg, minWidth: '0', minHeight: '0', height: '100%' } },
      canvas,
      this.noticeEl,
      this.statsEl,
      this.hintEl,
      this.tooltip.el,
      this.statusEl,
    );
    this.canvasWrap = canvasWrap;

    const main = h(
      'main',
      {
        style: {
          display: 'grid',
          // 列宽走 CSS 变量：媒体查询才能在手机竖屏下把它改成单列（
          // 内联样式优先级高于 CSS，早期写死 px 会导致手机上面板挤掉画布）
          gridTemplateColumns: 'var(--app-cols)',
          overflow: 'hidden',
          minHeight: '0',
        },
      },
      this.buildPanel.el,
      canvasWrap,
      this.inspector.el,
    );

    const nav = h(
      'nav',
      {
        style: {
          height: `${THEME.bottomNavHeight}px`,
          background: THEME.panel,
          borderTop: `1px solid ${THEME.border}`,
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
          padding: '0 10px',
        },
      },
      ...NAV_GROUPS.flatMap((group, gi) => {
        const btns = group.map((label) => {
          const badge = h('span', {
            style: {
              display: 'none',
              marginLeft: '6px',
              padding: '0 5px',
              borderRadius: '8px',
              background: THEME.accent,
              color: '#0b0d10',
              fontSize: '10px',
              fontWeight: '600',
              lineHeight: '15px',
            },
          });
          const isActive = label === NAV_GROUPS[0]![0];
          const btn = h(
            'button',
            {
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                padding: '5px 14px',
                fontSize: '12px',
                background: isActive ? THEME.panelAlt : 'transparent',
                color: isActive ? THEME.text : THEME.textDim,
                border: `1px solid ${isActive ? THEME.borderHover : 'transparent'}`,
                borderRadius: '5px',
                cursor: 'pointer',
                position: 'relative',
              },
              onclick: () => {
                // 手机竖屏：底部导航切换"底部抽屉"（建造 / 强化），其余情况回到全屏画布。
                // 桌面端没有 data-drawer 时这套 CSS 不生效，调用它无害。
                this.setDrawer(label === '建造' ? 'build' : label === '强化' ? 'inspector' : null);
                if (label === '建造' || label === '强化' || label === '网络') return; // 抽屉类入口不开模态框
                if (label === '设置') {
                  this.openSettings();
                  return;
                }
                if (label === '孢子') {
                  this.openPrestigePanel();
                  return;
                }
                if (label === '挑战') {
                  this.openChallengePanel();
                  return;
                }
                if (label === '法则') {
                  this.openLawPanel();
                  return;
                }
                if (label === '时间') {
                  this.openTimeBankPanel();
                  return;
                }
                if (label === '自动化') {
                  this.automationPanel.open();
                  return;
                }
                if (label === '进度') {
                  this.openProgressPanel();
                  return;
                }
                if (label === '菌市') {
                  this.marketPanel.open();
                  return;
                }
                if (label === '合成') {
                  this.buildPanel.hideTooltip();
                  this.codexPanel.open();
                  return;
                }
                // 「网络」= 回到画布主视图
                this.notice('已在网络视图');
              },
            },
            h('span', { text: label }),
            badge,
          );
          if (label === '进度') this.progressBadge = badge;
          return btn;
        });
        if (gi === 0) return btns;
        return [
          h('span', { style: { width: '1px', height: '18px', background: THEME.border, margin: '0 6px' } }),
          ...btns,
        ];
      }),
    );

    root.append(this.topbar.el, main, nav);

    // ---- 键盘：Delete/Backspace 拆除选中节点（反馈 #5）
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        // 输入框里按退格不应该拆节点
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (this.selectedNodeId) {
          e.preventDefault();
          this.handleDeleteKey();
        }
      }
      if (e.key === 'Escape') this.buildPanel.clearSelection();
    });

    this.attachCanvasEvents(canvas, canvasWrap);
    this.observeResize(canvasWrap);

    // ---- 自检 / 热身通道
    // ?ticks=N  ：加载后同步跑 N 个 tick（无头验证用）
    // ?demo=秒数：用模拟器的「积极玩家」策略自动玩若干秒，用于快速查看中期局面与无头截图
    // 两者都保证首屏不是空的（真实玩家也能立刻看到资源数字）
    const warmup = Number(params.get('ticks') ?? '0');
    if (Number.isFinite(warmup) && warmup > 0) {
      const step = this.data.config.simulation.tickRateMs / 1000;
      for (let i = 0; i < Math.min(warmup, 2_000_000); i++) {
        const report = tick(this.state, this.data, step, { mods: this.mods });
        this.lastThrottle = report.throttled;
      }
    }
    if (params.has('demo')) this.runDemo(Number(params.get('demo') ?? '0'));
    if (params.has('stress')) this.buildStressNetwork(Number(params.get('stress') ?? '0'));
    this.syncUi();
    this.renderer.render(this.state, performance.now());

    // 压力测试：主动渲染多帧并测 tick 耗时（无头环境下 rAF 不跑，只能手动采样）
    let tickMs = 0;
    if (params.has('stress')) {
      for (let i = 0; i < 40; i++) this.renderer.render(this.state, performance.now() + i * 16);
      const t0 = performance.now();
      for (let i = 0; i < 10; i++) tick(this.state, this.data, 0.1, { mods: this.mods });
      tickMs = (performance.now() - t0) / 10;
    }
    this.lastTickMs = tickMs;

    if (params.has('ticks') || params.has('demo') || params.has('stress')) this.writeSelfTest(params);

    // ---- 新手引导的开场覆盖层（只在首次进入且未跳过时出现）
    // 注意：判断条件刻意不含 skipSave —— ?fresh 只是"忽略存档开新局"，仍应看到引导；
    // 只有 demo/stress 这类无头调试模式（this.quiet）才跳过。
    if (!this.quiet) {
      this.tutorial.showIntroIfNeeded(() => this.notice('先从左侧选一个节点放到画布上'));
    }

    // ---- 存档：自动保存 + 关闭页面时兵底保存
    if (!skipSave) {
      window.addEventListener('beforeunload', () => {
        if (!this.shouldPersist()) return;
        this.save.save(this.state, 'auto');
      });
      if (offlineReport) offlineReportModal(offlineReport);
      if (loadWarning) {
        showModal('存档提示', h('div', { style: { fontSize: '13px', lineHeight: '1.7', maxWidth: '480px' }, text: loadWarning }), [
          { label: '知道了', primary: true },
        ]);
      }
    }

    requestAnimationFrame(this.frame);
  }

  /**
   * 开发/验证用：让机器人把游戏玩 `seconds` 秒。
   * 复用 sim 层的策略（纯逻辑、不碰 DOM），所以它走的是与模拟器完全相同的决策路径。
   */
  private runDemo(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    const step = this.data.config.simulation.tickRateMs / 1000;
    const maxSteps = Math.min(Math.floor(seconds / step), 600_000);
    const ctx = {
      state: this.state,
      data: this.data,
      mods: this.mods,
      prestigeGain: SciNum.ZERO,
    };
    const strategy = STRATEGIES[0]!;
    for (let i = 0; i < maxSteps; i++) {
      if (i % 10 === 0) {
        ctx.prestigeGain = sporogeneGain(this.state, this.data, this.mods);
        const results = decideAndAct(ctx, strategy.prefs);
        if (results.some((r) => r.ok)) {
          this.mods = computeModifiers(this.state, this.data);
          ctx.mods = this.mods;
        }
      }
      const report = tick(this.state, this.data, step, { mods: this.mods });
      this.lastThrottle = report.throttled;
      this.stepSystems(step);
    }
  }

  /**
   * 压力测试：直接在图里铺 N 个节点与连线（**绕过成本与层容量限制**），
   * 用于验证 GDD §21 的性能要求（「节点 1000 时 ≥30fps」）。
   */
  private buildStressNetwork(n: number): void {
    const count = Math.max(0, Math.min(Math.floor(n), 3000));
    if (count === 0) return;
    const perRow = Math.ceil(Math.sqrt(count));
    const types = ['decomposer_i', 'hydra_i', 'saccharifier_i', 'sporangium_i'];
    let prev: string | null = null;
    for (let i = 0; i < count; i++) {
      const id = `stress-${i}`;
      this.state.graph.addNode({
        id,
        typeId: types[i % types.length]!,
        layerId: 'topsoil',
        x: (i % perRow) * 76 - (perRow * 76) / 2,
        y: Math.floor(i / perRow) * 76 - 400,
        active: true,
        built: true,
        richness: 70,
        rotationSwaps: 0,
      });
      if (prev) buildLink(this.state, this.data, prev, id);
      prev = id;
    }
    this.state.topoDirty = true;
  }

  /** 把关键状态写入 DOM，供无头验证抓取（只在 ?ticks= / ?demo= 时启用） */
  private writeSelfTest(params: URLSearchParams): void {
    const s = this.state;
    const resources = Object.entries(s.resources)
      .filter(([, v]) => v.isPositive())
      .map(([k, v]) => `${k}=${SciNum.format(v)}`)
      .join(' ');
    // 布局自检：响应式要求是"不出现滚动条、三栏都在视口内"
    const doc = document.documentElement;
    const rect = this.renderer.element.getBoundingClientRect();
    const layout =
      `viewport=${window.innerWidth}x${window.innerHeight} ` +
      `canvas=${Math.round(rect.width)}x${Math.round(rect.height)} ` +
      `wrap=${Math.round(this.canvasWrap.getBoundingClientRect().width)} ` +
      `left=${Math.round(this.buildPanel.el.getBoundingClientRect().width)} ` +
      `right=${Math.round(this.inspector.el.getBoundingClientRect().width)} ` +
      `overflowX=${doc.scrollWidth > window.innerWidth} overflowY=${doc.scrollHeight > window.innerHeight}`;
    const el = h(
      'div',
      { id: 'selftest', style: { display: 'none' } },
      h('span', { id: 'selftest-nodes', text: `nodes=${s.graph.size()} links=${s.graph.links.size} layers=${s.unlockedLayers.length}` }),
      h('span', { id: 'selftest-tick', text: `tick=${s.tick} elapsed=${s.elapsed.toFixed(1)}` }),
      h('span', { id: 'selftest-upgrades', text: `upgrades=${Object.keys(s.upgrades).length} techs=${Object.keys(s.techs).length} autoTier=${Math.floor(this.mods.autoTier)}` }),
      h('span', {
        id: 'selftest-content',
        text:
          `achievements=${Object.keys(s.achievements).length}/${this.data.achievements.size} ` +
          `quests=${s.stats.questsCompleted.length}/${this.data.quests.size} ` +
          `eventsSeen=${s.stats.eventsSeen.length} activeEvents=${s.activeEvents.length} ` +
          `recentNotices=${this.pendingNotices.length}`,
      }),
      h('span', { id: 'selftest-resources', text: resources }),
      h('span', { id: 'selftest-layout', text: layout }),
      h('span', {
        id: 'selftest-render',
        text:
          `medianFrameMs=${this.renderer.medianFrameMs().toFixed(2)} ` +
          `lastFrameMs=${this.renderer.lastFrameMs.toFixed(2)} ` +
          `samples=${this.renderer.frameSamples.length} ` +
          `tickMs=${this.lastTickMs.toFixed(2)}`,
      }),
    );
    document.body.append(el);
  }

  /** 立即刷新所有面板（不等下一个 UI 周期） */
  /**
   * 手机竖屏的底部抽屉切换。桌面端没有 data-drawer 时 CSS 不生效，调用它是无害的。
   * 画布全屏时（drawer = null）游戏才真正可玩 —— 否则 390px 宽下画布会被压成 0。
   */
  private setDrawer(which: 'build' | 'inspector' | null): void {
    if (which) document.body.dataset['drawer'] = which;
    else delete document.body.dataset['drawer'];
  }

  private syncUi(): void {
    this.topbar.update(this.state);
    this.buildPanel.update(this.state, this.mods);
    this.inspector.update(this.selectedNodeId);
    this.tutorial.update();
    setText(
      this.statsEl,
      `${this.state.graph.size()} 节点 · ${this.renderer.lastFrameMs.toFixed(1)}ms · ` +
        `孢子 ${SciNum.format(this.state.resources.spore ?? SciNum.ZERO)}`,
    );
  }

  // ---------------------------------------------------------------- 交互

  private attachCanvasEvents(canvas: HTMLCanvasElement, wrap: HTMLElement): void {
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const world = this.renderer.screenToWorld(e.clientX, e.clientY);
      const hit = this.nodeAt(world.x, world.y);
      if (hit) {
        this.selectedNodeId = hit;
        this.openNodeContextMenu(e.clientX, e.clientY, hit);
        return;
      }
      this.buildPanel.clearSelection();
      this.notice('已取消建造');
    });

    canvas.addEventListener('pointerdown', (e) => {
      // ---- 触控分流：手机上没有右键/中键/Shift，手势完全走另一套
      if (e.pointerType === 'touch') {
        this.onTouchDown(e);
        return;
      }
      // 只处理左键：右键走 contextmenu（取消建造 / 节点菜单），中键走下面的平移处理器。
      // 早期版本漏了这个判断，导致右键点空白会先把孢子放下去，再提示"已取消建造"。
      if (e.button !== 0) return;
      const world = this.renderer.screenToWorld(e.clientX, e.clientY);
      const hit = this.nodeAt(world.x, world.y);

      const pending = this.buildPanel.selectedType;
      if (pending && !hit) {
        const placement = resolvePlacement(this.state, world.x, world.y);
        const reason = this.buildPanel.tryBuild(this.state, this.mods, pending, world.x, world.y);
        if (reason) this.notice(reason);
        else {
          this.mods = computeModifiers(this.state, this.data);
          this.notice(placement?.shifted ? '已建造（落点被占用，已自动移到最近空位）' : '已建造');
        }
        return;
      }

      if (hit) {
        this.selectedNodeId = hit;
        this.dragPos = world;
        // 反馈 #5：默认拖拽 = 移动节点；Shift+拖拽 = 连线（两种意图分开，避免互相抢手势）
        if (e.shiftKey) {
          this.dragFrom = hit;
          this.dragNodeId = null;
          this.lastPointerDebug = `link-start:${hit}`;
        } else {
          this.dragNodeId = hit;
          this.dragFrom = null;
          this.lastPointerDebug = `move-start:${hit}`;
        }
        canvas.setPointerCapture(e.pointerId);
      } else {
        this.selectedNodeId = null;
        this.lastPointerDebug = pending ? 'build-fallback' : 'deselect';
      }
    });

    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') {
        this.onTouchMove(e);
        return;
      }
      const world = this.renderer.screenToWorld(e.clientX, e.clientY);
      const hit = this.nodeAt(world.x, world.y);
      this.hoverNodeId = hit;
      canvas.style.cursor = this.buildPanel.selectedType ? 'copy' : hit ? 'pointer' : 'default';
      // 悬停 tooltip（反馈 #4 的补充：图形只能传达“是什么类”，细节靠 tooltip）
      this.updateTooltip(hit, e.clientX, e.clientY, world);

      if (this.dragFrom || this.dragNodeId) this.dragPos = world;
      if (this.dragNodeId && this.dragPos) {
        // 拖拽移动：实时显示目标格（含移位）
        const target = resolveMoveTarget(this.state, this.dragNodeId, world.x, world.y);
        this.renderer.movePreview = {
          nodeId: this.dragNodeId,
          cursor: world,
          target: target?.tile ?? null,
          shifted: target?.shifted ?? false,
        };
      } else if (this.renderer.movePreview) {
        this.renderer.movePreview = null;
      }
      // 反馈 #6：建造模式下实时预览落点（含因占用而移位后的真实位置）
      if (this.buildPanel.selectedType) {
        const placement = resolvePlacement(this.state, world.x, world.y);
        this.renderer.buildPreview = {
          cursor: world,
          target: placement ? placement.tile : null,
          shifted: placement?.shifted ?? false,
        };
      } else if (this.renderer.buildPreview) {
        this.renderer.buildPreview = null;
      }
    });

    canvas.addEventListener('pointerup', (e) => {
      if (e.pointerType === 'touch') {
        this.onTouchUp(e);
        return;
      }
      if (this.dragNodeId && this.dragPos) {
        const r = moveNode(this.state, this.dragNodeId, this.dragPos.x, this.dragPos.y);
        this.lastPointerDebug = `move-end:${r.ok ? (r.shifted ? 'shifted' : 'ok') : r.reason}`;
        if (r.ok) this.notice(r.shifted ? '已移动（落点被占用，已自动移到最近空位）' : '已移动');
        else this.notice('移动失败：周围没有空位');
        this.renderer.movePreview = null;
        this.dragNodeId = null;
        this.dragPos = null;
        if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
        return;
      }
      if (this.dragFrom && this.dragPos) {
        const target = this.nodeAt(this.dragPos.x, this.dragPos.y);
        if (target && target !== this.dragFrom) {
          const from = this.dragFrom;
          const r = buildLink(this.state, this.data, from, target);
          if (r.ok) this.notice('已连接：拓扑加成生效');
          else this.notice(r.reason === 'duplicate' ? '这两个节点已连接' : '无法连接');
          this.state.topoDirty = true;
        }
      }
      this.dragFrom = null;
      this.dragNodeId = null;
      this.dragPos = null;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    });

    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
        const cam = this.renderer.camera;
        cam.scale = Math.min(2.2, Math.max(0.35, cam.scale * factor));
      },
      { passive: false },
    );

    // 触控：捏合缩放要阻止浏览器自身的缩放与滚动（否则画布缩放会跟页面缩放抢）
    canvas.addEventListener('touchstart', (e) => {
      if (e.touches.length >= 2) e.preventDefault();
    }, { passive: false });
    canvas.addEventListener('touchmove', (e) => {
      if (e.touches.length >= 2) e.preventDefault();
    }, { passive: false });

    // 中键拖动平移
    let panning = false;
    let last = { x: 0, y: 0 };
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 1) return;
      panning = true;
      last = { x: e.clientX, y: e.clientY };
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!panning) return;
      const cam = this.renderer.camera;
      cam.x -= (e.clientX - last.x) / cam.scale;
      cam.y -= (e.clientY - last.y) / cam.scale;
      last = { x: e.clientX, y: e.clientY };
    });
    window.addEventListener('pointerup', () => {
      panning = false;
    });
    void wrap;
  }

  private nodeAt(wx: number, wy: number): string | null {
    let best: string | null = null;
    let bestD = Infinity;
    for (const node of this.state.graph.nodes.values()) {
      const dx = node.x - wx;
      const dy = node.y - wy;
      const d = dx * dx + dy * dy;
      const radius = (this.data.nodes.get(node.typeId)?.def.tier === 3 ? 24 : 18) + 6;
      if (d < radius * radius && d < bestD) {
        bestD = d;
        best = node.id;
      }
    }
    return best;
  }

  private observeResize(wrap: HTMLElement): void {
    const apply = (): void => {
      const rect = wrap.getBoundingClientRect();
      this.renderer.resize(rect.width, rect.height);
    };
    apply();
    new ResizeObserver(apply).observe(wrap);
    window.addEventListener('resize', apply);
  }

  private notice(msg: string): void {
    setText(this.noticeEl, msg);
    this.noticeEl.style.opacity = '1';
    window.clearTimeout((this.noticeEl as unknown as { _t?: number })._t);
    (this.noticeEl as unknown as { _t?: number })._t = window.setTimeout(() => {
      this.noticeEl.style.opacity = '0';
    }, 1800);
  }

  // ---------------------------------------------------------------- 主循环

  private frame = (now: number): void => {
    const cfg = this.data.config.simulation;
    const tickSeconds = cfg.tickRateMs / 1000;
    const realDt = Math.min((now - this.lastFrameTime) / 1000, this.data.config.antiCheat.maxSingleDeltaSec);
    this.lastFrameTime = now;
    this.accumulator += realDt;

    let steps = 0;
    while (this.accumulator >= tickSeconds && steps < cfg.maxStepsPerFrame) {
      const report = tick(this.state, this.data, tickSeconds, { mods: this.mods });
      this.lastThrottle = report.throttled;
      this.accumulator -= tickSeconds;
      steps++;
      if (report.unlockedLayers.length > 0) {
        for (const id of report.unlockedLayers) {
          this.notice(`解锁新基质层：${this.data.layers.get(id)?.name ?? id}`);
        }
      }
    }
    if (steps === cfg.maxStepsPerFrame) this.accumulator = 0; // 掉帧时丢弃积压，避免雪崩

    // ---- 自动化：每秒执行一次（内部遍历全部升级与节点，不宜每 tick 跑）
    if (this.state.elapsed >= this.nextAutomationAt && this.mods.autoTier > 0) {
      this.nextAutomationAt = this.state.elapsed + 1;
      const report = runAutomation(this.state, this.data, this.mods, this.state.elapsed);
      if (report.nextState) {
        this.state = report.nextState;
        this.mods = computeModifiers(this.state, this.data);
      }
      const lines = [...report.firedRules, ...report.actions];
      if (report.prestige) lines.push(`孢子化：+${SciNum.format(report.prestige.gain)} 孢子基因`);
      if (lines.length > 0) {
        this.automationLog.push(...lines);
        if (this.automationLog.length > 6) this.automationLog = this.automationLog.slice(-6);
        this.notice(`自动：${lines[0]}`);
      }
    }

    // 修饰符只在状态可能变化时重算（升级/科技购买后由面板触发）
    this.renderer.dragPreview =
      this.dragFrom && this.dragPos
        ? {
            from: this.state.graph.nodes.get(this.dragFrom) ?? null,
            to: this.dragPos,
          }
        : null;

    this.renderer.render(this.state, now);

    this.uiClock += realDt;
    if (this.uiClock >= 0.1) {
      this.uiClock = 0;
      this.syncUi();
      this.refreshProgressBadge();
      this.refreshStatusPanel();
    }
    this.autoSaver(now);
    this.stepSystems(realDt);
    this.flushPendingOffline();

    requestAnimationFrame(this.frame);
  };

  /** 供面板在购买后刷新修饰符 */
  refreshMods(): void {
    this.mods = computeModifiers(this.state, this.data);
  }

  /** 是否允许写存档（清档中 / 只读沙盒时禁止） */
  private shouldPersist(): boolean {
    return !this.suppressSave && !this.readOnlySandbox;
  }

  /** 立即保存（调试与端到端测试用；游戏内由自动保存与 beforeunload 负责） */
  saveNow(): void {
    if (!this.shouldPersist()) return;
    this.save.save(this.state, 'auto');
  }

  /**
   * 只读地重新读取自动存档（调试/测试用）。
   * 注意不能靠"篡改 localStorage 后 reload"来测 —— reload 会触发 beforeunload 的自动保存，
   * 把篡改内容覆盖掉，测试会假通过/假失败。
   */
  debugInspectSave(): { ok: boolean; tampered: boolean; warnings: string[] } {
    const outcome = this.save.load('auto');
    return { ok: outcome.state !== null, tampered: outcome.tampered, warnings: outcome.warnings };
  }

  /**
   * 调试：按指定时长模拟一次离线并弹出报告（走真实 settleOffline 路径）。
   * 用于验收截图与手感检查，不写入存档。
   */
  debugSimulateOffline(seconds: number): void {
    const report = settleOffline(this.state, this.data, Date.now() - seconds * 1000, Date.now());
    offlineReportModal(report);
  }

  /**
   * 每帧（或 demo 同步循环）都要推进的"系统层"：自动化 + 内容引擎。
   * 之所以抽出来，是因为 ?demo= 是同步跑的，早期版本只把它写在 frame 里，
   * 导致"机器人玩了两小时但成就 0/110"这种情况 —— 演示模式与真实游玩必须走同一条路径。
   */
  /** 救回存档后补弹离线报告（这一步必须在状态替换之后做） */
  private flushPendingOffline(): void {
    const rep = this.pendingOfflineReport;
    if (!rep) return;
    this.pendingOfflineReport = null;
    if (rep.settledSec > 5) {
      offlineReportModal(rep);
    }
  }

  private stepSystems(dt: number): void {
    // ---- 自动化：每秒一次（内部遍历全部升级与节点，不宜每 tick 跑）
    if (this.state.elapsed >= this.nextAutomationAt && this.mods.autoTier > 0) {
      this.nextAutomationAt = this.state.elapsed + 1;
      const report = runAutomation(this.state, this.data, this.mods, this.state.elapsed);
      if (report.nextState) {
        this.state = report.nextState;
        this.mods = computeModifiers(this.state, this.data);
      }
      const lines = [...report.firedRules, ...report.actions];
      if (report.prestige) lines.push(`孢子化：+${SciNum.format(report.prestige.gain)} 孢子基因`);
      if (lines.length > 0) {
        this.automationLog.push(...lines);
        if (this.automationLog.length > 6) this.automationLog = this.automationLog.slice(-6);
        this.emitNotice(`自动：${lines[0]}`);
      }
    }

    // ---- 内容引擎：事件 / 成就 / 任务（每 0.5 秒一轮，不进 tick 热路径）
    this.contentClock += dt;
    if (this.contentClock >= 0.5) {
      const dtContent = this.contentClock;
      this.contentClock = 0;
      const ctx = this.buildTriggerContext();

      const ev = tickEvents(this.state, this.data, dtContent, this.rng);
      for (const e of ev.started) this.emitNotice(`事件：${e.name} —— ${e.desc}`);

      // 菌市价格推进（与内容引擎同频；市场波动也是事件来源）
      tickMarket(this.state, this.data, dtContent, this.rng);

      const unlocked = checkAchievements(this.state, this.data, ctx);
      for (const id of unlocked) {
        const name = this.data.achievements.get(id)?.name ?? id;
        this.emitNotice(`成就解锁：${name}`);
        if (!this.quiet) celebrate('成就解锁', name, 'achievement');
      }

      const quests = checkQuests(this.state, this.data, ctx);
      for (const q of quests) {
        this.emitNotice(`任务完成：${q.name}（${q.rewardText}）`);
        if (!this.quiet) celebrate('任务完成', `${q.name} · ${q.rewardText}`, 'quest');
      }

      if (unlocked.length > 0 || quests.length > 0 || ev.started.length > 0) this.refreshMods();
    }

    // 记录自动化层级峰值与无操作时长（成就条件用）
    this.state.stats.maxAutoTier = Math.max(this.state.stats.maxAutoTier, Math.floor(this.mods.autoTier));
    this.state.stats.idleNoClickSec += dt;

    // ---- 资源飘字（反馈 #2：让"产出生效"看得见）。每 0.6 秒挑一个有产出的节点飘一个
    this.floatClock += dt;
    if (this.floatClock >= 0.6) {
      this.floatClock = 0;
      this.spawnAmbientFloat();
    }
  }

  /**
   * 系统状态区（反馈 #7："游戏后台的可操作性可视化"）——
   * 常驻画布右上角，回答"自动化在干什么 / 哪些节点停了 / 有什么事件在生效"。
   */
  private buildStatusPanel(): HTMLElement {
    return h(
      'div',
      {
        style: {
          position: 'absolute',
          right: '10px',
          top: '10px',
          maxWidth: '300px',
          padding: '8px 10px',
          background: 'rgba(14,17,22,0.88)',
          border: `1px solid ${THEME.border}`,
          borderRadius: '7px',
          fontSize: '11px',
          lineHeight: '1.7',
          color: THEME.textDim,
          pointerEvents: 'none',
        },
      },
      h('div', { style: { color: THEME.textFaint, letterSpacing: '0.1em', fontSize: '10px' }, text: '系统状态' }),
      h('div', { id: 'status-auto' }),
      h('div', { id: 'status-stalled' }),
      h('div', { id: 'status-event' }),
      h('div', { id: 'status-market' }),
    );
  }

  /** 刷新右上角状态区 */
  private refreshStatusPanel(): void {
    if (!this.statusEl) return;
    const tier = Math.floor(this.mods.autoTier);
    const autoEl = this.statusEl.querySelector('#status-auto') as HTMLElement | null;
    const stallEl = this.statusEl.querySelector('#status-stalled') as HTMLElement | null;
    const eventEl = this.statusEl.querySelector('#status-event') as HTMLElement | null;
    const marketEl = this.statusEl.querySelector('#status-market') as HTMLElement | null;

    if (autoEl) {
      const last = this.automationLog.at(-1);
      setText(autoEl, tier <= 0 ? '自动化：未解锁（科技树→自动化）' : `自动化 Lv${tier}${last ? `：${last}` : '：待命'}`);
    }
    if (stallEl) {
      const stalled = Object.values(this.lastThrottle).filter((r) => r < 1).length;
      setText(stallEl, stalled > 0 ? `缺料停工：${stalled} 个节点（黄色/红色状态点）` : '所有节点满速运行');
      stallEl.style.color = stalled > 0 ? THEME.warn : THEME.textDim;
    }
    if (eventEl) {
      const active = this.state.activeEvents;
      if (active.length === 0) {
        setText(eventEl, '当前无生效事件');
        eventEl.style.color = THEME.textDim;
      } else {
        // 显示"事件名 + 剩余时间 + **它到底改了什么**"。
        // 之前只写事件名，玩家看到"孢子云 120s"完全不知道它加了什么 ——
        // 这也是"做了跟没做一样"的成因之一。
        const parts = active.map((e) => {
          const def = this.data.events.find((x) => x.id === e.eventId);
          const left = Math.max(0, e.endsAt - this.state.elapsed);
          const effect = def ? describeEventEffect(def, this.data) : '';
          return `${def?.name ?? e.eventId}（${effect}）${Math.ceil(left)}s`;
        });
        setText(eventEl, `生效事件：${parts.join('｜')}`);
        eventEl.style.color = THEME.warn;
      }
    }
    if (marketEl) {
      const hot = Object.entries(this.state.market.entries)
        .map(([id, e]) => ({ id, delta: e.price / e.basePrice - 1 }))
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0];
      if (hot && Math.abs(hot.delta) > 0.08) {
        const name = this.data.resources.get(hot.id)?.def.name ?? hot.id;
        setText(marketEl, `菌市异动：${name} ${hot.delta > 0 ? '+' : ''}${(hot.delta * 100).toFixed(0)}%`);
        marketEl.style.color = hot.delta > 0 ? THEME.accent : THEME.danger;
      } else {
        setText(marketEl, '菌市平稳');
        marketEl.style.color = THEME.textDim;
      }
    }
  }

  /** 随机挑一个有在产出的节点，飘出它的一种产物速率 */
  private spawnAmbientFloat(): void {
    const candidates: { x: number; y: number; res: string; rate: SciNum }[] = [];
    for (const node of this.state.graph.nodes.values()) {
      if (!node.built || !node.active) continue;
      const def = this.data.nodes.get(node.typeId);
      if (!def || def.recipe.outputs.length === 0) continue;
      const out = def.recipe.outputs[0]!;
      candidates.push({ x: node.x, y: node.y, res: out.res, rate: out.rate });
      if (candidates.length >= 40) break;
    }
    if (candidates.length === 0) return;
    const pick = candidates[Math.floor(this.rng() * candidates.length)]!;
    const resDef = this.data.resources.get(pick.res);
    this.renderer.spawnFloat(pick.x, pick.y, `+${SciNum.format(pick.rate)}`, resDef?.def.color ?? THEME.accent);
  }

  /** 统一的通知出口：静默模式（demo/无头）下只入队，不写 DOM */
  private emitNotice(msg: string): void {
    if (this.quiet) {
      this.pendingNotices.push(msg);
      if (this.pendingNotices.length > 20) this.pendingNotices.shift();
      return;
    }
    this.notice(msg);
  }

  /**
   * 悬停 tooltip：类型名 + 配方摘要 + 当前运行比例 + 催化来源。
   * 图形负责“一眼知道是什么”，tooltip 负责“知道它现在怎么样”。
   */
  private updateTooltip(nodeId: string | null, clientX: number, clientY: number, world: { x: number; y: number }): void {
    void world;
    if (!nodeId) {
      this.tooltip.hide();
      return;
    }
    const node = this.state.graph.nodes.get(nodeId);
    const def = node ? this.data.nodes.get(node.typeId) : undefined;
    if (!node || !def) {
      this.tooltip.hide();
      return;
    }
    const layer = this.data.layers.get(node.layerId);
    const ratio = this.lastThrottle[nodeId];
    const cat = nodeCatalyst(this.state, this.data, nodeId);
    const resName = (id: string): string => this.data.resources.get(id)?.def.name ?? id;
    const resColor = (id: string): string => this.data.resources.get(id)?.def.color ?? THEME.textDim;
    const fmtRate = (r: SciNum): string => `${SciNum.format(r)}/s`;

    const recipeRows: TooltipRow[] = [
      ...def.recipe.inputs.map((i) => ({
        label: `输入 ${resName(i.res)}`,
        value: fmtRate(i.rate),
        dot: resColor(i.res),
      })),
      ...def.recipe.outputs.map((o) => ({
        label: `产出 ${resName(o.res)}`,
        value: fmtRate(o.rate),
        dot: resColor(o.res),
        tone: 'good' as const,
      })),
    ];
    if (!def.recipe.enzymePerSec.isZero()) {
      recipeRows.push({ label: '额外消耗 酶', value: fmtRate(def.recipe.enzymePerSec), dot: resColor('enzyme'), tone: 'bad' as const });
    }
    if (recipeRows.length === 0) {
      recipeRows.push({ label: '结构节点（无配方）', value: '—', tone: 'dim' as const });
    }

    const statusRows: TooltipRow[] = [
      ratio === undefined
        ? { label: '运行状态', value: '满速运行', tone: 'good' as const }
        : ratio <= 0
          ? { label: '运行状态', value: '停工（上游缺料）', tone: 'bad' as const }
          : { label: '运行状态', value: `降速 ${(ratio * 100).toFixed(0)}%`, tone: 'normal' as const },
    ];
    if (def.def.class !== 'extractor' && cat.bestRule) {
      statusRows.push({
        label: '催化倍率',
        value: `×${cat.rateMul.toFixed(3)}`,
        tone: cat.rateMul >= 1 ? ('good' as const) : ('bad' as const),
        note: cat.bestRule.note,
      });
    }
    if (def.def.class === 'extractor') {
      const base = layer?.richnessBase ?? 100;
      statusRows.push({
        label: '土壤富饶度',
        value: `${node.richness.toFixed(1)} / ${base}`,
        tone: node.richness / base > 0.6 ? ('good' as const) : node.richness / base > 0.3 ? ('normal' as const) : ('bad' as const),
      });
    }

    this.tooltip.show(clientX, clientY, {
      title: def.def.name,
      subtitle: `${def.def.class} · ${def.def.catalystTag} · ${layer?.name ?? node.layerId}（×${layer?.depthMul ?? '1'}）`,
      accent: nodeColor(node.typeId, def.def.class),
      sections: [
        { heading: '配方', rows: recipeRows },
        { heading: '状态', rows: statusRows },
      ],
    });
  }

  /** 节点右键菜单：删除（反馈 #5）。后续可扩展“从此节点起连线”等快捷操作 */
  private openNodeContextMenu(clientX: number, clientY: number, nodeId: string): void {
    const node = this.state.graph.nodes.get(nodeId);
    const def = node ? this.data.nodes.get(node.typeId) : undefined;
    if (!node || !def) return;
    const refundText = def.cost
      .map((c) => `${this.data.resources.get(c.res)?.def.name ?? c.res} +${SciNum.format(SciNum.mul(c.amount, 0.5))}`)
      .join('  ');
    const linkCount = this.state.graph.inLinkIds(nodeId).length + this.state.graph.outLinkIds(nodeId).length;

    this.showContextMenu(clientX, clientY, [
      {
        label: `删除 ${def.def.name}`,
        hint: `返还 ${refundText}${linkCount > 0 ? `，并断开 ${linkCount} 条连线` : ''}`,
        danger: true,
        onClick: () => {
          const r = demolishNode(this.state, this.data, nodeId);
          if (r.ok) {
            this.selectedNodeId = null;
            this.mods = computeModifiers(this.state, this.data);
            this.notice(`已拆除 ${def.def.name}，返还一半基础成本`);
          } else {
            this.notice(`拆除失败（${r.reason}）`);
          }
        },
      },
      { label: '取消', onClick: () => undefined },
    ]);
  }

  /**
   * 轻量上下文菜单（零依赖）。
   *
   * 关键修复（Bug 2）：早期版本用 `document.addEventListener('pointerdown', () => menu.remove(), { once: true })`，
   * 而浏览器的事件顺序是 pointerdown → pointerup → click —— 菜单在 pointerdown 就没了，
   * 按钮的 click 永远拿不到目标，所以“点删除没反应，只能用 Delete 键”。
   * 现在：只有点在菜单**外部**才关闭；菜单项用 once 标志兼容“只发 pointer 不发 click”的环境。
   */
  private showContextMenu(x: number, y: number, items: { label: string; hint?: string; danger?: boolean; onClick: () => void }[]): void {
    document.querySelectorAll('[data-ctx-menu]').forEach((el) => el.remove());

    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      menu.remove();
      document.removeEventListener('pointerdown', onDocPointerDown, true);
      window.removeEventListener('keydown', onKeyDown);
    };
    const onDocPointerDown = (ev: PointerEvent): void => {
      const target = ev.target as Node | null;
      if (target && menu.contains(target)) return; // 点在菜单内 → 交给菜单项自己处理
      close();
    };
    const onKeyDown = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') close();
    };

    const menu = h(
      'div',
      {
        'data-ctx-menu': '1',
        style: {
          position: 'fixed',
          left: `${Math.min(x, window.innerWidth - 260)}px`,
          top: `${Math.min(y, window.innerHeight - 120)}px`,
          zIndex: '60',
          minWidth: '220px',
          background: THEME.panel,
          border: `1px solid ${THEME.borderHover}`,
          borderRadius: '8px',
          padding: '4px',
          boxShadow: '0 12px 36px rgba(0,0,0,0.55)',
        },
      },
          ...items.map((it) => {
            // 同一项只触发一次（click 与 pointerup 兼容，见方法注释）
            let fired = false;
            const fire = (): void => {
              if (fired) return;
              fired = true;
              it.onClick();
              close();
            };
            return h(
              'button',
              {
                style: {
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  gap: '1px',
                  width: '100%',
                  padding: '6px 10px',
                  textAlign: 'left',
                  background: 'transparent',
                  border: 'none',
                  borderRadius: '5px',
                  cursor: 'pointer',
                  color: it.danger ? THEME.danger : THEME.text,
                  fontSize: '13px',
                },
                onmouseenter: (ev: Event) => {
                  (ev.currentTarget as HTMLElement).style.background = THEME.panelAlt;
                },
                onmouseleave: (ev: Event) => {
                  (ev.currentTarget as HTMLElement).style.background = 'transparent';
                },
                onclick: fire,
                // 兜底：某些环境（含部分无头/触控路径）可能不派发 click，用 pointerup 补上
                onpointerup: (ev: Event) => {
                  ev.stopPropagation();
                  fire();
                },
              },
              h('span', { text: it.label }),
              it.hint ? h('span', { style: { fontSize: '11px', color: THEME.textFaint }, text: it.hint }) : null,
            );
      }),
    );
    document.body.append(menu);
    // 捕获阶段监听：即使其它元素 stopPropagation 也能关掉菜单
    document.addEventListener('pointerdown', onDocPointerDown, true);
    window.addEventListener('keydown', onKeyDown);
  }

  /** Delete/Backspace 删除选中节点 */
  private handleDeleteKey(): void {
    const id = this.selectedNodeId;
    if (!id) return;
    const node = this.state.graph.nodes.get(id);
    const def = node ? this.data.nodes.get(node.typeId) : undefined;
    if (!node || !def) return;
    const r = demolishNode(this.state, this.data, id);
    if (r.ok) {
      this.selectedNodeId = null;
      this.mods = computeModifiers(this.state, this.data);
      this.notice(`已拆除 ${def.def.name}`);
    }
    void demolishLink;
  }

  /** 把引导高亮落到真实的 DOM 元素上 */
  private focusGuideTarget(target: GuideTarget | null): void {
    document.querySelectorAll('.guide-focus').forEach((el) => el.classList.remove('guide-focus'));
    if (!target) return;
    let el: Element | null = null;
    switch (target.kind) {
      case 'build':
        el = target.id
          ? this.buildPanel.el.querySelector(`[data-node-type="${target.id}"]`)
          : this.buildPanel.el;
        break;
      case 'upgrade':
        el = target.id
          ? this.inspector.el.querySelector(`[data-upgrade-id="${target.id}"]`)
          : this.inspector.el;
        break;
      case 'tech':
        el = target.id ? this.inspector.el.querySelector(`[data-tech-id="${target.id}"]`) : this.inspector.el;
        break;
      case 'canvas':
        el = this.renderer.element;
        break;
      default:
        el = null;
    }
    el?.classList.add('guide-focus');
  }

  /** 进度徒章：未读的成就/任务/事件数量（反馈 #7：让“有新东西”看得见） */
  private refreshProgressBadge(): void {
    if (!this.progressBadge) return;
    const s = this.state;
    const unread =
      Object.keys(s.achievements).length -
      this.lastSeenProgress.achievements +
      (s.stats.questsCompleted.length - this.lastSeenProgress.quests) +
      (s.stats.eventsSeen.length - this.lastSeenProgress.events);
    if (unread > 0) {
      this.progressBadge.style.display = '';
      setText(this.progressBadge, unread > 99 ? '99+' : String(unread));
    } else {
      this.progressBadge.style.display = 'none';
    }
  }

  /** 组装条件求值上下文（成就/任务共用） */
  private buildTriggerContext(): TriggerContext {
    return {
      ...EMPTY_TRIGGER_CONTEXT,
      elapsed: this.state.elapsed,
      offlineHours: this.state.stats.maxOfflineHours,
      combo: this.state.combo.stacks,
      challengesDone: this.state.stats.challengesCompleted.length,
      hardcoreChallenges: 0,
    };
  }

  /** 进度面板：成就 / 任务 / 事件总览 */
  private openProgressPanel(): void {
    const s = this.state;
    // 打开即视为已读（徒章清零）
    this.lastSeenProgress = {
      achievements: Object.keys(s.achievements).length,
      quests: s.stats.questsCompleted.length,
      events: s.stats.eventsSeen.length,
    };
    this.refreshProgressBadge();
    const achTotal = this.data.achievements.size;
    const achDone = Object.keys(s.achievements).length;
    const questTotal = this.data.quests.size;
    const questDone = s.stats.questsCompleted.length;

    const questList = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '3px', marginTop: '6px' } });
    for (const [id, quest] of this.data.quests) {
      const done = s.stats.questsCompleted.includes(id);
      const available = quest.requires.every((r) => s.stats.questsCompleted.includes(r));
      if (!done && !available) continue;
      questList.append(
        h(
          'div',
          { style: { display: 'flex', gap: '8px', fontSize: '12px', opacity: done ? '0.55' : '1' } },
          h('span', { style: { color: done ? THEME.accent : THEME.textDim }, text: done ? '✔' : '○' }),
          h('span', { style: { flex: '1' }, text: quest.name }),
          h('span', { style: { color: THEME.textFaint }, text: done ? '已完成' : (quest.desc ?? '') }),
        ),
      );
    }

    const recentEvents = s.stats.eventsSeen.slice(-6).map((id) => this.data.events.find((e) => e.id === id)?.name ?? id);

    // 图鉴：已发现的资源与节点类型（简版；物种图鉴随共生系统在后续批次补齐）
    const discoveredResources = [...this.data.resources.values()].filter(
      (r) => r.def.hidden !== true && ((s.totalProduced[r.def.id]?.isPositive() ?? false) || (s.resources[r.def.id]?.isPositive() ?? false)),
    ).length;
    const discoveredNodes = new Set([...s.graph.nodes.values()].map((n) => n.typeId)).size;

    showModal(
      '进度',
      h(
        'div',
        { style: { minWidth: '440px', fontSize: '13px', lineHeight: '1.7' } },
        h('div', { text: `成就：${achDone} / ${achTotal}` }),
        h('div', { text: `任务：${questDone} / ${questTotal}` }),
        h('div', { text: `经历过的事件：${s.stats.eventsSeen.length} / ${this.data.events.length}` }),
        h('div', { text: `图鉴：资源 ${discoveredResources} / ${this.data.resources.size}｜节点类型 ${discoveredNodes} / ${this.data.nodes.size}` }),
        h('div', { text: `世代：${s.prestige.count}｜孢子基因：${SciNum.format(s.prestige.sporogene)}` }),
        h('div', { style: { fontSize: '12px', color: THEME.textFaint, marginTop: '10px' }, text: '任务' }),
        questList,
        recentEvents.length > 0
          ? h('div', { style: { fontSize: '12px', color: THEME.textFaint, marginTop: '10px' }, text: `最近事件：${recentEvents.join('、')}` })
          : h('div'),
      ),
      [{ label: '关闭', primary: true }],
    );
  }

  /** 设置面板：存档管理 */
  private openSettings(): void {
    settingsModal({
      autoSaveInfo: () => this.save.autoSaveInfo(),
      onManualSave: () => {
        this.save.save(this.state, 'manual');
        this.notice('已保存到手动存档槽');
      },
      onExport: () => {
        const text = this.save.exportText(this.state);
        void navigator.clipboard?.writeText(text).then(
          () => this.notice(`存档已复制（${(text.length / 1024).toFixed(1)} KB）`),
          () => this.notice('剪贴板不可用，请使用导入框反向操作'),
        );
      },
      onImport: (text) => {
        const outcome = this.save.importText(text.trim());
        if (!outcome.state) {
          this.notice(outcome.tampered ? '导入失败：校验和不匹配' : `导入失败：${outcome.warnings[0] ?? '格式错误'}`);
          return;
        }
        this.save.save(outcome.state, 'auto');
        this.notice('导入成功，正在重新加载…');
        window.setTimeout(() => window.location.reload(), 400);
      },
      onClear: () => {
        // 顺序很重要：先停写 → 再清 key → 确认真的清了 → 才 reload
        // （否则 reload 触发的 beforeunload 会把状态写回，清档等于白做 —— Bug 3）
        this.suppressSave = true;
        this.save.clear();
        const cleared = this.save.autoSaveInfo() === null;
        if (!cleared) {
          this.suppressSave = false;
          this.notice('清档失败：浏览器存储不可写（隐私模式？）');
          return;
        }
        this.notice('存档已清空，正在重开…');
        window.setTimeout(() => window.location.reload(), 400);
      },
    });
  }

  /** 孢子面板（层级 Ⅰ–Ⅴ + 孢子化 + 菌株三合一） */
  openPrestigePanel(): void {
    showPrestigePanel({
      getState: () => this.state,
      getData: () => this.data,
      getMods: () => this.mods,
      commit: (next) => {
        this.state = next;
        this.mods = computeModifiers(this.state, this.data);
        this.saveNow();
        this.syncUi();
      },
      reopen: () => this.openPrestigePanel(),
    });
  }

  /** 挑战面板（30 条规则改写型挑战） */
  openChallengePanel(): void {
    openChallengePanel({
      getState: () => this.state,
      getData: () => this.data,
      commit: (next) => {
        this.state = next;
        this.mods = computeModifiers(this.state, this.data);
        this.saveNow();
        this.syncUi();
      },
      reopen: () => this.openChallengePanel(),
      notice: (msg) => this.notice(msg),
    });
  }

  /** 法则面板（Meta 层：改写公式） */
  openLawPanel(): void {
    openLawPanel({
      getState: () => this.state,
      getData: () => this.data,
      commit: (next) => {
        this.state = next;
        this.mods = computeModifiers(this.state, this.data);
        this.saveNow();
        this.syncUi();
      },
      reopen: () => this.openLawPanel(),
      notice: (msg) => this.notice(msg),
    });
  }

  /** 时间银行面板（惊喜机制） */
  openTimeBankPanel(): void {
    openTimeBankPanel({
      getState: () => this.state,
      getData: () => this.data,
      commit: (next) => {
        this.state = next;
        this.mods = computeModifiers(this.state, this.data);
        this.saveNow();
        this.syncUi();
      },
      reopen: () => this.openTimeBankPanel(),
      notice: (msg) => this.notice(msg),
    });
  }

  /** 供布局自检与端到端测试使用：当前是否处于触控连线等待状态 */
  get touchLinkFrom(): string | null {
    return this.touch.linkFrom;
  }

  // ---------------------------------------------------------------- 触控手势

  /**
   * 手指按下。三种情况：
   *   · 第二根手指落下 → 进入捏合缩放（取消长按与平移）
   *   · 单指落在节点上 → 记下来，可能是选中/连线，也可能是拖拽节点
   *   · 单指落在空白 → 可能是平移，也可能是长按弹菜单
   */
  private onTouchDown(e: PointerEvent): void {
    const t = this.touch;
    t.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (t.pointers.size === 2) {
      // 双指：进入捏合
      clearTimeout(t.longPressTimer);
      t.panning = false;
      t.moved = true; // 捏合期间不要触发轻点
      const pts = [...t.pointers.values()];
      t.pinchStartDist = Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y);
      t.pinchStartScale = this.renderer.camera.scale;
      return;
    }
    if (t.pointers.size > 2) return;

    const world = this.renderer.screenToWorld(e.clientX, e.clientY);
    t.startedAt = Date.now();
    t.startPos = { x: e.clientX, y: e.clientY };
    t.startCam = { x: this.renderer.camera.x, y: this.renderer.camera.y };
    t.moved = false;
    t.longPressFired = false;
    t.panning = true;

    // 长按 = 上下文菜单（替代右键）。移动超过阈值会取消它。
    clearTimeout(t.longPressTimer);
    t.longPressTimer = setTimeout(() => {
      if (t.moved) return;
      t.longPressFired = true;
      t.panning = false;
      const hit = this.nodeAt(world.x, world.y);
      if (hit) this.openNodeContextMenu(e.clientX, e.clientY, hit);
      else this.buildPanel.clearSelection();
    }, 500);
    void world;
  }

  /** 手指移动：单指平移画布，双指捏合缩放 */
  private onTouchMove(e: PointerEvent): void {
    const t = this.touch;
    if (!t.pointers.has(e.pointerId)) return;
    t.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // 双指捏合
    if (t.pointers.size >= 2) {
      const pts = [...t.pointers.values()];
      const dist = Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y);
      if (t.pinchStartDist > 0) {
        const ratio = dist / t.pinchStartDist;
        this.renderer.camera.scale = Math.min(2.2, Math.max(0.35, t.pinchStartScale * ratio));
      }
      return;
    }

    const dx = e.clientX - t.startPos.x;
    const dy = e.clientY - t.startPos.y;
    if (!t.moved && Math.hypot(dx, dy) > 8) {
      t.moved = true;
      clearTimeout(t.longPressTimer);
    }
    if (t.moved && t.panning && !t.longPressFired) {
      // 单指拖动 = 平移画布（手机替代中键）
      this.renderer.camera.x = t.startCam.x - dx / this.renderer.camera.scale;
      this.renderer.camera.y = t.startCam.y - dy / this.renderer.camera.scale;
    }
  }

  /**
   * 手指抬起。轻点（未移动、未长按）才是"选择"语义：
   *   · 建造模式 + 空白 → 放置节点
   *   · 点在节点上 → 若已有选中节点则**连成一条线**（点两点连线），否则选中它
   *   · 点在空白 → 取消选中
   */
  private onTouchUp(e: PointerEvent): void {
    const t = this.touch;
    const wasSingle = t.pointers.size === 1;
    t.pointers.delete(e.pointerId);
    clearTimeout(t.longPressTimer);

    if (!wasSingle || t.moved || t.longPressFired) {
      if (t.pointers.size === 0) {
        t.panning = false;
        t.pinchStartDist = 0;
      }
      return;
    }

    const world = this.renderer.screenToWorld(e.clientX, e.clientY);
    const hit = this.nodeAt(world.x, world.y);
    const pending = this.buildPanel.selectedType;

    // 建造模式：点空白即放置
    if (pending && !hit) {
      const reason = this.buildPanel.tryBuild(this.state, this.mods, pending, world.x, world.y);
      if (reason) this.notice(reason);
      else {
        this.mods = computeModifiers(this.state, this.data);
        this.notice('已建造');
      }
      return;
    }

    // 点在节点上
    if (hit) {
      const from = t.linkFrom;
      if (from && from !== hit) {
        // 点两点连线：第二个点到了就接线
        const r = buildLink(this.state, this.data, from, hit);
        if (r.ok) {
          this.notice('已连接：拓扑加成生效');
          this.state.topoDirty = true;
        } else if (r.reason === 'duplicate') {
          this.notice('这两个节点已经连着');
        } else {
          this.notice('无法连接');
        }
        t.linkFrom = null;
        this.selectedNodeId = hit;
        this.inspector.update(this.selectedNodeId);
        return;
      }
      // 第一次点节点：选中它，并把它作为连线起点
      this.selectedNodeId = hit;
      t.linkFrom = hit;
      this.inspector.update(this.selectedNodeId);
      this.notice('再点另一个节点即可连接');
      return;
    }

    // 点空白：取消选中与连线起点
    this.selectedNodeId = null;
    t.linkFrom = null;
  }


  getDebugInfo(): {
    nodes: { id: string; typeId: string; x: number; y: number; sx: number; sy: number }[];
    nodeCount: number;
    linkCount: number;
    tick: number;
    canvasRect: { left: number; top: number; width: number; height: number };
    buildButtons: { typeId: string; sx: number; sy: number }[];
    /** 建造模式的落点预览状态（反馈 #6 的验证点） */
    buildPreviewActive: boolean;
    buildPreviewTarget: { x: number; y: number } | null;
    /** 当前菌株（PHASE 4 批次 C） */
    strain: string | null;
    /** 已达成的 Prestige 层级 */
    prestigeLevel: number;
    /** 最近一次点击的处理结果（调试用） */
    lastPointerDebug: string;
  } {
    const rect = this.renderer.element.getBoundingClientRect();
    const cam = this.renderer.camera;
    const nodes = [...this.state.graph.nodes.values()].map((n) => ({
      id: n.id,
      typeId: n.typeId,
      x: n.x,
      y: n.y,
      sx: rect.left + rect.width / 2 + (n.x - cam.x) * cam.scale,
      sy: rect.top + rect.height / 2 + (n.y - cam.y) * cam.scale,
    }));
    const buildButtons: { typeId: string; sx: number; sy: number }[] = [];
    for (const btn of this.buildPanel.el.querySelectorAll<HTMLElement>('[data-node-type]')) {
      const r = btn.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const typeId = btn.dataset['nodeType'];
      if (typeId) buildButtons.push({ typeId, sx: r.left + r.width / 2, sy: r.top + r.height / 2 });
    }
    return {
      strain: this.state.prestige.strain,
      prestigeLevel: this.state.prestige.level,
      nodes,
      nodeCount: this.state.graph.size(),
      linkCount: this.state.graph.links.size,
      tick: this.state.tick,
      canvasRect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      buildButtons,
      buildPreviewActive: this.renderer.buildPreview?.cursor !== null && this.renderer.buildPreview?.cursor !== undefined,
      buildPreviewTarget: this.renderer.buildPreview?.target ?? null,
      lastPointerDebug: this.lastPointerDebug,
    };
  }
}
