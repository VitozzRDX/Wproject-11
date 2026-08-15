// Pixel-based LOS проверка. Данные хранятся по картам (v, u, ...),
// каждая карта — свой xOffset/yOffset и наборы пикселей в ЛОКАЛЬНЫХ координатах.
// pixel_is_on_Obstacle_set принимает мировые координаты и для каждой карты
// переводит мировой пиксель в локальный, проверяет Set-ы.

import { cards as cardRegistry } from './cards.js';

// Размеры одной карты (совпадают с cards.js CARD_ROWS * HEX_H ≈ 645, ширина 1800)
const CARD_W = 1800;
const CARD_H = 645;

// { v: { xOffset, yOffset, rotation, sets: { woods: Set, ... } }, u: {...} }
const cards = {};

// Единственная точка блока LoS для дебажной подсветки. null = ничего.
let _lastHit = null;
export function getLastHit() { return _lastHit; }
export function setLastHit(v) { _lastHit = v; }

export async function initTerrainLOS() {
    const [data, roadData] = await Promise.all([
        fetch('./terrainPixels.json').then(r => r.json()),
        fetch('./roadPixels.json').then(r => r.json()).catch(() => ({})),
    ]);
    for (const [cardName, cardData] of Object.entries(data)) {
        const sets = {};
        for (const [key, val] of Object.entries(cardData)) {
            if (key === 'xOffset' || key === 'yOffset') continue;
            const s = new Set();
            for (const [x, y] of val) s.add(`${x},${y}`);
            sets[key] = s;
        }
        cards[cardName] = {
            xOffset: cardData.xOffset ?? 0,
            yOffset: cardData.yOffset ?? 0,
            rotation: cardRegistry[cardName]?.rotation ?? 0,
            sets,
        };
    }
    // Мержим дороги (roadPixels.json) в те же карты как отдельный тип 'roads'
    for (const [cardName, cardData] of Object.entries(roadData)) {
        const card = cards[cardName];
        if (!card) continue;
        for (const [key, val] of Object.entries(cardData)) {
            if (key === 'xOffset' || key === 'yOffset') continue;
            const s = new Set();
            for (const [x, y] of val) s.add(`${x},${y}`);
            card.sets[key] = s;
        }
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

export function* bresenham(x0, y0, x1, y1) {
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

// Проверяет, попадает ли мировой пиксель (worldX, worldY) в Set пикселей
// указанного типа хотя бы на одной карте. true/false.
export function pixel_is_on_Obstacle_set(type, worldX, worldY) {
    for (const card of Object.values(cards)) {
        const set = card.sets[type];
        if (!set) continue;
        let localX = worldX - card.xOffset;
        let localY = worldY - card.yOffset;
        // если карта визуально повёрнута — переводим мировой пиксель обратно в источник
        if (card.rotation === 180) {
            localX = CARD_W - 1 - localX;
            localY = CARD_H - 1 - localY;
        }
        if (set.has(`${localX},${localY}`)) return true;
    }
    return false;
}

// Экспортируем сырые пиксели террейна карты в ЛОКАЛЬНЫХ координатах.
// Используется для дебажной визуализации (см. main.js).
export function getCardPixels(cardName, type) {
    const card = cards[cardName];
    if (!card || !card.sets[type]) return [];
    const out = [];
    for (const key of card.sets[type]) {
        const [x, y] = key.split(',').map(Number);
        out.push([x, y]);
    }
    return out;
}

