/**
 * 轻量 DOM 工具：不引入框架，保持零运行时依赖。
 */

type Props = Record<string, unknown>;
type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'style' && typeof v === 'object') Object.assign(el.style, v as object);
    else if (k === 'class') el.className = String(v);
    else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === 'text') el.textContent = String(v);
    else el.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

export function clear(el: HTMLElement): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** 只在文本真的变化时写 DOM（避免每帧触发布局） */
export function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

export function setStyle(el: HTMLElement, prop: string, value: string): void {
  const cur = el.style.getPropertyValue(prop);
  if (cur !== value) el.style.setProperty(prop, value);
}

/**
 * 购买/解锁的反馈脉冲（反馈 #2：点击"绵软无力"）。
 * 成功扩散绿环、失败横向抖动；动画类名定义在 index.html，受 prefers-reduced-motion 约束。
 */
export function pulse(el: HTMLElement, ok = true): void {
  const cls = ok ? 'pulse-ok' : 'pulse-fail';
  el.classList.remove(cls);
  // 强制重排，让同一个元素连续点击时动画也能重播
  void el.offsetWidth;
  el.classList.add(cls);
  window.setTimeout(() => el.classList.remove(cls), ok ? 560 : 320);
}

/** 数字跳动：值变化时放大一下（用于顶部资源条与关键数值） */
export function bump(el: HTMLElement): void {
  el.style.transition = 'transform 90ms ease';
  el.style.transform = 'scale(1.14)';
  window.setTimeout(() => {
    el.style.transform = 'scale(1)';
  }, 100);
}
