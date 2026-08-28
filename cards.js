import { hexMapU_rot as hexMap } from './hexmapU_rot.js';
import { State } from './state.js';

// Единый world hexmap: ключ "col-row", значение — массив терпейнов.
// Мержится с runtime overlay (smoke и т.п.) из State.dynamicTerrain.
export function terrainAt(col, row) {
    const key = `${col}-${row}`;
    const dynamic = State.dynamicTerrain?.[key] ?? [];
    const staticT = hexMap[key] ?? [];
    return [...staticT, ...dynamic];
}
