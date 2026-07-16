// Pixel-based LOS проверка через полностью загруженные территории.
// Загружает terrainPixels.json (массивы [x,y] на террейн), строит Set для O(1) lookup,
// использует Bresenham для итерации пикселей вдоль луча.
//
// Использование:
//   await initTerrainLOS();          // один раз при старте
//   const c = checkLOSCrossings(from, to);
//   // c = { woods: true, buildings: false, hills: false, orchard: true, brush: false }

import { pixelToHex } from './hexUtils.js';

const terrainSets = {};   // { woods: Set<'x,y'>, ... }
export const lastHits = [];   // DEBUG — координаты пикселей где LOS зацепил контур

export async function initTerrainLOS() {
    const data = await fetch('./terrainPixels.json').then(r => r.json());
    for (const [type, pixels] of Object.entries(data)) {
        const set = new Set();
        for (const [x, y] of pixels) set.add(`${x},${y}`);
        terrainSets[type] = set;
    }
    console.log('[terrainLOS] loaded:', Object.fromEntries(
        Object.entries(terrainSets).map(([k, s]) => [k, s.size])
    ));
}

// Bresenham's line — генератор пикселей от (x0,y0) до (x1,y1)
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

// DEBUG: точная проверка одного пикселя, накопление хитов
function terrainAt(type, x, y) {
    const set = terrainSets[type];
    if (!set) return false;
    if (set.has(`${x},${y}`)) {
        console.log(`[LOS] ${type} hit at (${x},${y})`);
        lastHits.push({ x, y, type });
        return true;
    }
    return false;
}

// Возвращает { type: true|false } — какие типы террейна пересекает луч.
// excludeHexes — список гексов чьи пиксели игнорируем (обычно гекс стрелка и цели):
// terrain в hex'е стрелка/цели не блокирует LOS до center dot.
export function checkLOSCrossings(from, to, excludeHexes = []) {
    console.log(`[LOS] from=(${from.x},${from.y}) to=(${to.x},${to.y})`);
    lastHits.length = 0;   // сброс перед новым проходом
    const crossings = {};
    for (const type of Object.keys(terrainSets)) crossings[type] = false;

    for (const { x, y } of bresenham(from.x, from.y, to.x, to.y)) {
        // пропускаем пиксели в исключаемых гексах
        if (excludeHexes.length > 0) {
            const h = pixelToHex(x, y);
            if (excludeHexes.some(e => e.col === h.col && e.row === h.row)) continue;
        }
        for (const type of Object.keys(terrainSets)) {
            if (crossings[type]) continue;
            if (terrainAt(type, x, y)) crossings[type] = true;
        }
        if (Object.values(crossings).every(v => v)) break;
    }
    return crossings;
}
