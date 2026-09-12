/**
 * 模拟运行器：把策略机器人放进真实引擎里跑时间轴，在固定时间截面采样。
 *
 * 步长自适应（早期 1s / 中期 5s / 后期 30s），在保证关键阶段精度的同时让 7 天模拟可控。
 * 与游戏使用同一套 engine，因此模拟结论对实际游戏成立。
 */

import { SciNum as S } from '../core/math/scinum.ts';
import { createNewGame, type GameState } from '../core/state.ts';
import type { GameData } from '../core/types.ts';
import { loadGameData } from '../data/node-source.ts';
import {
  applyAction,
  decideAndAct,
  sporogeneGain,
  type Strategy,
  type StrategyContext,
} from './strategies.ts';
import { computeModifiers, tick } from '../core/economy/engine.ts';
import { doPrestige } from '../core/prestige/prestige.ts';

export interface SamplePoint {
  label: string;
  sec: number;
}

export const SAMPLE_POINTS: SamplePoint[] = [
  { label: '1m', sec: 60 },
  { label: '5m', sec: 300 },
  { label: '10m', sec: 600 },
  { label: '30m', sec: 1800 },
  { label: '1h', sec: 3600 },
  { label: '5h', sec: 18000 },
  { label: '10h', sec: 36000 },
  { label: '24h', sec: 86400 },
  { label: '7d', sec: 604800 },
];

export interface SimSample {
  label: string;
  elapsed: number;
  nodes: number;
  links: number;
  layers: number;
  upgrades: number;
  techs: number;
  prestigeCount: number;
  sporogene: string;
  /** key = 资源 id，value = log10 数量（0 用 -Infinity 表示） */
  log10: Record<string, number>;
}

export interface SimResult {
  strategy: string;
  strategyName: string;
  samples: SimSample[];
  milestones: { at: number; text: string }[];
  wallMs: number;
  error: string | null;
  finalNodes: number;
  finalLinks: number;
  throttledRatio: number;
}

function chooseDt(elapsed: number): number {
  if (elapsed < 3600) return 1;
  if (elapsed < 86400) return 5;
  return 30;
}

/** 简化版孢子化（已在 PHASE 4 升级为 core/prestige：保留机制类与隐藏类升级 + 科技 + 成就） */
export function simPrestige(state: GameState, data: GameData): GameState {
  return doPrestige(state, data).state;
}

function takeSample(state: GameState, label: string): SimSample {
  const log10: Record<string, number> = {};
  for (const id of Object.keys(state.resources)) {
    const v = state.resources[id]!;
    log10[id] = v.isZero() ? Number.NEGATIVE_INFINITY : S.log10(v);
  }
  let upgradeLevels = 0;
  for (const lvl of Object.values(state.upgrades)) upgradeLevels += lvl;
  return {
    label,
    elapsed: state.elapsed,
    nodes: state.graph.size(),
    links: state.graph.links.size,
    layers: state.unlockedLayers.length,
    upgrades: upgradeLevels,
    techs: Object.keys(state.techs).length,
    prestigeCount: state.prestige.count,
    sporogene: state.prestige.sporogene.toString(),
    log10,
  };
}

export interface RunOptions {
  data?: GameData;
  maxSec?: number;
  collectFinal?: boolean;
}

export function runSimulation(strategy: Strategy, opts: RunOptions = {}): SimResult {
  const data = opts.data ?? loadGameData();
  const maxSec = opts.maxSec ?? SAMPLE_POINTS[SAMPLE_POINTS.length - 1]!.sec;
  const t0 = performance.now();

  let state = createNewGame(data);
  // 策略指定的菌株：在开局直接表达（模拟器不模拟"切换流程"，只比较流派本身）
  if (strategy.prefs.strain) {
    state = { ...state, prestige: { ...state.prestige, strain: strategy.prefs.strain } };
  }
  let mods = computeModifiers(state, data);
  const ctx: StrategyContext = { state, data, mods, prestigeGain: S.ZERO };

  const samples: SimSample[] = [];
  const milestones: { at: number; text: string }[] = [];
  let sampleIdx = 0;
  let error: string | null = null;
  let throttledHits = 0;
  let tickCount = 0;

  const seenLayers = new Set(state.unlockedLayers);
  let lastPrestige = state.prestige.count;
  const seenMilestones = new Set<string>();
  const checkMilestone = (key: string, cond: boolean, text: string): void => {
    if (!cond || seenMilestones.has(key)) return;
    seenMilestones.add(key);
    const at = state.elapsed;
    milestones.push({ at, text });
  };

  try {
    while (state.elapsed < maxSec) {
      const nextSampleSec = sampleIdx < SAMPLE_POINTS.length ? SAMPLE_POINTS[sampleIdx]!.sec : maxSec;
      const dt = Math.min(chooseDt(state.elapsed), Math.max(0.5, nextSampleSec - state.elapsed));

      // ---- 决策与执行（决策即执行，每一步都基于最新状态）
      ctx.prestigeGain = sporogeneGain(state, data, mods);
      const results = decideAndAct(ctx, strategy.prefs);
      const dirty = results.some((r) => r.ok);
      if (results.some((r) => r.action.kind === 'prestige' && r.ok)) {
        state = doPrestige(state, data).state;
        ctx.state = state;
      }
      if (dirty) {
        mods = computeModifiers(state, data);
        ctx.mods = mods;
      }

      // ---- 推进时间
      const report = tick(state, data, dt, { mods });
      tickCount++;
      for (const r of Object.values(report.throttled)) if (r < 1) throttledHits++;
      if (state.prestige.count !== lastPrestige) {
        milestones.push({ at: state.elapsed, text: `孢子化 #${state.prestige.count}（累计孢子基因 ${state.prestige.sporogene.toString()}）` });
        lastPrestige = state.prestige.count;
      }
      for (const layerId of state.unlockedLayers) {
        if (!seenLayers.has(layerId)) {
          seenLayers.add(layerId);
          milestones.push({ at: state.elapsed, text: `解锁基质层：${data.layers.get(layerId)?.name ?? layerId}` });
        }
      }
      checkMilestone('first-sclerotium', S.gt(state.resources.sclerotium ?? S.ZERO, S.ZERO), '首次获得菌核晶格');
      checkMilestone('first-honeydew', S.gt(state.resources.honeydew ?? S.ZERO, S.ZERO), '首次获得蜜露（共生链启动）');
      checkMilestone('first-core', S.gt(state.resources.core ?? S.ZERO, S.ZERO), '首次获得共生核心（孢子化门槛）');
      checkMilestone('first-signal', S.gt(state.resources.signal ?? S.ZERO, S.ZERO), '首次获得菌丝电信号');
      checkMilestone('first-pact', S.gt(state.resources.pact ?? S.ZERO, S.ZERO), '首次签订契约');
      checkMilestone('nodes-100', state.graph.size() >= 100, '网络达到 100 节点');
      checkMilestone('nodes-300', state.graph.size() >= 300, '网络达到 300 节点');

      // ---- 采样
      while (sampleIdx < SAMPLE_POINTS.length && state.elapsed >= SAMPLE_POINTS[sampleIdx]!.sec) {
        samples.push(takeSample(state, SAMPLE_POINTS[sampleIdx]!.label));
        sampleIdx++;
      }
    }
  } catch (e) {
    error = (e as Error).message;
  }

  // 补足缺失的采样点（出错时）
  while (sampleIdx < SAMPLE_POINTS.length) {
    samples.push(takeSample(state, SAMPLE_POINTS[sampleIdx]!.label));
    sampleIdx++;
  }

  return {
    strategy: strategy.id,
    strategyName: strategy.name,
    samples,
    milestones: dedupeMilestones(milestones),
    wallMs: performance.now() - t0,
    error,
    finalNodes: state.graph.size(),
    finalLinks: state.graph.links.size,
    throttledRatio: tickCount > 0 ? throttledHits / tickCount : 0,
  };
}

function dedupeMilestones(list: { at: number; text: string }[]): { at: number; text: string }[] {
  const seen = new Set<string>();
  const out: { at: number; text: string }[] = [];
  for (const m of list) {
    if (seen.has(m.text)) continue;
    seen.add(m.text);
    out.push(m);
  }
  return out;
}
