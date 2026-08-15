// Одноразовая чистка terrainPixels.json:
//   1) вычитает orchard из woods (спилловер PNG сада в лес);
//   2) удаляет пиксели woods, попавшие в радиус R вокруг центра "ложных" гексов.
// После прогона terrainLOS.js уже не должен фильтровать в рантайме.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hexToPixel, R } from '../hexUtils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JSON_PATH = path.join(__dirname, '..', 'terrainPixels.json');

// Локальные координаты гексов (после ротации), где woods содержит мусор
const WOODS_FALSE_HEXES = {
    v: [
        { col: 20, row: 5 },   // U5 = vM6 (после ротации 180°)
        { col: 21, row: 4 },   // V4 = vL6
        { col: 23, row: 3 },   // X3 = vJ7
        { col: 25, row: 2 },   // Z2 = vH8
        { col: 26, row: 2 },   // AA2 = vG9
        { col: 28, row: 3 },   // AC3 = vE8
        { col: 3, row: 4 },    // D4 = vAD6
        { col: 4, row: 4 },    // E4 = vAC7
    ],
};

function keyOf(x, y) { return `${x},${y}`; }

const data = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));

let totalRemoved = 0;
for (const [cardName, cardData] of Object.entries(data)) {
    const woods = cardData.woods;
    if (!Array.isArray(woods)) continue;
    const before = woods.length;

    // 1) вычесть orchard
    const orchardSet = new Set((cardData.orchard || []).map(([x, y]) => keyOf(x, y)));
    let cleaned = woods.filter(([x, y]) => !orchardSet.has(keyOf(x, y)));

    // 2) радиусный фильтр по ложным гексам
    const centers = (WOODS_FALSE_HEXES[cardName] || []).map(h => hexToPixel(h.col, h.row));
    if (centers.length) {
        const rSq = R * R;
        cleaned = cleaned.filter(([x, y]) =>
            !centers.some(c => (x - c.x) ** 2 + (y - c.y) ** 2 <= rSq)
        );
    }

    cardData.woods = cleaned;
    const removed = before - cleaned.length;
    totalRemoved += removed;
    console.log(`[${cardName}] woods: ${before} → ${cleaned.length} (removed ${removed})`);
}

fs.writeFileSync(JSON_PATH, JSON.stringify(data));
console.log(`Total removed: ${totalRemoved}. Written to ${JSON_PATH}.`);
