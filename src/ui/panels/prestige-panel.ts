/**
 * 孢子面板（三合一）：层级进度 + 孢子化 + 菌株选择。
 *
 * 为什么合在一个面板里：这三件事回答的是同一个问题 ——"我接下来该重来、
 * 该换个活法、还是再攒一攒？"。分散在三个页面会让玩家在"该重置了吗"
 * 这个决策上失去上下文。
 *
 * 面板每次操作后整体重建（而不是局部刷新）：跃迁/孢子化/换菌株会同时改变
 * 层级、门槛进度与菌株可用性，局部刷新很容易出现"数字变了但按钮没变"。
 */

import { SciNum } from '../../core/math/scinum.ts';
import type { GameState } from '../../core/state.ts';
import type { GameData } from '../../core/types.ts';
import { advanceLayer, listLayers, type LayerInfo } from '../../core/prestige/layers.ts';
import { sporogeneGain, type ModifierSet } from '../../core/economy/engine.ts';
import { checkPrestige, doPrestige } from '../../core/prestige/prestige.ts';
import {
  formatDuration,
  listStrains,
  strainCooldownLeft,
  strainColor,
  switchStrain,
} from '../../core/prestige/strains.ts';
import { h } from '../dom.ts';
import { THEME } from '../theme.ts';
import { celebrate, showModal } from './modal.ts';

export interface PrestigePanelCallbacks {
  getState: () => GameState;
  getData: () => GameData;
  getMods: () => ModifierSet;
  /** 状态被替换后由 app 接手（重算修饰符、刷新 UI、写存档），然后重开面板 */
  commit: (next: GameState) => void;
  /** 重新打开面板（操作后调用） */
  reopen: () => void;
}

const LAYER_GLYPH = ['Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ'];

function box(children: HTMLElement[], accent: string = THEME.border): HTMLElement {
  return h(
    'div',
    {
      style: {
        border: `1px solid ${accent}`,
        borderRadius: '10px',
        padding: '12px 14px',
        marginBottom: '12px',
        background: 'rgba(255,255,255,0.02)',
      },
    },
    ...children,
  );
}

function line(label: string, value: string, tone: 'ok' | 'bad' | 'dim' = 'dim'): HTMLElement {
  const color = tone === 'ok' ? THEME.accent : tone === 'bad' ? THEME.danger : THEME.textDim;
  return h(
    'div',
    { style: { display: 'flex', justifyContent: 'space-between', gap: '12px', fontSize: '12px', lineHeight: '1.7' } },
    h('span', { style: { color: THEME.textDim }, text: label }),
    h('span', { style: { color }, text: value }),
  );
}

function actionButton(label: string, primary: boolean, enabled: boolean, onClick: () => void, title = ''): HTMLElement {
  return h('button', {
    text: label,
    ...(title ? { title } : {}),
    ...(enabled ? {} : { disabled: true }),
    style: {
      padding: '8px 16px',
      borderRadius: '8px',
      border: `1px solid ${primary && enabled ? THEME.accent : THEME.border}`,
      background: primary && enabled ? 'rgba(74,222,128,0.14)' : 'transparent',
      color: enabled ? (primary ? THEME.accent : THEME.text) : THEME.textDim,
      cursor: enabled ? 'pointer' : 'not-allowed',
      fontSize: '13px',
      opacity: enabled ? '1' : '0.6',
    },
    onclick: enabled ? onClick : undefined,
  });
}

function layerStrip(infos: LayerInfo[]): HTMLElement {
  return h(
    'div',
    { style: { display: 'flex', gap: '6px', alignItems: 'stretch', marginBottom: '12px' } },
    ...infos.map((info) => {
      const done = info.reached;
      const next = info.isNext;
      const color = done ? THEME.accent : next ? '#fbbf24' : THEME.textDim;
      return h(
        'div',
        {
          title: `${info.meta.name}：${info.meta.desc}`,
          style: {
            flex: '1',
            border: `1px solid ${done ? THEME.accent : next ? '#fbbf24' : THEME.border}`,
            borderRadius: '8px',
            padding: '8px 6px',
            textAlign: 'center',
            background: done ? 'rgba(74,222,128,0.08)' : next ? 'rgba(251,191,36,0.08)' : 'transparent',
            opacity: done || next ? '1' : '0.55',
          },
        },
        h('div', { style: { fontSize: '14px', color }, text: LAYER_GLYPH[info.meta.level - 1] ?? '?' }),
        h('div', { style: { fontSize: '11px', color, marginTop: '2px' }, text: info.meta.name }),
      );
    }),
  );
}

export function openPrestigePanel(cb: PrestigePanelCallbacks): void {
  const state = cb.getState();
  const data = cb.getData();
  const mods = cb.getMods();
  const infos = listLayers(state, data);

  const body = h('div', { style: { maxHeight: '62vh', overflowY: 'auto' } });

  // ---------------------------------------------------------------- 层级进度
  body.append(
    layerStrip(infos),
    h('div', {
      style: { fontSize: '11px', color: THEME.textDim, marginBottom: '10px' },
      text: '只有第 Ⅰ 层（孢子化）会焚毁网络；Ⅱ–Ⅴ 层是跃迁，消耗资源换取新的机制能力，不会重置你的网络。',
    }),
  );

  // ---------------------------------------------------------------- 下一个层级
  const next = infos.find((i) => i.isNext);
  if (next) {
    const rows: HTMLElement[] = [
      h('div', { style: { fontSize: '14px', color: '#fbbf24', marginBottom: '4px' }, text: `下一层：${next.meta.name}` }),
      h('div', { style: { fontSize: '12px', color: THEME.textDim, marginBottom: '8px' }, text: next.meta.desc }),
    ];
    for (const r of next.requirements) {
      rows.push(line(r.label, `${SciNum.format(r.have)} / ${SciNum.format(r.need)}`, r.ok ? 'ok' : 'bad'));
    }
    rows.push(
      h(
        'div',
        { style: { marginTop: '10px', display: 'flex', gap: '8px', alignItems: 'center' } },
        next.meta.isReset
          ? actionButton('去孢子化', false, true, () => cb.reopen(), '第 Ⅰ 层是一次重置，请用下方的孢子化按钮')
          : actionButton(
              `跃迁到 ${next.meta.name}`,
              true,
              next.ready,
              () => {
                const res = advanceLayer(state, data);
                if (!res.ok || !res.state) return;
                cb.commit(res.state);
                celebrate('层级跃迁', `${res.layer!.name} —— ${res.layer!.unlocks[0] ?? ''}`, 'prestige');
                cb.reopen();
              },
              next.reason,
            ),
      ),
    );
    if (!next.meta.isReset) rows.push(line('状态', next.reason, next.ready ? 'ok' : 'bad'));
    for (const u of next.meta.unlocks) rows.push(line('解锁', u));
    body.append(box(rows, next.ready && !next.meta.isReset ? THEME.accent : THEME.border));
  } else {
    body.append(box([h('div', { style: { fontSize: '13px', color: THEME.accent }, text: '已抵达最高层：星际播种。' })]));
  }

  // ---------------------------------------------------------------- 孢子化
  const check = checkPrestige(state, data);
  const gain = sporogeneGain(state, data, mods);
  const sporeRows: HTMLElement[] = [
    h('div', { style: { fontSize: '14px', color: THEME.text, marginBottom: '4px' }, text: '孢子化（第 Ⅰ 层）' }),
    line('当前世代', String(state.prestige.count)),
    line('本次可获得', `+${SciNum.format(gain)} 孢子基因`, 'ok'),
    line('成熟度', `${(check.maturity * 100).toFixed(0)}%（本轮越长折扣越小）`, check.maturity < 0.9 ? 'bad' : 'ok'),
    line('孢子基因总量', SciNum.format(state.prestige.sporogene)),
    h('div', {
      style: { fontSize: '11px', color: THEME.textDim, marginTop: '8px' },
      text: '重置：网络、节点、可见资源、非永久升级。保留：科技、机制升级、成就、菌株、自动化规则、任务加成。',
    }),
    h(
      'div',
      { style: { marginTop: '10px' } },
      actionButton(
        check.allowed ? '执行孢子化' : '条件未满足',
        true,
        check.allowed,
        () => {
          const r = doPrestige(state, data);
          cb.commit(r.state);
          celebrate('孢子化', `+${SciNum.format(r.report.gain)} 孢子基因（第 ${r.report.layer} 层）`, 'prestige');
          cb.reopen();
        },
        check.reason || '',
      ),
    ),
  ];
  if (!check.allowed) sporeRows.push(line('原因', check.reason, 'bad'));
  body.append(box(sporeRows, check.allowed ? '#c084fc' : THEME.border));

  // ---------------------------------------------------------------- 菌株
  const strains = listStrains(state, data);
  const cd = strainCooldownLeft(state, data);
  const strainRows: HTMLElement[] = [
    h('div', { style: { fontSize: '14px', color: THEME.text, marginBottom: '4px' }, text: '菌株（流派）' }),
    h('div', {
      style: { fontSize: '11px', color: THEME.textDim, marginBottom: '10px' },
      text:
        cd > 0
          ? `切换冷却中：剩余 ${formatDuration(cd)}（冷却不因孢子化重置）`
          : '切换会消耗基因片段，并改写游戏规则 —— 不是单纯的数值加成。',
    }),
  ];

  for (const s of strains) {
    const accent = s.active ? strainColor(s.def, 62) : THEME.border;
    const head = h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' } },
      h(
        'span',
        {
          style: {
            width: '22px',
            height: '22px',
            borderRadius: '6px',
            background: strainColor(s.def, 30),
            border: `1px solid ${strainColor(s.def)}`,
            color: strainColor(s.def),
            fontSize: '12px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flex: '0 0 auto',
          },
          text: s.def.glyph,
        },
      ),
      h('span', { style: { fontSize: '13px', color: THEME.text }, text: s.def.name }),
      h('span', { style: { fontSize: '11px', color: THEME.textDim }, text: s.def.tagline }),
      s.active ? h('span', { style: { fontSize: '11px', color: THEME.accent, marginLeft: 'auto' }, text: '正在表达' }) : h('span', { text: '' }),
    );

    const bullets = h(
      'div',
      { style: { fontSize: '11px', lineHeight: '1.7', color: THEME.textDim, marginBottom: '8px' } },
      ...s.def.ruleChanges.map((r) => h('div', { text: `· ${r}` })),
    );

    const foot = h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
      h('span', { style: { fontSize: '11px', color: THEME.textDim }, text: `表达成本：${SciNum.format(s.geneCost)} 基因片段` }),
      actionButton(
        s.active ? '已表达' : '表达这个菌株',
        false,
        s.selectable,
        () => {
          const res = switchStrain(state, data, s.def.id);
          if (!res.ok || !res.state) return;
          cb.commit(res.state);
          celebrate('菌株表达', s.def.name, 'prestige');
          cb.reopen();
        },
        s.reason,
      ),
    );
    if (!s.selectable && !s.active) {
      foot.append(h('span', { style: { fontSize: '11px', color: THEME.danger }, text: s.reason }));
    }

    strainRows.push(box([head, bullets, foot], accent));
  }
  body.append(h('div', {}, h('div', { style: { fontSize: '14px', color: THEME.text, marginBottom: '8px' }, text: strainRows[0] ? '' : '' }), ...strainRows));

  showModal('孢子与菌株', body, [{ label: '关闭', primary: true }]);
}
