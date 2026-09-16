// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Outer radius (center → vertex), px */
 export const R = 112 / 3;

/** Half horizontal step, px */
 const RX = 37.30;

/** Full hex height = vertical distance between adjacent row centers, px */
 const HEX_H = Math.sqrt(3) * R;

/** Horizontal distance between adjacent column centers, px */
 const COL_STEP = 1.5 * RX;

/** Odd columns are shifted down by this amount, px */
 const ODD_OFFSET = HEX_H / 2;

// ---------------------------------------------------------------------------
// Calibration — edit these until the grid aligns with the board image
// ---------------------------------------------------------------------------

/** World-pixel X of hex A1 (column 0, row 1) center */
 const GRID_OFFSET_X = 1.32;   // подкручиваем вручную под карту

/** Квадратичный коэффициент разбега вправо (col > 0) */
 const DRIFT_COEF = 0.005;
/** Квадратичный коэффициент разбега влево (col < 0) */
 const DRIFT_COEF_LEFT = 0.010;

/** World-pixel Y of hex A1 (column 0, row 1) center */
 const GRID_OFFSET_Y = HEX_H / 2 - 2;

 // ---------------------------------------------------------------------------
// World canvas dimensions
// ---------------------------------------------------------------------------

export const BOARD_W     = 1800;
export const BOARD_H     = 645;
export const BOARD_COUNT = 3;
export const WORLD_H     = BOARD_H * BOARD_COUNT; // 1935

/** Number of hex columns that fit across BOARD_W */
export const COL_COUNT = Math.ceil(BOARD_W / COL_STEP);

/** Number of hex rows that fit across WORLD_H */
export const ROW_COUNT = Math.ceil(WORLD_H / HEX_H);


// Пиксель → новые координаты (col-row в единой системе, origin над uB1 = "0-1").
// Внутри работаем в старой системе (old_col in [-COL_COUNT, COL_COUNT-1], old_row in [1, ROW_COUNT]),
// потом сдвигаем: new_col = old_col + COL_COUNT − 1; new_row = old_row + 1.
// Т.е. uB1 (old col=-32, row=1) → new (0, 2), а origin new (0,1) = old (-32, 0).
// Voronoi-nearest: перебираем 3×3 кандидатов вокруг приблизительной оценки col/row,
// выбираем hex с ближайшим центром (для регулярной hex-сетки Voronoi-ячейка = сам hex).
export function pixelToHex(px, py) {
  // Грубая оценка col — с drift-коррекцией.
  let col = Math.round((px - GRID_OFFSET_X) / COL_STEP);
  for (let iter = 0; iter < 3; iter++) {
    const coef = col >= 0 ? DRIFT_COEF : DRIFT_COEF_LEFT;
    const gridX = GRID_OFFSET_X + col * COL_STEP + col * Math.abs(col) * coef;
    const dCol = Math.round((px - gridX) / COL_STEP);
    if (dCol === 0) break;
    col += dCol;
  }

  // Перебираем 3×3 кандидатов вокруг приблизительной оценки, выбираем ближайший центр.
  let bestCol = col, bestRow = 1, bestD = Infinity;
  for (let dc = -1; dc <= 1; dc++) {
    const c = col + dc;
    const coef = c >= 0 ? DRIFT_COEF : DRIFT_COEF_LEFT;
    const centerX = GRID_OFFSET_X + c * COL_STEP + c * Math.abs(c) * coef;
    const isOdd = ((c % 2) + 2) % 2 === 1;
    const yAdj = py - GRID_OFFSET_Y - (isOdd ? ODD_OFFSET : 0);
    const rowGuess = Math.round(yAdj / HEX_H) + 1;
    for (let dr = -1; dr <= 1; dr++) {
      const r = rowGuess + dr;
      const centerY = GRID_OFFSET_Y + (r - 1) * HEX_H + (isOdd ? ODD_OFFSET : 0);
      const d = (centerX - px) ** 2 + (centerY - py) ** 2;
      if (d < bestD) { bestD = d; bestCol = c; bestRow = r; }
    }
  }

  const clampedCol = Math.max(-COL_COUNT, Math.min(COL_COUNT - 1, bestCol));
  const clampedRow = Math.max(0, Math.min(ROW_COUNT, bestRow));
  return { col: clampedCol + COL_COUNT - 1, row: clampedRow + 1 };
}

// Единый world-label: "col-row" (col — колонка, row — ряд).
// Origin (0, 1) = хекс прямо над uB1 в старой системе.
export function hexLabel(col, row) {
  return `${col}-${row}`;
}

// Соседи в odd-q offset раскладке (нечётные столбцы сдвинуты вниз)
const EVEN_NEIGHBORS = [
  { dc:  0, dr: -1 }, { dc:  0, dr: +1 },   // N, S
  { dc: +1, dr: -1 }, { dc: +1, dr:  0 },   // NE, SE
  { dc: -1, dr: -1 }, { dc: -1, dr:  0 },   // NW, SW
];
const ODD_NEIGHBORS = [
  { dc:  0, dr: -1 }, { dc:  0, dr: +1 },
  { dc: +1, dr:  0 }, { dc: +1, dr: +1 },
  { dc: -1, dr:  0 }, { dc: -1, dr: +1 },
];

// Возвращает массив из 6 соседних гексов
export function calcNearestHexes(hex) {
  const offsets = hex.col % 2 === 0 ? EVEN_NEIGHBORS : ODD_NEIGHBORS;
  return offsets.map(({ dc, dr }) => ({ col: hex.col + dc, row: hex.row + dr }));
}

// Перевод offset (col, row) в cube координаты (для расчёта расстояния)
function offsetToCube(col, row) {
  const x = col;
  const z = row - (col - (col & 1)) / 2;
  const y = -x - z;
  return { x, y, z };
}

// Расстояние между двумя гексами в гексах (соседние = 1)
// Совпадают ли hex'ы по (col, row).
export function isSameHex(a, b) {
  return a.col === b.col && a.row === b.row;
}

// Соседние ли два хекса (расстояние 1).
export function isAdjacent(a, b) {
  return hexDistance(a, b) === 1;
}

export function hexDistance(a, b) {
  const ca = offsetToCube(a.col, a.row);
  const cb = offsetToCube(b.col, b.row);
  return (Math.abs(ca.x - cb.x) + Math.abs(ca.y - cb.y) + Math.abs(ca.z - cb.z)) / 2;
}

// Возвращает hex'ы на кольце заданного радиуса от center.
// Простая реализация: перебираем bounding box (±radius по col/row), фильтруем по hexDistance.
export function cubeRing(center, radius) {
  if (radius === 0) return [center];
  const result = [];
  for (let dc = -radius; dc <= radius; dc++) {
    for (let dr = -radius; dr <= radius; dr++) {
      const hex = { col: center.col + dc, row: center.row + dr };
      if (hexDistance(center, hex) === radius) result.push(hex);
    }
  }
  return result;
}

// -----------------------------------------------------------------------------
// Обход хексов волнами (BFS) от startHex. Каждая волна = хексы на 1 шаг
// дальше предыдущей. Ребро (from → to) берём только если isLegalRoutStep вернул true.
// Возвращает hexes_parentHexes: Map, по которой восстанавливается путь.
// maxSteps — предел радиуса от старта в шагах. За этот предел волна не идёт.
// -----------------------------------------------------------------------------
export function bfsHexes(startHex, maxSteps, isLegalRoutStep) {
  const hexKey = h => `${h.col},${h.row}`;

  // Map: каждый достигнутый хекс → хекс, из которого в него пришли.
  // Стартового хекса тут нет. По этой карте восстанавливается путь.
  const hexes_parentHexes = new Map();  // { "3,3" => (3,2), "3,4" => (3,3), "2,3" => (3,2) }

  // Множество уже посещённых хексов — чтобы не разворачивать их повторно.
  const visited = new Set([hexKey(startHex)]);  // { "3,2", "3,3", "3,4", "2,3" }

  // Очередь волны: пара [хекс, радиус от старта в шагах].
  const queue = [[startHex, 0]];  // [ [(3,2), 0], [(3,3), 1], [(2,3), 1], [(3,4), 2] ]

  while (queue.length) {
    const [currentHex, radiusFromStart] = queue.shift();  // на первой итерации: [startHex, 0]

    // Дошли до предела радиуса — соседей не разворачиваем.
    if (radiusFromStart >= maxSteps) continue;

    for (const neighborHex of calcNearestHexes(currentHex)) {  // для каждого соседа текущего гекса
      const neighborKey = hexKey(neighborHex);
      if (visited.has(neighborKey)) continue;                            // проверяем находится ли он в visited — если да, пропускаем
      if (!isLegalRoutStep(currentHex, neighborHex)) continue;           // проверяем легален ли этот гекс (отвечает KEU)

      visited.add(neighborKey);                                          // прошло все проверки — добавляем в посещённые
      hexes_parentHexes.set(neighborKey, currentHex);                    // на первой итерации: { "neighborKey" => startHex }
      queue.push([neighborHex, radiusFromStart + 1]);                    // на первой итерации: [neighborHex, 1]
    }
    // результат полного цикла первой итерации [[neighborHex1,1], ..., [neighborHex6,1]] если все 6 легальны
  }
  return hexes_parentHexes;
}

// -----------------------------------------------------------------------------
// Dijkstra от startHex. В отличие от BFS учитывает стоимость входа в хекс.
// Ребро (from → to) берём только если isEdgeAllowed вернул true.
// stepCost(from, to) — стоимость перехода (число, >= 0).
// Возвращает { hexes_parentHexes, bestCostToReach }: карту родителей (для
// восстановления путей через reconstructPath) и карту минимальных стоимостей.
// maxCost — предел суммарной стоимости (например, MF-бюджет).
// -----------------------------------------------------------------------------
export function dijkstraHexes(startHex, maxCost, isEdgeAllowed, stepCost) {
  const hexKey = h => `${h.col},${h.row}`;

  // Куда пришли → откуда пришли (для восстановления путей).
  const hexes_parentHexes = new Map();

  // Куда пришли → минимальная известная стоимость. Стартовый хекс — 0.
  const bestCostToReach = new Map([[hexKey(startHex), 0]]);  // { "3,2" => 0, "3,3" => 1, "3,4" => 3 }

  // Приоритетная очередь: [хекс, суммарная стоимость]. Каждый shift — sort по цене.
  const queue = [[startHex, 0]];

  while (queue.length) {
    queue.sort((a, b) => a[1] - b[1]);                        // минимум в начало
    const [currentHex, costSoFar] = queue.shift();

    // Устаревшая запись — мы уже нашли путь дешевле. Пропускаем.
    if (costSoFar > bestCostToReach.get(hexKey(currentHex))) continue;

    for (const neighborHex of calcNearestHexes(currentHex)) {
      if (!isEdgeAllowed(currentHex, neighborHex)) continue;

      const cost = costSoFar + stepCost(currentHex, neighborHex);
      if (cost > maxCost) continue;                            // не влезает в бюджет

      const known = bestCostToReach.get(hexKey(neighborHex)) ?? Infinity;
      if (cost < known) {                                      // нашли дешевле — обновляем
        bestCostToReach.set(hexKey(neighborHex), cost);
        hexes_parentHexes.set(hexKey(neighborHex), currentHex);
        queue.push([neighborHex, cost]);
      }
    }
  }
  return { hexes_parentHexes, bestCostToReach };
}

// -----------------------------------------------------------------------------
// Восстанавливает путь startHex → goalHex по карте hexes_parentHexes из bfsHexes.
// Идёт назад от цели по родителям. Возвращает [] если goal не достигнут.
// -----------------------------------------------------------------------------
export function reconstructPath(hexes_parentHexes, startHex, goalHex) {
  const hexKey = h => `${h.col},${h.row}`;
  const path   = [];

  // Идём от цели назад: каждый раз спрашиваем карту "откуда пришли сюда?".
  // Когда родителя нет (undefined) — это старт, цикл останавливается.
  for (let hex = goalHex; hex; hex = hexes_parentHexes.get(hexKey(hex))) {
    path.unshift(hex);
  }

  // Если первый элемент не старт — goal был недостижим.
  return path.length && isSameHex(path[0], startHex) ? path : [];
}

// Новые координаты → пиксель. Конвертируем в старые (see pixelToHex).
export function hexToPixel(col, row) {
  const oldCol = col - (COL_COUNT - 1);
  const oldRow = row - 1;
  const coef = oldCol >= 0 ? DRIFT_COEF : DRIFT_COEF_LEFT;
  const x = GRID_OFFSET_X + oldCol * COL_STEP + oldCol * Math.abs(oldCol) * coef;
  const isOdd = ((oldCol % 2) + 2) % 2 === 1;
  const y = GRID_OFFSET_Y + (oldRow - 1) * HEX_H + (isOdd ? ODD_OFFSET : 0);
  return { x, y };
}