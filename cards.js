import { hexMap as V_HEXMAP } from './hexmap.js';
import { COL_COUNT } from './hexUtils.js';

// Каждая карта визуально высотой ~10 гексов (645px / HEX_H ≈ 10),
// хотя мировая сетка простирается на ROW_COUNT=30 (несколько карт стеком)
const CARD_ROWS = 10;

// A-Z (0..25) → одна буква; далее AA, AB, AC, ... (последовательные)
function colToLocalLetters(col) {
    const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    if (col < 26) return alpha[col];
    return 'A' + alpha[col - 26];
}

// Реестр карт. Каждая карта содержит:
//   worldColStart / worldRowStart — сдвиг локальной системы координат в мир
//   width / height                — размер карты в гексах
//   rotation                      — 0 или 180 (крутится физически, локальный hexmap не трогается)
//   hexmap                        — террейн в ЛОКАЛЬНЫХ лейблах карты ('F3', 'AC10', ...)
export const cards = {
    v: {
        worldColStart: 0,
        worldRowStart: 1,
        width:  COL_COUNT,
        height: CARD_ROWS,
        rotation: 180,
        hexmap: V_HEXMAP,   // старые данные — уже в локальных лейблах V
    },
    u: {
        worldColStart: -COL_COUNT,
        worldRowStart: 1,
        width:  COL_COUNT,
        height: CARD_ROWS,
        rotation: 0,       // U не поворачиваем
        hexmap: {},         // U-карту наполним позже
    },
};

// Найти террейн для world (col, row) — обходит все карты,
// учитывает границы и rotation каждой.
export function terrainAt(worldCol, worldRow) {
    for (const card of Object.values(cards)) {
        let lc = worldCol - card.worldColStart;
        let lr = worldRow - card.worldRowStart + 1;

        // проверка границ карты
        if (lc < 0 || lc >= card.width || lr < 1 || lr > card.height) continue;

        // rotation 180 — зеркалим локальные координаты.
        // ODD_OFFSET (сдвиг нечётных столбцов вниз) после поворота смотрит вверх
        // относительно мировой сетки, поэтому для нечётного worldCol row смещается на 1.
        if (card.rotation === 180) {
            const oddCol = ((lc % 2) + 2) % 2 === 1;
            lc = card.width - 1 - lc;
            lr = card.height + 1 - lr - (oddCol ? 1 : 0);
        }

        const label = colToLocalLetters(lc) + lr;
        const terrain = card.hexmap[label];
        if (terrain) return terrain;
        return [];   // гекс в этой карте, но террейна не задано → открытая местность
    }
    return [];       // ни одной карте не принадлежит
}
