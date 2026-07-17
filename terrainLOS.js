// Pixel-based LOS проверка. Данные хранятся по картам (v, u, ...),
// каждая карта — свой xOffset/yOffset и наборы пикселей в ЛОКАЛЬНЫХ координатах.
// checkLOSCrossings принимает мировые координаты и для каждой карты
// переводит мировой пиксель в локальный, проверяет Set-ы.

import { pixelToHex } from './hexUtils.js';

// { v: { xOffset, yOffset, sets: { woods: Set, ... } }, u: {...} }
const cards = {};
export const lastHits = [];

export async function initTerrainLOS() {
    const data = await fetch('./terrainPixels.json').then(r => r.json());
    for (const [cardName, cardData] of Object.entries(data)) {
        const sets = {};
        for (const [key, val] of Object.entries(cardData)) {
            if (key === 'xOffset' || key === 'yOffset') continue;
            const s = new Set();
            for (const [x, y] of val) s.add(`${x},${y}`);
            sets[key] = s;
        }
        // Убираем orchard-пиксели из woods (при экспорте PNG сад ошибочно попал в лес)
        if (sets.woods && sets.orchard) {
            for (const p of sets.orchard) sets.woods.delete(p);
        }
        cards[cardName] = {
            xOffset: cardData.xOffset ?? 0,
            yOffset: cardData.yOffset ?? 0,
            sets,
        };
    }
    console.log('[terrainLOS] loaded cards:', Object.fromEntries(
        Object.entries(cards).map(([k, c]) => [
            k, {
                offset: [c.xOffset, c.yOffset],
                sizes: Object.fromEntries(Object.entries(c.sets).map(([t, s]) => [t, s.size])),
            }
        ])
    ));
}

function* bresenham(x0, y0, x1, y1) {
    x0 = Math.round(x0); y0 = Math.round(y0);
    x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy, x = x0, y = y0;
    while (true) {
        yield { x, y };
        if (x === x1 && y === y1) break;
        const e2 = 2 * err;
        if (e2 > -dy) { err -= dy; x += sx; }
        if (e2 <  dx) { err += dx; y += sy; }
    }
}

// Собираем все уникальные типы террейна по всем картам
function allTerrainTypes() {
    const types = new Set();
    for (const card of Object.values(cards)) {
        for (const type of Object.keys(card.sets)) types.add(type);
    }
    return [...types];
}

// Проверить пиксель (в мировых координатах) на каждой карте
function terrainAtWorld(type, worldX, worldY) {
    for (const [cardName, card] of Object.entries(cards)) {
        const set = card.sets[type];
        if (!set) continue;
        const localX = worldX - card.xOffset;
        const localY = worldY - card.yOffset;
        if (set.has(`${localX},${localY}`)) {
            console.log(`[LOS] ${type} hit at world (${worldX},${worldY}) card=${cardName} local=(${localX},${localY})`);
            lastHits.push({ x: worldX, y: worldY, type, card: cardName });
            return true;
        }
    }
    return false;
}

export function checkLOSCrossings(from, to, excludeHexes = []) {
    console.log(`[LOS] from=(${from.x},${from.y}) to=(${to.x},${to.y})`);
    lastHits.length = 0;
    const types = allTerrainTypes();
    const crossings = {};
    for (const type of types) crossings[type] = false;

    for (const { x, y } of bresenham(from.x, from.y, to.x, to.y)) {
        if (excludeHexes.length > 0) {
            const h = pixelToHex(x, y);
            if (excludeHexes.some(e => e.col === h.col && e.row === h.row)) continue;
        }
        for (const type of types) {
            if (crossings[type]) continue;
            if (terrainAtWorld(type, x, y)) crossings[type] = true;
        }
        if (Object.values(crossings).every(v => v)) break;
    }
    return crossings;
}
