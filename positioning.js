import { State } from './state.js';
import { hexToPixel, isSameHex } from './hexUtils.js';

const STEP = 6;   // сдвиг между сущностями в стеке (px)

// Порядок стека (снизу вверх):
//   1) carried без possessor'а — на самом дне
//   2) infantry по порядку добавления, и сразу после каждого — его possessed carried
function _stackOrder(hex) {
    const inHex = Object.values(State.units)
        .filter(u => u.hex && isSameHex(u.hex, hex));

    const stack = [];

    // 1) carried без possessor'а
    for (const u of inHex) {
        if (u.category === 'carried' && !u.possessorId) stack.push(u);
    }

    // 2) infantry + его possessed carried
    for (const u of inHex) {
        if (u.category !== 'infantry') continue;
        stack.push(u);
        for (const w of inHex) {
            if (w.category === 'carried' && w.possessorId === u.id) stack.push(w);
        }
    }

    return stack;
}

export function recalculateHex(hex) {
    if (!hex) return;

    const stack = _stackOrder(hex);
    if (stack.length === 0) return;

    const center = hexToPixel(hex.col, hex.row);

    stack.forEach((unit, index) => {
        const offset = index - (stack.length - 1) / 2;
        const pos = {
            x: center.x + STEP * offset,
            y: center.y - STEP * offset,
        };
        State.setUnit(unit.id, 'pos', pos);
    });

    // z-order в Konva: последовательный moveToTop → каждый следующий поверх предыдущего
    stack.forEach(unit => unit.node.moveToTop());
}

// Инициализация: подписываемся на изменения hex у юнитов
export function initPositioning() {
    State.subscribe((id, key, value, oldValue) => {
        if (key !== 'hex') return;
        recalculateHex(oldValue);
        recalculateHex(value);
    });

    // Первичный проход — расставить всё в гексах при загрузке
    const uniqueHexes = new Set();
    Object.values(State.units).forEach(u => {
        if (u.hex) uniqueHexes.add(`${u.hex.col},${u.hex.row}`);
    });
    uniqueHexes.forEach(key => {
        const [col, row] = key.split(',').map(Number);
        recalculateHex({ col, row });
    });
}
