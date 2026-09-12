/**
 * 自动化面板：展示六级自动化进度 + 规则编辑器。
 *
 * 规则编辑器用结构化下拉（条件 + 动作），不做文本解析 —— 玩家仍然在"编写生产 AI"，
 * 但每条规则天然可校验、可序列化，坏规则会在保存时被拒绝而不是在运行时静默失效。
 */

import { SciNum } from '../../core/math/scinum.ts';
import type { GameState } from '../../core/state.ts';
import type { GameData } from '../../core/types.ts';
import type { ModifierSet } from '../../core/economy/engine.ts';
import { describeRule, makeRule, validateRule, type AutoRule } from '../../core/automation/rules.ts';
import { checkPrestige } from '../../core/prestige/prestige.ts';
import { h, setText } from '../dom.ts';
import { THEME } from '../theme.ts';
import { showModal } from './modal.ts';

const TIER_NAMES = [
  '未解锁',
  '① 自动购买升级',
  '② 自动扩建',
  '③ 自动连线',
  '④ 自动优化',
  '⑤ 自动孢子化',
  '⑥ 规则引擎',
];

const COND_LABELS: Record<string, string> = {
  resourceGte: '资源 ≥ 阈值',
  resourceLte: '资源 ≤ 阈值',
  rateLt: '净产出为负',
  nodesGte: '节点数 ≥',
  nodesLte: '节点数 ≤',
  upgradeBelowMax: '升级未满级',
  always: '总是',
};

const ACT_LABELS: Record<string, string> = {
  build: '建造节点',
  upgrade: '购买升级',
  tech: '解锁科技',
  prestige: '孢子化',
  setNodeActive: '停用/启用节点',
};

export class AutomationPanel {
  private data: GameData;
  private getState: () => GameState;
  private getMods: () => ModifierSet;
  private onChange: () => void;

  constructor(
    data: GameData,
    getState: () => GameState,
    getMods: () => ModifierSet,
    onChange: () => void,
  ) {
    this.data = data;
    this.getState = getState;
    this.getMods = getMods;
    this.onChange = onChange;
  }

  open(): void {
    const state = this.getState();
    const mods = this.getMods();
    const tier = Math.floor(mods.autoTier);

    const header = h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '12px' } },
      h('div', { style: { fontSize: '13px' }, text: `当前层级：${TIER_NAMES[tier] ?? '?'}（自动化解锁于科技树的「自动化」分支）` }),
      h('div', {
        style: { fontSize: '11px', color: THEME.textFaint },
        text: '规则槽位由科技与信息素网络规模决定；优先级高于内置启发式。',
      }),
    );

    // 自动孢子化阈值
    const thresholdInput = h('input', {
      type: 'text',
      value: state.autoConfig.autoPrestigeThreshold,
      style: inputStyle(),
    }) as HTMLInputElement;
    thresholdInput.addEventListener('change', () => {
      const v = SciNum.from(thresholdInput.value);
      if (v.isNaN() || v.isNegative()) {
        thresholdInput.value = state.autoConfig.autoPrestigeThreshold;
        return;
      }
      state.autoConfig.autoPrestigeThreshold = thresholdInput.value;
      this.onChange();
    });

    const check = checkPrestige(state, this.data);
    const prestigeRow = h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: '8px', margin: '6px 0 14px' } },
      h('span', { style: { fontSize: '12px', color: THEME.textDim }, text: '自动孢子化阈值（孢子基因）' }),
      thresholdInput,
      h('span', {
        style: { fontSize: '11px', color: check.allowed ? THEME.accent : THEME.warn },
        text: check.allowed
          ? `当前可获得 ${SciNum.format(check.gain)}（成熟度 ${(check.maturity * 100).toFixed(0)}%）`
          : check.reason,
      }),
    );

    // 规则列表
    const ruleList = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '10px' } });
    if (state.autoRules.length === 0) {
      ruleList.append(h('div', { style: { fontSize: '12px', color: THEME.textFaint }, text: '还没有规则。示例：IF 孢子 ≤ 1000 THEN 建造 孢子囊 I' }));
    }
    for (const rule of state.autoRules) {
      const problem = validateRule(rule, this.data);
      const enabled = h('input', { type: 'checkbox' }) as HTMLInputElement;
      enabled.checked = rule.enabled;
      enabled.addEventListener('change', () => {
        rule.enabled = enabled.checked;
        this.onChange();
      });
      ruleList.append(
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '5px 8px',
              border: `1px solid ${problem ? THEME.danger : THEME.border}`,
              borderRadius: '5px',
              background: THEME.panelAlt,
            },
          },
          enabled,
          h('span', { style: { fontSize: '12px', flex: '1' }, text: describeRule(rule, this.data) }),
          h('span', {
            style: { fontSize: '10px', color: problem ? THEME.danger : THEME.textFaint },
            text: problem ?? `冷却 ${rule.cooldownSec}s`,
          }),
          h('button', {
            text: '删除',
            style: { ...smallBtnStyle(), borderColor: THEME.danger, color: THEME.danger },
            onclick: () => {
              state.autoRules = state.autoRules.filter((r) => r.id !== rule.id);
              this.onChange();
              this.open();
            },
          }),
        ),
      );
    }

    const addBtn = h('button', {
      text: '+ 添加规则',
      style: smallBtnStyle(),
      onclick: () => {
        if (state.autoRules.length >= Math.max(3, mods.ruleSlots)) {
          window.alert(`规则槽位不足（当前 ${Math.max(3, mods.ruleSlots)} 个）。解锁「规则引擎」系列科技可增加槽位。`);
          return;
        }
        this.openEditor(null);
      },
    });

    showModal(
      '自动化',
      h('div', { style: { minWidth: '460px' } }, header, prestigeRow, h('div', { style: { fontSize: '12px', color: THEME.textFaint, marginBottom: '6px' }, text: '规则' }), ruleList, addBtn),
      [{ label: '关闭', primary: true }],
    );
  }

  /** 规则编辑器（新建或修改） */
  private openEditor(existing: AutoRule | null): void {
    const state = this.getState();
    const rule = existing ?? makeRule({ id: `rule-${Date.now().toString(36)}`, name: `规则 ${state.autoRules.length + 1}` });

    const nameInput = h('input', { type: 'text', value: rule.name, style: inputStyle() }) as HTMLInputElement;
    const condSelect = select(Object.entries(COND_LABELS), rule.cond.kind);
    const resSelect = selectRes(this.data, rule.cond.res ?? 'spore');
    const valueInput = h('input', { type: 'text', value: rule.cond.value ?? '1000', style: inputStyle() }) as HTMLInputElement;
    const countInput = h('input', { type: 'number', value: String(rule.cond.count ?? 20), style: inputStyle() }) as HTMLInputElement;
    const upgradeSelect = select(
      [...this.data.upgrades.values()].map((u) => [u.def.id, u.def.name] as [string, string]),
      rule.cond.target ?? 'up_dec1_a',
    );

    const actSelect = select(Object.entries(ACT_LABELS), rule.act.kind);
    const targetSelect = h('select', { style: inputStyle() }) as HTMLSelectElement;
    const cooldownInput = h('input', { type: 'number', value: String(rule.cooldownSec), style: inputStyle() }) as HTMLInputElement;

    const syncTargets = (): void => {
      targetSelect.innerHTML = '';
      const kind = actSelect.value;
      const opts: [string, string][] =
        kind === 'build'
          ? [...this.data.nodes.values()].map((n) => [n.def.id, n.def.name] as [string, string])
          : kind === 'upgrade'
            ? [...this.data.upgrades.values()].map((u) => [u.def.id, u.def.name] as [string, string])
            : kind === 'tech'
              ? [...this.data.techs.values()].map((t) => [t.def.id, t.def.name] as [string, string])
              : [];
      for (const [v, label] of opts) {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = label;
        targetSelect.append(o);
      }
      if (rule.act.target) targetSelect.value = rule.act.target;
    };

    const syncCondFields = (): void => {
      const kind = condSelect.value;
      const needRes = kind === 'resourceGte' || kind === 'resourceLte' || kind === 'rateLt';
      const needValue = kind === 'resourceGte' || kind === 'resourceLte';
      const needCount = kind === 'nodesGte' || kind === 'nodesLte';
      const needUpgrade = kind === 'upgradeBelowMax';
      resSelect.style.display = needRes ? '' : 'none';
      valueInput.style.display = needValue ? '' : 'none';
      countInput.style.display = needCount ? '' : 'none';
      upgradeSelect.style.display = needUpgrade ? '' : 'none';
    };

    condSelect.addEventListener('change', syncCondFields);
    actSelect.addEventListener('change', syncTargets);
    syncCondFields();
    syncTargets();

    const errorEl = h('div', { style: { fontSize: '11px', color: THEME.danger, minHeight: '16px' } });

    showModal(
      existing ? '编辑规则' : '新建规则',
      h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '8px', minWidth: '420px' } },
        field('名称', nameInput),
        field('IF 条件', condSelect),
        field('资源', resSelect),
        field('阈值', valueInput),
        field('数量', countInput),
        field('升级', upgradeSelect),
        field('THEN 动作', actSelect),
        field('目标', targetSelect),
        field('冷却（秒）', cooldownInput),
        errorEl,
      ),
      [
        {
          label: '保存',
          primary: true,
          onClick: () => {
            const draft: AutoRule = {
              ...rule,
              name: nameInput.value.trim() || rule.name,
              cond: {
                kind: condSelect.value as AutoRule['cond']['kind'],
                res: resSelect.value,
                value: valueInput.value,
                count: Number(countInput.value) || 0,
                target: upgradeSelect.value,
              },
              act: {
                kind: actSelect.value as AutoRule['act']['kind'],
                target: targetSelect.value,
                active: true,
              },
              cooldownSec: Math.max(0, Number(cooldownInput.value) || 0),
            };
            const problem = validateRule(draft, this.data);
            if (problem) {
              setText(errorEl, problem);
              // 保存失败时把弹窗重新打开一次（showModal 会自动关闭）
              window.setTimeout(() => this.openEditor(draft), 0);
              return;
            }
            const idx = state.autoRules.findIndex((r) => r.id === draft.id);
            if (idx >= 0) state.autoRules[idx] = draft;
            else state.autoRules.push(draft);
            this.onChange();
            window.setTimeout(() => this.open(), 0);
          },
        },
        { label: '取消' },
      ],
    );
  }
}

function field(label: string, control: HTMLElement): HTMLElement {
  return h(
    'label',
    { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
    h('span', { style: { fontSize: '12px', color: THEME.textDim, minWidth: '84px' }, text: label }),
    control,
  );
}

function inputStyle(): Record<string, string> {
  return {
    flex: '1',
    background: THEME.panelAlt,
    color: THEME.text,
    border: `1px solid ${THEME.border}`,
    borderRadius: '4px',
    padding: '4px 6px',
    fontSize: '12px',
    fontFamily: THEME.font,
  };
}

function smallBtnStyle(): Record<string, string> {
  return {
    padding: '4px 10px',
    fontSize: '12px',
    background: THEME.panelAlt,
    color: THEME.text,
    border: `1px solid ${THEME.border}`,
    borderRadius: '5px',
    cursor: 'pointer',
  };
}

function select(options: [string, string][], current: string): HTMLSelectElement {
  const el = document.createElement('select');
  el.style.cssText = 'flex:1;background:#161a21;color:#d8dee9;border:1px solid #232a35;border-radius:4px;padding:4px 6px;font-size:12px';
  for (const [v, label] of options) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    el.append(o);
  }
  el.value = current;
  return el;
}

function selectRes(data: GameData, current: string): HTMLSelectElement {
  return select(
    [...data.resources.values()].map((r) => [r.def.id, r.def.name] as [string, string]),
    current,
  );
}
