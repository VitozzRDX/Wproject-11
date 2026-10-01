// Save/Load system — snapshot State в localStorage.
// Ограничения: Map/Set поля юнитов (routPathHexes, hexToHexesCostsMap) не сериализуются,
// при load юнит в середине RtPh потеряет коридор, игроку надо кликнуть SelectRouter заново.

import { State } from './state.js';
import { PhaseManager } from './phase_manager.js';
import { spawn_unit } from './unitloading.js';
import { hexToPixel, isSameHex } from './hexUtils.js';

const KEY = 'wproject11.save';

// Поля State (кроме .units и .subscribers), которые сохраняем.
const STATE_FIELDS = [
    'orchardInSeason', 'elr', 'residualFP', 'dynamicTerrain',
    'rallySide', 'rallySubPhase', 'transferHex', 'idTransferSelectedUnit', 'idUnitToGetWeapon',
    'recoveryHex', 'repairHex', 'selfRallyUnit', 'unitRallyUnit', 'attackerExtraMMCUsed',
    'movementStackHex', 'moved_movement_group', 'mfspent', 'pendingMove', 'pendingSmoke',
    'splitted_group', 'original_group', 'pendingLowCrawl', 'routingUnit',
    'advanceSelected',
    'ccHexes', 'currentCCHex', 'ccSelectedIds',
    'ccAttackerAttackers', 'ccAttackerDefenders', 'ccAttackerList',
    'ccDefenderAttackers', 'ccDefenderDefenders', 'ccDefenderList',
    'ccDefenderDeclaring', 'ambushSide', 'ccAmbushRound',
    'movementGroup', 'fireGroup', 'fireGroupHexesArray', 'fired_from_on_target_in_hex',
];

// Поля юнита, которые НЕ сохраняем (Konva и производные — не JSON-сериализуемы).
const UNIT_SKIP = new Set([
    'image', 'brokenImage', 'node', 'x', 'y',
    // Map/Set — JSON.stringify сделает из них {} и ломает load. Теряем rout-кэш (user повторно кликнет SelectRouter).
    'routPathHexes', 'hexToHexesCostsMap', 'routMinCostToShelter',
]);

export function save() {
    // Сериализуем всех юнитов. На каждом юните пример полей:
    //   { id:'unit_01', side:'defender', hex:{col:29,row:4}, broken:false, firepower:4,
    //     image:<Konva.Image>, node:<Konva.Group>, ... }
    // image/node/brokenImage пропускаем (UNIT_SKIP) — JSON не возьмёт.
    const units = {};
    for (const [unitId, unit] of Object.entries(State.units)) {
        const unitData = {};
        for (const [fieldName, fieldValue] of Object.entries(unit)) {
            if (UNIT_SKIP.has(fieldName)) continue;
            unitData[fieldName] = fieldValue;
        }
        units[unitId] = unitData;
    }

    // Глобальные поля State + текущая фаза.
    const snapshot = { phase: PhaseManager.getPhase(), units };
    for (const field of STATE_FIELDS) snapshot[field] = State[field];

    localStorage.setItem(KEY, JSON.stringify(snapshot));
    console.log('[save] snapshot saved');
}

export async function load() {
    const raw = localStorage.getItem(KEY);
    if (!raw) { console.log('[load] no save found'); return; }
    const snapshot = JSON.parse(raw);

    // 1. Уничтожить все текущие Konva-ноды и очистить State.units.
    for (const unit of Object.values(State.units)) unit.node?.destroy();
    State.units = {};

    // 2. Reset сохраняемых полей до undefined, затем залить из snapshot.
    //    Reset защищает от "мусора" в полях, которых в snapshot нет (на случай версии).
    for (const field of STATE_FIELDS) State[field] = undefined;
    for (const field of STATE_FIELDS) State[field] = snapshot[field];

    // 3. Фаза.
    PhaseManager.setPhase(snapshot.phase);

    // 4. Пересоздать юниты: сначала infantry, потом carried (carried берут hex от possessor'а).
    const allUnits = Object.values(snapshot.units);
    const infantryFirst = [
        ...allUnits.filter(u => u.category === 'infantry'),
        ...allUnits.filter(u => u.category === 'carried'),
    ];
    for (const saved of infantryFirst) {
        const unit = await spawn_unit(saved.templateId, saved.id, saved.hex, State.unitLayer, saved.side);
        // Применить все сохранённые поля через setUnit (чтобы renderer-подписчики обновили визуал).
        // Пропускаем служебные (image/node/...) и те, что spawn_unit уже установил.
        // 'broken' применяем особым путём — через setUnit он запускает flip-tween, которая
        // анимирует x и ломает позиционирование в стеке. Ставим флаг + подменяем картинку напрямую.
        for (const [fieldName, fieldValue] of Object.entries(saved)) {
            if (UNIT_SKIP.has(fieldName)) continue;
            if (fieldName === 'id' || fieldName === 'side' || fieldName === 'hex' || fieldName === 'templateId') continue;
            if (fieldName === 'broken') continue;   // обработаем ниже без tween
            State.setUnit(saved.id, fieldName, fieldValue);
        }
        if (saved.broken) {
            const u = State.units[saved.id];
            u.broken = true;
            if (u.brokenImage) u.node.findOne('Image').image(u.brokenImage);
        }
    }
    // Расставить юниты по стекам без tween-анимации (чтобы не было race'ов параллельных .to()).
    // Копия логики positioning.recalculateHex, но позиция ставится напрямую через node.position().
    const STEP = 6;
    const uniqueHexes = new Set();
    for (const u of Object.values(State.units)) {
        if (u.hex) uniqueHexes.add(`${u.hex.col},${u.hex.row}`);
    }
    for (const key of uniqueHexes) {
        const [col, row] = key.split(',').map(Number);
        const hex = { col, row };
        const inHex = Object.values(State.units).filter(u => u.hex && isSameHex(u.hex, hex));
        // Stack order: carried без possessor'а первыми; потом infantry + его possessed carried.
        const stack = [];
        for (const u of inHex) if (u.category === 'carried' && !u.possessorId) stack.push(u);
        for (const u of inHex) {
            if (u.category !== 'infantry') continue;
            stack.push(u);
            for (const w of inHex) if (w.category === 'carried' && w.possessorId === u.id) stack.push(w);
        }
        const center = hexToPixel(col, row);
        stack.forEach((unit, index) => {
            const offset = index - (stack.length - 1) / 2;
            const nx = center.x + STEP * offset;
            const ny = center.y - STEP * offset;
            // Обновляем state (без триггера renderer'а на 'pos'): пишем x,y напрямую.
            unit.x = nx - unit.image.width  / 2;
            unit.y = ny - unit.image.height / 2;
            unit.node.position({ x: unit.x, y: unit.y });
            unit.node.moveToTop();
        });
    }
    State.unitLayer?.batchDraw();

    console.log('[load] snapshot loaded');
}
