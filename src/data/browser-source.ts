/**
 * 浏览器侧数据加载：通过 Vite 的 JSON import 拿到与 Node 侧完全相同的表结构。
 * 这样 core 层不需要知道数据来自文件系统还是打包产物。
 */

import resourceTable from '../../data/resources.json' with { type: 'json' };
import nodeTable from '../../data/nodes.json' with { type: 'json' };
import catalystTable from '../../data/catalyst-matrix.json' with { type: 'json' };
import upgradeTable from '../../data/upgrades.json' with { type: 'json' };
import techTable from '../../data/tech.json' with { type: 'json' };
import challengeTable from '../../data/challenges.json' with { type: 'json' };
import achievementTable from '../../data/achievements.json' with { type: 'json' };
import eventTable from '../../data/events.json' with { type: 'json' };
import questTable from '../../data/quests.json' with { type: 'json' };
import strainTable from '../../data/strains.json' with { type: 'json' };
import lawTable from '../../data/laws.json' with { type: 'json' };
import gameConfig from '../../data/game-config.json' with { type: 'json' };
import { buildGameData } from './loader.ts';
import type { GameData, RawTables } from '../core/types.ts';

export function rawTablesFromBundle(): RawTables {
  return {
    resources: resourceTable as unknown as RawTables['resources'],
    nodes: nodeTable as unknown as RawTables['nodes'],
    catalystMatrix: catalystTable as unknown as RawTables['catalystMatrix'],
    upgrades: upgradeTable as unknown as RawTables['upgrades'],
    tech: techTable as unknown as RawTables['tech'],
    challenges: challengeTable as unknown as RawTables['challenges'],
    achievements: achievementTable as unknown as RawTables['achievements'],
    events: eventTable as unknown as RawTables['events'],
    quests: questTable as unknown as RawTables['quests'],
    strains: strainTable as unknown as RawTables['strains'],
    laws: lawTable as unknown as RawTables['laws'],
    gameConfig: gameConfig as unknown as RawTables['gameConfig'],
  };
}

export function loadBrowserGameData(): GameData {
  return buildGameData(rawTablesFromBundle());
}
