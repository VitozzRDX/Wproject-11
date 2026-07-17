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


export function pixelToHex(px, py) {
  // линейная оценка + итеративная коррекция под квадратичный дрифт (со знаком)
  let col = Math.round((px - GRID_OFFSET_X) / COL_STEP);
  for (let iter = 0; iter < 3; iter++) {
    const coef = col >= 0 ? DRIFT_COEF : DRIFT_COEF_LEFT;
    const gridX = GRID_OFFSET_X + col * COL_STEP + col * Math.abs(col) * coef;
    const dCol = Math.round((px - gridX) / COL_STEP);
    if (dCol === 0) break;
    col += dCol;
  }
  const clampedCol = Math.max(-COL_COUNT, Math.min(COL_COUNT - 1, col));
  const isOdd = ((clampedCol % 2) + 2) % 2 === 1;
  const yAdjusted = py - GRID_OFFSET_Y - (isOdd ? ODD_OFFSET : 0);
  const row = Math.round(yAdjusted / HEX_H) + 1;
  const clampedRow = Math.max(1, Math.min(ROW_COUNT, row));
  return { col: clampedCol, row: clampedRow };
}

// A-Z (0..25) → одна буква; далее AA, BB, CC, ... (двойные повторяющиеся буквы)
function colToLetters(col) {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  if (col < 26) return alpha[col];
  return alpha[col - 26].repeat(2);
}

// V-карта: col >= 0 → vA (col=0), vB, ..., vZ, vAA, ...
// U-карта: col <  0 → uA (col=-COL_COUNT, левый край), ..., uGG (col=-1, правый край U)
export function hexLabel(col, row) {
  if (col >= 0) return 'v' + colToLetters(col) + row;
  return 'u' + colToLetters(COL_COUNT + col) + row;
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
export function hexDistance(a, b) {
  const ca = offsetToCube(a.col, a.row);
  const cb = offsetToCube(b.col, b.row);
  return (Math.abs(ca.x - cb.x) + Math.abs(ca.y - cb.y) + Math.abs(ca.z - cb.z)) / 2;
}

export function hexToPixel(col, row) {
  // раздельные коэффициенты влево/вправо, знак от col
  const coef = col >= 0 ? DRIFT_COEF : DRIFT_COEF_LEFT;
  const x = GRID_OFFSET_X + col * COL_STEP + col * Math.abs(col) * coef;
  const isOdd = ((col % 2) + 2) % 2 === 1;
  const y = GRID_OFFSET_Y + (row - 1) * HEX_H + (isOdd ? ODD_OFFSET : 0);
  return { x, y };
}