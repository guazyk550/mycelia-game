/**
 * 新手引导（反馈 #3：「完全没有新手教程，以至于我完全不知道怎么玩」）。
 *
 * 数据来源是 data/quests.json 里已有的 12 条 tutorial 任务 —— 它们本来就在推进，
 * 只是玩家看不见。这个模块做三件事：
 *   1. 常驻引导卡：显示当前该做的下一步、完成条件与奖励；
 *   2. 目标高亮：把该点的地方（建造项 / 升级项 / 画布）用脉冲描边标出来；
 *   3. 开场三步覆盖层：首次进入时讲清核心循环（放置 → 连线 → 强化）。
 *
 * 玩家可以随时跳过，跳过状态记在 localStorage（属于 UI 偏好，不进存档）。
 */

import type { GameState } from '../../core/state.ts';
import type { GameData, QuestDef } from '../../core/types.ts';
import { h, setText } from '../dom.ts';
import { THEME } from '../theme.ts';

const SKIP_STEPS_KEY = 'mycelia.tutorial.skippedSteps';
const COLLAPSED_KEY = 'mycelia.tutorial.collapsed';
const SKIP_KEY = 'mycelia.tutorial.skipped';
const INTRO_KEY = 'mycelia.tutorial.introSeen';

export type GuideTargetKind = 'build' | 'upgrade' | 'tech' | 'canvas' | 'nav' | null;

export interface GuideTarget {
  kind: GuideTargetKind;
  /** build 用节点类型 id；upgrade/tech 用其 id；nav 用按钮文案 */
  id?: string;
  text: string;
}

/** 把任务目标翻译成"玩家该点哪里" */
export function resolveGuideTarget(quest: QuestDef, data: GameData): GuideTarget {
  const goal = quest.goal;
  switch (goal.kind) {
    case 'buildNode': {
      const nodeId = goal.node ?? '';
      const name = data.nodes.get(nodeId)?.def.name ?? nodeId;
      return { kind: 'build', id: nodeId, text: `在左侧点选「${name}」，然后在画布上点击放置` };
    }
    case 'buildAny':
      return { kind: 'build', text: '在左侧任意选择一种节点建造' };
    case 'links':
      return { kind: 'canvas', text: '按住 Shift 从一个节点拖拽到另一个节点即可连线' };
    case 'upgrades':
      return { kind: 'upgrade', text: '在右侧「强化 · 升级」里购买一个升级（绿色条标出可购买项）' };
    case 'techs':
      return { kind: 'tech', text: '在右侧切到「科技」页签，解锁一个科技' };
    case 'layer':
      return { kind: 'canvas', text: '继续生产资源，下层基质会自动解锁' };
    case 'resource':
      return {
        kind: null,
        text: `累积产出 ${data.resources.get(goal.res ?? '')?.def.name ?? goal.res} ${goal.amount}`,
      };
    default:
      return { kind: null, text: quest.desc };
  }
}

export class TutorialGuide {
  readonly el: HTMLElement;
  private data: GameData;
  private getState: () => GameState;
  private titleEl: HTMLElement;
  private bodyEl: HTMLElement;
  private rewardEl: HTMLElement;
  private progressEl: HTMLElement;
  private skipBtn: HTMLElement;
  private currentQuestId: string | null = null;
  /** 由 app 提供：把高亮类加到对应的 DOM 元素上 */
  onFocus: (target: GuideTarget | null) => void = () => {};

  constructor(data: GameData, getState: () => GameState) {
    this.data = data;
    this.getState = getState;
    this.skippedSteps = this.loadSkippedSteps();
    try {
      this.collapsed = localStorage.getItem(COLLAPSED_KEY) === '1';
    } catch {
      this.collapsed = false;
    }
    this.titleEl = h('div', { style: { fontSize: '13px', fontWeight: '600', color: THEME.accent } });
    this.bodyEl = h('div', { style: { fontSize: '12px', color: THEME.text, lineHeight: '1.6', marginTop: '3px' } });
    this.rewardEl = h('div', { style: { fontSize: '11px', color: THEME.textDim, marginTop: '4px' } });
    // 「怎么做」：这是引导卡里真正救人的那一行。
    // 玩家卡在"产出共生核心"时，需要的是"先等酶爬到 500"，而不是又一句世界观。
    this.hintEl = h('div', {
      style: {
        fontSize: '12px',
        color: THEME.text,
        lineHeight: '1.6',
        marginTop: '6px',
        padding: '6px 8px',
        borderRadius: '6px',
        background: 'rgba(255,255,255,0.05)',
        borderLeft: `2px solid #fbbf24`,
      },
    });
    this.progressEl = h('div', { style: { fontSize: '11px', color: THEME.textFaint, marginTop: '6px' } });
    // 收起/展开：手机上引导卡浮在画布上，展开时占据相当一块区域；
    // 玩家想看清网络时需要一个"收起来"的动作（收起后只留一行标题）。
    this.collapseBtn = h('button', {
      text: '收起',
      title: '收起引导卡，只留一行目标（再点一次展开）',
      style: {
        padding: '2px 8px',
        fontSize: '11px',
        background: 'transparent',
        color: THEME.textDim,
        border: `1px solid ${THEME.border}`,
        borderRadius: '4px',
        cursor: 'pointer',
        flex: '0 0 auto',
      },
      onclick: () => this.toggleCollapsed(),
    });
    // 逃生通道：卡住的人需要一条出路，否则引导就从"帮忙"变成"堵路"
    this.escapeRow = h(
      'div',
      { style: { display: 'flex', gap: '6px', marginTop: '8px' } },
      h('button', {
        text: '查看合成表',
        title: '打开合成表，看这个东西由谁产出、被谁消耗',
        style: {
          padding: '3px 10px',
          fontSize: '11px',
          background: 'transparent',
          color: THEME.accent,
          border: `1px solid ${THEME.border}`,
          borderRadius: '4px',
          cursor: 'pointer',
        },
        onclick: () => this.onOpenCodex(),
      }),
      h('button', {
        text: '跳过这一步',
        title: '卡住的步骤可以跳过（它不会自动完成，但不再挡着你）',
        style: {
          padding: '3px 10px',
          fontSize: '11px',
          background: 'transparent',
          color: THEME.textDim,
          border: `1px solid ${THEME.border}`,
          borderRadius: '4px',
          cursor: 'pointer',
        },
        onclick: () => this.skipStep(),
      }),
    );
    this.skipBtn = h('button', {
      text: '跳过引导',
      style: {
        marginTop: '8px',
        padding: '3px 10px',
        fontSize: '11px',
        background: 'transparent',
        color: THEME.textFaint,
        border: `1px solid ${THEME.border}`,
        borderRadius: '4px',
        cursor: 'pointer',
      },
      onclick: () => this.skip(),
    });

    this.el = h(
      'section',
      {
        class: 'tutorial-card',
        style: {
          border: `1px solid ${THEME.accent}`,
          borderRadius: '8px',
          padding: '10px 12px',
          marginBottom: '10px',
          background: 'linear-gradient(180deg, rgba(74,222,128,0.10), rgba(74,222,128,0.02))',
        },
      },
      // 标题行：左边"下一步"标签，右边收起按钮
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
        h('div', { style: { fontSize: '10px', letterSpacing: '0.14em', color: THEME.textFaint, flex: '1 1 auto' }, text: '下一步' }),
        this.collapseBtn,
      ),
      this.titleEl,
      // 收起时只隐藏这些（标题与收起按钮始终可见，玩家知道该做什么）
      this.bodyEl,
      this.hintEl,
      this.rewardEl,
      this.progressEl,
      this.escapeRow,
      this.skipBtn,
    );
    this.applyCollapsed();
  }

  /** 收起 / 展开引导卡（手机上很需要：展开时会盖住画布的很大一块） */
  private toggleCollapsed(): void {
    this.collapsed = !this.collapsed;
    try {
      localStorage.setItem(COLLAPSED_KEY, this.collapsed ? '1' : '0');
    } catch {
      /* 隐私模式忽略 */
    }
    this.applyCollapsed();
  }

  private applyCollapsed(): void {
    for (const el of [this.bodyEl, this.hintEl, this.rewardEl, this.progressEl, this.escapeRow, this.skipBtn]) {
      el.style.display = this.collapsed ? 'none' : '';
    }
    this.collapseBtn.textContent = this.collapsed ? '展开' : '收起';
  }

  /** 由 app 提供：当前展示任务的目标（供外部查询） */
  currentQuest(): QuestDef | null {
    return this.nextTutorialQuest();
  }

  /** 由 app 注入：打开合成表（逃生通道之一） */
  onOpenCodex: () => void = () => {};

  /** 跳过当前这一步：标记为已跳过（不写成"已完成"，因为玩家确实没做） */
  private skipStep(): void {
    const quest = this.nextTutorialQuest();
    if (!quest) return;
    this.skippedSteps.add(quest.id);
    try {
      localStorage.setItem(SKIP_STEPS_KEY, JSON.stringify([...this.skippedSteps]));
    } catch {
      /* 隐私模式忽略 */
    }
    this.currentQuestId = null;
    this.update();
  }

  private loadSkippedSteps(): Set<string> {
    try {
      const raw = localStorage.getItem(SKIP_STEPS_KEY);
      if (!raw) return new Set();
      const arr = JSON.parse(raw) as unknown;
      return new Set(Array.isArray(arr) ? (arr as string[]) : []);
    } catch {
      return new Set();
    }
  }

  private skippedSteps: Set<string>;
  /** 引导卡是否处于收起状态（手机上面板挤占画布，需要能收起来） */
  private collapsed = false;
  private collapseBtn: HTMLElement;
  private hintEl: HTMLElement;
  private escapeRow: HTMLElement;

  static isSkipped(): boolean {
    try {
      return localStorage.getItem(SKIP_KEY) === '1';
    } catch {
      return false;
    }
  }

  skip(): void {
    try {
      localStorage.setItem(SKIP_KEY, '1');
    } catch {
      /* 隐私模式忽略 */
    }
    this.el.style.display = 'none';
    this.onFocus(null);
  }

  /** 当前应展示的新手任务：第一个未完成、前置已完成、且未被跳过的 tutorial 任务 */
  private nextTutorialQuest(): QuestDef | null {
    const state = this.getState();
    for (const quest of this.data.quests.values()) {
      if (quest.cat !== 'tutorial') continue;
      if (state.stats.questsCompleted.includes(quest.id)) continue;
      if (this.skippedSteps.has(quest.id)) continue;
      if (quest.requires.some((r) => !state.stats.questsCompleted.includes(r) && !this.skippedSteps.has(r))) continue;
      return quest;
    }
    return null;
  }

  update(): void {
    if (TutorialGuide.isSkipped()) {
      this.el.style.display = 'none';
      return;
    }
    const quest = this.nextTutorialQuest();
    if (!quest) {
      // 新手任务全部完成 → 收起引导
      this.el.style.display = 'none';
      this.onFocus(null);
      return;
    }
    this.el.style.display = '';

    const state = this.getState();
    const done = this.data.quests.size > 0
      ? [...this.data.quests.values()].filter((q) => q.cat === 'tutorial').length
      : 0;
    const completedTutorial = [...this.data.quests.values()].filter(
      (q) => q.cat === 'tutorial' && state.stats.questsCompleted.includes(q.id),
    ).length;

    if (quest.id !== this.currentQuestId) {
      this.currentQuestId = quest.id;
      const target = resolveGuideTarget(quest, this.data);
      setText(this.titleEl, quest.name);
      setText(this.bodyEl, target.text);
      // 「怎么做」优先展示；没有 hint 的旧数据回退到氛围描述
      const hintText = quest.hint ?? quest.desc ?? '';
      setText(this.hintEl, hintText);
      this.hintEl.style.display = hintText ? '' : 'none';
      setText(this.rewardEl, `奖励：${quest.reward.desc ?? quest.desc ?? ''}`);
      this.onFocus(target);
    }
    setText(this.progressEl, `新手任务 ${completedTutorial} / ${done}`);
  }

  /** 开场三步覆盖层（只在首次进入时出现） */
  showIntroIfNeeded(onStart: () => void): void {
    let seen = false;
    try {
      seen = localStorage.getItem(INTRO_KEY) === '1';
    } catch {
      seen = true;
    }
    if (seen || TutorialGuide.isSkipped()) return;

    const step = (n: string, title: string, text: string): HTMLElement =>
      h(
        'div',
        { style: { display: 'flex', gap: '10px', alignItems: 'flex-start' } },
        h('span', {
          style: {
            flex: '0 0 22px',
            height: '22px',
            borderRadius: '50%',
            background: 'rgba(74,222,128,0.15)',
            border: `1px solid ${THEME.accent}`,
            color: THEME.accent,
            fontSize: '12px',
            display: 'grid',
            placeItems: 'center',
          },
          text: n,
        }),
        h(
          'div',
          {},
          h('div', { style: { fontSize: '13px', color: THEME.text, fontWeight: '600' }, text: title }),
          h('div', { style: { fontSize: '12px', color: THEME.textDim, marginTop: '2px' }, text }),
        ),
      );

    const overlay = h(
      'div',
      {
        'data-intro': '1',
        style: {
          // 开场引导层同样要避开底部导航：它铺满全屏时会把导航整个盖住，
          // 玩家点不到任何入口（q_try_challenge 这类引导甚至会指向"打开某个面板"）。
          position: 'fixed',
          left: '0',
          right: '0',
          top: '0',
          bottom: 'var(--nav-h, 0px)',
          zIndex: '80',
          display: 'grid',
          placeItems: 'center',
          background: 'rgba(4,5,7,0.78)',
        },
      },
      h(
        'div',
        {
          style: {
            // 手机上必须能缩到视口以内：写死 520px 会让 390px 屏幕上的按钮跑到 x=495（点不到）
            width: 'min(520px, calc(100vw - 24px))',
            maxHeight: 'calc(100dvh - 40px)',
            overflowY: 'auto',
            padding: '22px 24px',
            background: THEME.panel,
            border: `1px solid ${THEME.borderHover}`,
            borderRadius: '12px',
            boxShadow: '0 24px 70px rgba(0,0,0,0.65)',
            display: 'flex',
            flexDirection: 'column',
            gap: '14px',
          },
        },
        h('div', { style: { fontSize: '18px', color: THEME.text, fontWeight: '600' }, text: '你是一颗孢子' }),
        h('div', {
          style: { fontSize: '13px', color: THEME.textDim, lineHeight: '1.7' },
          text: '任务不是把东西堆得更多，而是把节点连得更聪明。同样的节点，连法不同，产出能差好几倍。',
        }),
        step('1', '放下第一根菌丝', '在左侧选一种节点，然后在中央画布上点击放置。'),
        step('2', '把它们连起来', '把两个节点分别点一下就能连线（桌面端也可以按住 Shift 从 A 拖到 B）。上游会催化下游 —— 这是本作的核心。'),
        step('3', '观察与强化', '顶部看资源增长，右侧买入升级。任务卡会一直告诉你下一步做什么。'),
        h(
          'div',
          {
            style: {
              display: 'flex',
              justifyContent: 'flex-end',
              gap: '8px',
              marginTop: '4px',
              // 换行：两个按钮在窄屏上排不下时自动落到下一行，而不是被挤到屏幕外
              flexWrap: 'wrap',
            },
          },
          h('button', {
            text: '我自己摸索',
            style: {
              padding: '7px 14px',
              fontSize: '13px',
              background: 'transparent',
              color: THEME.textDim,
              border: `1px solid ${THEME.border}`,
              borderRadius: '6px',
              cursor: 'pointer',
            },
            onclick: () => {
              try {
                localStorage.setItem(SKIP_KEY, '1');
              } catch {
                /* 忽略 */
              }
              overlay.remove();
            },
          }),
          h('button', {
            text: '开始生长',
            style: {
              padding: '7px 18px',
              fontSize: '13px',
              background: 'rgba(74,222,128,0.14)',
              color: THEME.accent,
              border: `1px solid ${THEME.accent}`,
              borderRadius: '6px',
              cursor: 'pointer',
            },
            onclick: () => {
              try {
                localStorage.setItem(INTRO_KEY, '1');
              } catch {
                /* 忽略 */
              }
              overlay.remove();
              onStart();
            },
          }),
        ),
      ),
    );
    document.body.append(overlay);
  }
}
