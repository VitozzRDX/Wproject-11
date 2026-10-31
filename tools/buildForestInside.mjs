// Одноразовый скрипт: по списку hex-ов (одного замкнутого forest-контура) и
// пиксельным контурам woods из terrainPixels.json строит множество пикселей,
// лежащих ВНУТРИ этого контура (contour + flood-fill от центра первого hex-а,
// ограниченный hex-ами списка). Результат пишется в woodsInsidePixels.json.
//
// Запуск: node tools/buildForestInside.mjs

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { hexToPixel, pixelToHex } from '../hexUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT       = path.join(__dirname, '..');

// Список hex-ов замкнутого forest-региона (вводится вручную).
const REGION_HEXES = [
    '44-4',
    '45-1','45-4',
    '46-2','46-3','46-4','46-5',
    '47-2','47-3','47-4',
];

// Размеры карты (должны совпадать с terrainLOS.js).
const CARD_W = 1800;
const CARD_H = 645;

const terrainPixels = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'terrainPixels.json'), 'utf8')
);

// Парсим hex-метки → {col, row}.
const regionHexes = REGION_HEXES.map(label => {
    const [col, row] = label.split('-').map(Number);
    return { col, row, label };
});

// Переводит мировой пиксель в локальный данной карты (с учётом xOffset/yOffset/rotation).
function worldToLocal(card, worldX, worldY) {
    let lx = worldX - (card.xOffset ?? 0);
    let ly = worldY - (card.yOffset ?? 0);
    if (card.rotation === 180) {
        lx = CARD_W - 1 - lx;
        ly = CARD_H - 1 - ly;
    }
    return { x: lx, y: ly };
}

// Обратно: локальный пиксель карты → мировой.
function localToWorld(card, localX, localY) {
    let lx = localX;
    let ly = localY;
    if (card.rotation === 180) {
        lx = CARD_W - 1 - lx;
        ly = CARD_H - 1 - ly;
    }
    return { x: lx + (card.xOffset ?? 0), y: ly + (card.yOffset ?? 0) };
}

// Определяем, к какой карте принадлежат наши hex-ы: по тому, что локальные
// координаты центра первого hex-а попадают в [0, CARD_W-1] × [0, CARD_H-1].
function findCardFor(hex, terrainPixels) {
    const w = hexToPixel(hex.col, hex.row);
    for (const [name, card] of Object.entries(terrainPixels)) {
        const l = worldToLocal(card, w.x, w.y);
        if (l.x >= 0 && l.x < CARD_W && l.y >= 0 && l.y < CARD_H) {
            return { name, card, localCenter: l, worldCenter: w };
        }
    }
    return null;
}

// Берём первый hex, чей центр реально попал в карту (row 1 — "полугексы", их центр может выйти выше).
let match = null;
for (const h of regionHexes) {
    const m = findCardFor(h, terrainPixels);
    if (m) { match = m; break; }
}
if (!match) {
    console.error(`[err] ни один hex региона не попал в карту`);
    process.exit(1);
}
console.log(`[info] регион на карте '${match.name}' (rotation=${match.card.rotation ?? 0})`);

// Строим Set контурных woods-пикселей (локальных) этой карты.
const woodsLocal = new Set();
for (const [x, y] of match.card.woods ?? []) {
    woodsLocal.add(`${x},${y}`);
}
console.log(`[info] всего woods-пикселей на карте: ${woodsLocal.size}`);

// Set hex-ов региона — для фильтра flood-fill.
const regionSet = new Set(regionHexes.map(h => h.label));

// Проверка принадлежности локального пикселя hex-у региона.
function pixelInRegion(card, lx, ly) {
    const w = localToWorld(card, lx, ly);
    const h = pixelToHex(w.x, w.y);
    return regionSet.has(`${h.col}-${h.row}`);
}

// Фильтруем contour-пиксели: только те, что в hex-ах региона.
const regionContour = new Set();
for (const key of woodsLocal) {
    const [sx, sy] = key.split(',').map(Number);
    if (pixelInRegion(match.card, sx, sy)) regionContour.add(key);
}
console.log(`[info] contour-пикселей в hex-ах региона: ${regionContour.size}`);

// Flood-fill: seed = центр первого hex-а (локальный, округлённый).
const seedLX = Math.round(match.localCenter.x);
const seedLY = Math.round(match.localCenter.y);
console.log(`[info] seed: local (${seedLX}, ${seedLY})`);

if (regionContour.has(`${seedLX},${seedLY}`)) {
    console.error(`[err] центр первого hex-а на контуре — выбери другой seed`);
    process.exit(1);
}

const visited = new Set();
const queue = [[seedLX, seedLY]];
visited.add(`${seedLX},${seedLY}`);
let outOfRegion = 0;

while (queue.length) {
    const [x, y] = queue.shift();
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= CARD_W || ny < 0 || ny >= CARD_H) continue;
        const nk = `${nx},${ny}`;
        if (visited.has(nk)) continue;
        if (regionContour.has(nk)) continue;   // упёрлись в контур — не идём дальше
        if (!pixelInRegion(match.card, nx, ny)) { outOfRegion++; continue; }
        visited.add(nk);
        queue.push([nx, ny]);
    }
}
console.log(`[info] flood-fill: ${visited.size} внутренних пикселей, попыток уйти из региона: ${outOfRegion}`);

// Итоговое множество «внутри леса» = flood + сам contour.
const insideLocal = new Set(visited);
for (const k of regionContour) insideLocal.add(k);

const insideArr = Array.from(insideLocal).map(k => k.split(',').map(Number));
console.log(`[info] итого inside-пикселей: ${insideArr.length}`);

// Выводим в файл в том же формате, что terrainPixels.json: карта → { ..., woodsInside: [[x,y],...] }
// Берём только нашу карту; остальные карты в файл не включаем на этом шаге.
const outPath = path.join(ROOT, 'woodsInsidePixels.json');
// Мержим с существующим файлом: по карте объединяем пиксели в один общий список.
let existing = {};
try { existing = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch {}
const prev = existing[match.name];
let mergedSet;
if (prev && Array.isArray(prev.woodsInside)) {
    mergedSet = new Set(prev.woodsInside.map(([x, y]) => `${x},${y}`));
    for (const [x, y] of insideArr) mergedSet.add(`${x},${y}`);
    console.log(`[merge] существующих ${prev.woodsInside.length} + новых ${insideArr.length} → итого ${mergedSet.size}`);
} else {
    mergedSet = new Set(insideArr.map(([x, y]) => `${x},${y}`));
    console.log(`[new] новых ${insideArr.length}`);
}
const mergedArr = Array.from(mergedSet).map(k => k.split(',').map(Number));
existing[match.name] = {
    xOffset:  match.card.xOffset ?? 0,
    yOffset:  match.card.yOffset ?? 0,
    rotation: match.card.rotation ?? 0,
    woodsInside: mergedArr,
};
fs.writeFileSync(outPath, JSON.stringify(existing));
console.log(`[ok] записано: ${outPath}`);
