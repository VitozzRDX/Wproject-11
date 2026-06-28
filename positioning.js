import { State } from './state.js';
import { hexToPixel } from './hexUtils.js';

const STEP = 6;   // сдвиг между юнитами в стеке (px)

// Пересчитать pixel-позиции для всех юнитов в указанном гексе
function recalculateHex(hex) {
    if (!hex) return;

    // ищем всех юнитов которые сейчас в этом гексе
    const ids = Object.values(State.units)
        .filter(u => u.hex?.col === hex.col && u.hex?.row === hex.row)
        .map(u => u.id);

    if (ids.length === 0) return;

    const center = hexToPixel(hex.col, hex.row);

    // расставляем по диагонали (как раньше в _calculateNewPos)
    ids.forEach((id, i) => {
        const offset = i - (ids.length - 1) / 2;
        const pos = {
            x: center.x + STEP * offset,
            y: center.y - STEP * offset,
        };
        State.setUnit(id, 'pos', pos);
    });
}

// Инициализация: подписываемся на изменения hex у юнитов
export function initPositioning() {
    State.subscribe((id, key, value, oldValue) => {
        if (key !== 'hex') return;
        // юнит переехал — пересчитать старый и новый гексы
        recalculateHex(oldValue);
        recalculateHex(value);
    });

    // Первичный проход — расставить юниты в гексах при загрузке
    const uniqueHexes = new Set();
    Object.values(State.units).forEach(u => {
        if (u.hex) uniqueHexes.add(`${u.hex.col}-${u.hex.row}`);
    });
    uniqueHexes.forEach(key => {
        const [col, row] = key.split('-').map(Number);
        recalculateHex({ col, row });
    });
}
