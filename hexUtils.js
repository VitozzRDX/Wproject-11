// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Outer radius (center → vertex), px */
 const R = 112 / 3;

/** Half horizontal step, px */
 const RX = 37.35;

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
 const GRID_OFFSET_X = RX - COL_STEP / 2 - 5;

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
  const col = Math.round((px - GRID_OFFSET_X) / COL_STEP);
  const clampedCol = Math.max(0, Math.min(COL_COUNT - 1, col));
  const yAdjusted = py - GRID_OFFSET_Y - (clampedCol % 2 === 1 ? ODD_OFFSET : 0);
  const row = Math.round(yAdjusted / HEX_H) + 1;
  const clampedRow = Math.max(1, Math.min(ROW_COUNT, row));
  return { col: clampedCol, row: clampedRow };
}

function colToLetters(col) {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  if (col < 26) return alpha[col];
  const hi = Math.floor((col - 26) / 26);
  const lo = (col - 26) % 26;
  return alpha[hi] + alpha[lo];
}

export function hexLabel(col, row) {
  return colToLetters(col) + row;
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
  const x = GRID_OFFSET_X + col * COL_STEP;
  const y = GRID_OFFSET_Y + (row - 1) * HEX_H + (col % 2 === 1 ? ODD_OFFSET : 0);
  return { x, y };
}