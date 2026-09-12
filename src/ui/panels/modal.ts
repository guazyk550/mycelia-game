/**
 * 极简模态框：离线报告、设置、导入/导出都用它。
 * 不引入 UI 库，保持零运行时依赖。
 */

import { SciNum } from '../../core/math/scinum.ts';
import type { OfflineReport } from '../../core/offline/settle.ts';
import { h } from '../dom.ts';
import { THEME } from '../theme.ts';

export function showModal(title: string, body: HTMLElement, actions: { label: string; primary?: boolean; onClick?: () => void }[] = []): () => void {
  // 同一时刻只允许一个模态框：否则“展开/重新打开”这类操作会把面板一层层叠上去
  document.querySelectorAll('[data-modal]').forEach((el) => el.remove());
  const close = (): void => {
    overlay.remove();
    window.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
  };

  const overlay = h(
    'div',
    {
      'data-modal': '1',
      style: {
        // 手机竖屏：遮罩不要盖住底部导航，否则"打开一个面板后就切不到别的面板了"
        // （真机反馈"很多菜单按钮点不到"的主因之一）。
        // --nav-h 由 app 在挂载时写入，桌面端为 0（不影响原行为）。
        position: 'fixed',
        left: '0',
        right: '0',
        top: '0',
        bottom: 'var(--nav-h, 0px)',
        background: 'rgba(4,5,7,0.72)',
        display: 'grid',
        placeItems: 'center',
        zIndex: '50',
      },
      onclick: (e: MouseEvent) => {
        if (e.target === overlay) close();
      },
    },
    h(
      'div',
      {
        style: {
          // 手机上必须能缩到视口以内：写死 minWidth: 420px 会让 390px 宽的屏幕溢出。
          // dvh 而不是 vh：手机浏览器的地址栏会收缩，vh 会算错。
          display: 'flex',
          flexDirection: 'column',
          // overflow: hidden 是让"中间内容滚动、头尾固定"真正生效的关键：
          // 没有它，flex 子项会撑破 maxHeight，把底部按钮顶到导航栏下面（真机点不到）。
          overflow: 'hidden',
          minWidth: 'min(420px, calc(100vw - 20px))',
          maxWidth: 'min(620px, calc(100vw - 20px))',
          maxHeight: 'min(80vh, calc(100dvh - 20px))',
          background: THEME.panel,
          border: `1px solid ${THEME.borderHover}`,
          borderRadius: '10px',
          padding: '18px 20px',
          boxShadow: '0 18px 60px rgba(0,0,0,0.6)',
        },
      },
      // 标题与按钮固定在两端，只有中间的内容滚动 ——
      // 否则内容一长，底部的"关闭/确认"就被挤出屏幕（真机反馈过这个问题）
      h('div', {
        style: { fontSize: '16px', marginBottom: '10px', color: THEME.text, flex: '0 0 auto' },
        text: title,
      }),
      h('div', { style: { overflowY: 'auto', flex: '1 1 auto', minHeight: '0' } }, body),
      h(
        'div',
        {
          style: {
            display: 'flex',
            gap: '8px',
            justifyContent: 'flex-end',
            marginTop: '14px',
            flex: '0 0 auto',
            flexWrap: 'wrap',
          },
        },
        ...actions.map((a) =>
          h('button', {
            text: a.label,
            style: {
              padding: '6px 16px',
              fontSize: '13px',
              borderRadius: '6px',
              cursor: 'pointer',
              border: `1px solid ${a.primary ? THEME.accent : THEME.border}`,
              background: a.primary ? 'rgba(74,222,128,0.12)' : THEME.panelAlt,
              color: a.primary ? THEME.accent : THEME.text,
            },
            onclick: () => {
              a.onClick?.();
              close();
            },
          }),
        ),
      ),
    ),
  );

  window.addEventListener('keydown', onKey);
  document.body.append(overlay);
  return close;
}

/**
 * 里程碑庆祝（反馈 #2：需要视觉冲击力）。
 * 自上滑入的卡片 + 全屏边缘泛光，2.6 秒后自动消失，不阻塞任何操作。
 */
export function celebrate(title: string, subtitle: string, kind: 'achievement' | 'quest' | 'prestige' = 'achievement'): void {
  const palette = {
    achievement: { accent: '#fbbf24', glow: 'rgba(251,191,36,0.30)', icon: '★' },
    quest: { accent: '#4ade80', glow: 'rgba(74,222,128,0.30)', icon: '✓' },
    prestige: { accent: '#c084fc', glow: 'rgba(192,132,252,0.35)', icon: '✿' },
  }[kind];

  const card = h(
    'div',
    {
      style: {
        position: 'fixed',
        left: '50%',
        top: '84px',
        transform: 'translate(-50%, -18px)',
        opacity: '0',
        zIndex: '70',
        pointerEvents: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '10px 18px',
        background: 'rgba(14,17,22,0.97)',
        border: `1px solid ${palette.accent}`,
        borderRadius: '10px',
        boxShadow: `0 14px 40px rgba(0,0,0,0.6), 0 0 0 1px ${palette.glow}`,
        transition: 'transform 260ms cubic-bezier(0.2,0.9,0.3,1.2), opacity 260ms ease',
      },
    },
    h('span', { style: { fontSize: '20px', color: palette.accent }, text: palette.icon }),
    h(
      'div',
      { style: { display: 'flex', flexDirection: 'column' } },
      h('span', { style: { fontSize: '11px', color: THEME.textDim, letterSpacing: '0.08em' }, text: title }),
      h('span', { style: { fontSize: '15px', color: THEME.text, fontWeight: '600' }, text: subtitle }),
    ),
  );

  const glow = h('div', {
    style: {
      position: 'fixed',
      inset: '0',
      zIndex: '65',
      pointerEvents: 'none',
      opacity: '0',
      boxShadow: `inset 0 0 140px ${palette.glow}`,
      transition: 'opacity 220ms ease',
    },
  });

  document.body.append(glow, card);
  requestAnimationFrame(() => {
    card.style.transform = 'translate(-50%, 0)';
    card.style.opacity = '1';
    glow.style.opacity = '1';
  });
  window.setTimeout(() => {
    glow.style.opacity = '0';
  }, 620);
  window.setTimeout(() => {
    card.style.opacity = '0';
    card.style.transform = 'translate(-50%, -14px)';
    window.setTimeout(() => {
      card.remove();
      glow.remove();
    }, 320);
  }, 2600);
}

/** 「离线期间发生了什么」报告（GDD §20 要求玩家有回来看一眼的动力） */
export function offlineReportModal(report: OfflineReport, onClose?: () => void): void {
  const fmtDuration = (sec: number): string => {
    if (sec < 90) return `${Math.round(sec)} 秒`;
    if (sec < 5400) return `${(sec / 60).toFixed(1)} 分钟`;
    return `${(sec / 3600).toFixed(2)} 小时`;
  };

  const rows: HTMLElement[] = [];
  rows.push(
    h(
      'div',
      { style: { fontSize: '13px', color: THEME.textDim, marginBottom: '10px' } },
      `离线 ${fmtDuration(report.rawSec)}` +
        (report.settledSec < report.rawSec ? `（计入上限 ${fmtDuration(report.settledSec)}）` : '') +
        ` ｜ 效率 ${(report.efficiency * 100).toFixed(0)}%`,
    ),
  );

  const gained = Object.entries(report.gained).filter(([, v]) => v.isPositive());
  if (gained.length > 0) {
    const list = h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 18px' } });
    for (const [id, v] of gained) {
      list.append(
        h(
          'div',
          { style: { display: 'flex', justifyContent: 'space-between', fontSize: '12px' } },
          h('span', { style: { color: THEME.textDim }, text: id }),
          h('span', { style: { color: THEME.accent, fontVariantNumeric: 'tabular-nums' }, text: `+${SciNum.format(v)}` }),
        ),
      );
    }
    rows.push(h('div', { style: { fontSize: '12px', color: THEME.textFaint, margin: '6px 0 4px' }, text: '产出' }), list);
  } else {
    rows.push(h('div', { style: { fontSize: '12px', color: THEME.textFaint, text: '网络处于停工状态，没有产出。检查是否缺料。' } }));
  }

  if (report.events.length > 0) {
    const ev = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '3px', marginTop: '10px' } });
    for (const e of report.events) {
      ev.append(h('div', { style: { fontSize: '12px', color: THEME.warn }, text: `• ${e}` }));
    }
    rows.push(h('div', { style: { fontSize: '12px', color: THEME.textFaint, marginTop: '10px' }, text: '离线期间发生了什么' }), ev);
  }

  showModal('欢迎回来', h('div', {}, ...rows), [{ label: '继续生长', primary: true, onClick: onClose }]);
}

/** 设置面板：存档管理 */
export function settingsModal(opts: {
  autoSaveInfo: () => { bytes: number; savedAt: Date } | null;
  onManualSave: () => void;
  onExport: () => void;
  onImport: (text: string) => void;
  onClear: () => void;
}): void {
  const info = opts.autoSaveInfo();
  const infoEl = h('div', {
    style: { fontSize: '12px', color: THEME.textDim, marginBottom: '12px' },
    text: info
      ? `自动存档：${info.savedAt.toLocaleString()}（${(info.bytes / 1024).toFixed(1)} KB）`
      : '尚无自动存档',
  });

  const textarea = h('textarea', {
    placeholder: '把存档文本粘贴到这里，然后点击「导入」',
    style: {
      width: '100%',
      height: '110px',
      background: THEME.panelAlt,
      color: THEME.text,
      border: `1px solid ${THEME.border}`,
      borderRadius: '6px',
      padding: '8px',
      fontSize: '11px',
      fontFamily: THEME.fontMono,
      resize: 'vertical',
    },
  });

  showModal(
    '设置 · 存档',
    h(
      'div',
      {},
      infoEl,
      h('div', { style: { fontSize: '12px', color: THEME.textFaint, marginBottom: '6px' }, text: '导出 / 导入' }),
      textarea,
      h('div', { style: { display: 'flex', gap: '8px', marginTop: '8px', flexWrap: 'wrap' } },
        h('button', {
          text: '立即保存',
          style: btnStyle(),
          onclick: () => opts.onManualSave(),
        }),
        h('button', {
          text: '复制存档到剪贴板',
          style: btnStyle(),
          onclick: () => opts.onExport(),
        }),
        h('button', {
          text: '导入上方文本',
          style: btnStyle(),
          onclick: () => opts.onImport(textarea.value),
        }),
        h('button', {
          text: '清空存档并重开',
          style: { ...btnStyle(), borderColor: THEME.danger, color: THEME.danger },
          onclick: () => opts.onClear(),
        }),
      ),
    ),
    [{ label: '关闭' }],
  );
}

function btnStyle(): Record<string, string> {
  return {
    padding: '5px 12px',
    fontSize: '12px',
    background: THEME.panelAlt,
    color: THEME.text,
    border: `1px solid ${THEME.border}`,
    borderRadius: '5px',
    cursor: 'pointer',
  };
}
