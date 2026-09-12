/**
 * Node 侧数据加载（sim / tests 用）。浏览器侧由 Vite 的 JSON import 提供同样形状的表。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGameData } from './loader.ts';
import type { GameData, RawTables } from '../core/types.ts';

export function loadRawTables(dataDir: string): RawTables {
  const read = <T>(file: string): T => JSON.parse(readFileSync(join(dataDir, file), 'utf8')) as T;
  return {
    resources: read('resources.json'),
    nodes: read('nodes.json'),
    catalystMatrix: read('catalyst-matrix.json'),
    upgrades: read('upgrades.json'),
    tech: read('tech.json'),
    challenges: read('challenges.json'),
    achievements: read('achievements.json'),
    events: read('events.json'),
    quests: read('quests.json'),
    strains: read('strains.json'),
    laws: read('laws.json'),
    gameConfig: read('game-config.json'),
  };
}

/** 仓库根下的 data/ 目录 */
export function defaultDataDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
}

export function loadGameData(dataDir: string = defaultDataDir()): GameData {
  return buildGameData(loadRawTables(dataDir));
}
