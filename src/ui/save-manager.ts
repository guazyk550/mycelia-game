/**
 * 存档管理器：localStorage 自动保存 + 手动导出/导入 + 离线结算的串接。
 *
 * 职责边界：这里只做"存取与调度"，不做数值计算（那是 core/save 与 core/offline 的事）。
 */

import type { GameState } from '../core/state.ts';
import type { GameData } from '../core/types.ts';
import { loadFromJson, makeSaveFile, saveToJson } from '../core/save/save.ts';
import { settleOffline, type OfflineReport } from '../core/offline/settle.ts';
import { deleteSave, idbGet, writeSave } from './persist.ts';

const AUTO_KEY = 'mycelia.save.auto';
const MANUAL_KEY = 'mycelia.save.manual';

export interface LoadOutcome {
  state: GameState | null;
  offline: OfflineReport | null;
  warnings: string[];
  /** 存档被判定为篡改（只读沙盒模式，不覆盖原档） */
  tampered: boolean;
}

export class SaveManager {
  private data: GameData;

  constructor(data: GameData) {
    this.data = data;
  }

  /**
   * 读取并结算（同步，走 localStorage）。
   *
   * IndexedDB 不在这里读：启动路径必须是同步的，否则整个 App 初始化要改成异步。
   * 它的角色是"**写入备份 + localStorage 被清空后的救援路径**"（见 recoverFromIdb）。
   */
  load(prefer: 'auto' | 'manual' = 'auto'): LoadOutcome {
    const raw = this.rawFromLocalStorage(prefer);
    return this.parseRaw(raw);
  }

  /**
   * localStorage 里没有存档时，尝试从 IndexedDB 救回一份。
   *
   * 真实场景：Android WebView 被系统清理了 localStorage（很常见），
   * 但 IndexedDB 还在。没有这条路径的话，玩家会看到"存档凭空消失"。
   */
  async recoverFromIdb(prefer: 'auto' | 'manual' = 'auto'): Promise<LoadOutcome | null> {
    const key = prefer === 'manual' ? MANUAL_KEY : AUTO_KEY;
    const raw = await idbGet(key);
    if (!raw) return null;
    // 救回来的那份写回 localStorage，让后续的同步读取也能看到
    try {
      localStorage.setItem(key, raw);
    } catch {
      /* 忽略 */
    }
    return this.parseRaw(raw);
  }

  private rawFromLocalStorage(prefer: 'auto' | 'manual'): string | null {
    try {
      return localStorage.getItem(prefer === 'manual' ? MANUAL_KEY : AUTO_KEY);
    } catch {
      return null;
    }
  }

  private parseRaw(raw: string | null): LoadOutcome {
    if (!raw) return { state: null, offline: null, warnings: [], tampered: false };
    const result = loadFromJson(raw, this.data);
    if (!result.ok || !result.state) {
      return { state: null, offline: null, warnings: result.warnings, tampered: result.tampered };
    }
    const offline = settleOffline(result.state, this.data, result.savedAt, Date.now());
    return { state: result.state, offline, warnings: result.warnings, tampered: false };
  }

  save(state: GameState, slot: 'auto' | 'manual' = 'auto'): void {
    // 双写：localStorage（同步、桌面可靠）+ IndexedDB（异步、WebView 更耐受清理）
    void writeSave(slot === 'auto' ? AUTO_KEY : MANUAL_KEY, saveToJson(state, Date.now()));
  }

  exportText(state: GameState): string {
    return saveToJson(state, Date.now());
  }

  importText(text: string): LoadOutcome {
    const result = loadFromJson(text, this.data);
    if (!result.ok || !result.state) {
      return { state: null, offline: null, warnings: result.warnings, tampered: result.tampered };
    }
    return { state: result.state, offline: null, warnings: result.warnings, tampered: false };
  }

  /**
   * 清空存档。同时清掉新手引导的本地标记 —— "清空存档并重开" 的语义是回到全新状态，
   * 否则玩家会跳过开场引导、以为功能没生效。
   */
  clear(): void {
    void deleteSave(AUTO_KEY);
    void deleteSave(MANUAL_KEY);
    try {
      localStorage.removeItem('mycelia.tutorial.skipped');
      localStorage.removeItem('mycelia.tutorial.introSeen');
      localStorage.removeItem('mycelia.tutorial.skippedSteps');
    } catch {
      /* 忽略 */
    }
  }

  /** 自动保存调度：返回一个每 intervalMs 调用一次的 tick 钩子；getState 返回 null 表示本次跳过写入 */
  makeAutoSaver(getState: () => GameState | null, intervalMs = this.data.config.save.autoSaveIntervalSec * 1000): (now: number) => void {
    let last = 0;
    return (now: number) => {
      if (now - last < intervalMs) return;
      last = now;
      const state = getState();
      if (!state) return; // 抑制保存（清档中 / 只读沙盒）
      this.save(state, 'auto');
    };
  }

  /** 当前自动存档的摘要（设置面板显示用） */
  autoSaveInfo(): { bytes: number; savedAt: Date } | null {
    const raw = localStorage.getItem(AUTO_KEY);
    if (!raw) return null;
    try {
      const file = JSON.parse(raw) as { savedAt: number };
      return { bytes: raw.length, savedAt: new Date(file.savedAt) };
    } catch {
      return null;
    }
  }
}

export { makeSaveFile };
