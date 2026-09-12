/**
 * 通用信息浮层（Tooltip Card）。
 *
 * 为什么抽出组件：画布节点的 tooltip 原本直接写在 app.ts 里（含定位与边界翻转），
 * 现在建造列表、合成表都要用同一套视觉与定位规则 —— 继续复制会变成三份会漂移的实现。
 *
 * 定位统一用 `position: fixed` + clientX/clientY：
 *   · 画布、左侧面板、模态框里都能用同一份代码；
 *   · 贴边时自动翻到另一侧，永不出屏（这是原来那份实现里最容易写错的部分）。
 */

import { h } from '../dom.ts';
import { THEME } from '../theme.ts';

export interface TooltipRow {
  label: string;
  value: string;
  /** 左侧色点（通常是资源色） */
  dot?: string;
  /** 语义着色：good=够/正向，bad=缺/负向，dim=次要 */
  tone?: 'normal' | 'good' | 'bad' | 'dim';
  /** 第二行小字（例如说明或来源） */
  note?: string;
}

export interface TooltipSection {
  heading?: string;
  rows: TooltipRow[];
}

export interface TooltipContent {
  title: string;
  subtitle?: string;
  /** 标题左侧色点 */
  accent?: string;
  sections: TooltipSection[];
}

const TONE_COLOR: Record<string, string> = {
  normal: THEME.text,
  good: THEME.accent,
  bad: THEME.danger,
  dim: THEME.textDim,
};

export class TooltipCard {
  readonly el: HTMLElement;

  constructor() {
    this.el = h('div', {
      style: {
        position: 'fixed',
        display: 'none',
        zIndex: '45',
        pointerEvents: 'none',
        maxWidth: '340px',
        padding: '9px 11px',
        background: 'rgba(12,15,20,0.97)',
        border: `1px solid ${THEME.borderHover}`,
        borderRadius: '8px',
        boxShadow: '0 12px 34px rgba(0,0,0,0.6)',
        fontSize: '12px',
        lineHeight: '1.6',
        color: THEME.text,
      },
    });
  }

  get visible(): boolean {
    return this.el.style.display !== 'none';
  }

  show(clientX: number, clientY: number, content: TooltipContent): void {
    this.el.replaceChildren(...this.renderContent(content));
    this.el.style.display = '';
    this.place(clientX, clientY);
  }

  hide(): void {
    if (this.el.style.display === 'none') return;
    this.el.style.display = 'none';
  }

  private place(clientX: number, clientY: number): void {
    // 先放到屏幕外量一次尺寸，再决定翻转（避免读到旧尺寸导致抖动）
    this.el.style.left = '-9999px';
    this.el.style.top = '-9999px';
    const w = this.el.offsetWidth || 260;
    const hgt = this.el.offsetHeight || 140;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = clientX + 16;
    let top = clientY + 14;
    if (left + w > vw - 8) left = clientX - w - 16;
    if (top + hgt > vh - 8) top = clientY - hgt - 14;
    this.el.style.left = `${Math.max(8, Math.min(left, vw - w - 8))}px`;
    this.el.style.top = `${Math.max(8, Math.min(top, vh - hgt - 8))}px`;
  }

  private renderContent(content: TooltipContent): HTMLElement[] {
    const out: HTMLElement[] = [];

    out.push(
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
        content.accent
          ? h('span', {
              style: {
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                background: content.accent,
                flex: '0 0 8px',
              },
            })
          : null,
        h('span', { style: { fontSize: '13px', fontWeight: '600' }, text: content.title }),
      ),
    );
    if (content.subtitle) {
      out.push(h('div', { style: { fontSize: '11px', color: THEME.textFaint }, text: content.subtitle }));
    }

    for (const section of content.sections) {
      if (section.heading) {
        out.push(
          h('div', {
            style: {
              marginTop: '7px',
              marginBottom: '2px',
              fontSize: '10px',
              letterSpacing: '0.1em',
              color: THEME.textFaint,
            },
            text: section.heading,
          }),
        );
      }
      for (const row of section.rows) {
        out.push(
          h(
            'div',
            { style: { display: 'flex', alignItems: 'baseline', gap: '6px', fontSize: '12px' } },
            row.dot
              ? h('span', {
                  style: {
                    width: '6px',
                    height: '6px',
                    borderRadius: '50%',
                    background: row.dot,
                    flex: '0 0 6px',
                    alignSelf: 'center',
                  },
                })
              : null,
            h('span', { style: { color: THEME.textDim }, text: row.label }),
            h('span', {
              style: {
                marginLeft: 'auto',
                color: TONE_COLOR[row.tone ?? 'normal'] ?? THEME.text,
                fontVariantNumeric: 'tabular-nums',
                textAlign: 'right',
              },
              text: row.value,
            }),
          ),
        );
        if (row.note) {
          out.push(
            h('div', {
              style: { fontSize: '11px', color: THEME.textFaint, marginLeft: row.dot ? '12px' : '0' },
              text: row.note,
            }),
          );
        }
      }
    }
    return out;
  }
}
