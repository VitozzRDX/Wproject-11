// Setup-фаза: расстановка юнитов из scenario.setup до начала игры.
// Юниты создаются один раз (initSetupSide + applyDiceRoll) и дальше просто
// перекладываются между панелью (uiLayer, hex=null) и картой (unitLayer, hex=...).
// В рали переходят в текущем состоянии — те же id, те же ноды.

import { State } from './state.js';
import { UIState } from './uiState.js';
import { spawn_unit, TEMPLATES, getImage, UNIT_IMAGE_SIZE } from './unitloading.js';
import { hexToPixel } from './hexUtils.js';
import { recalculateHexInstant } from './positioning.js';
import { Rules } from './rules.js';

// Счётчики по templateId — чтобы id юнитов были читаемыми: ge_447_01, ge_447_02, am_667_01, ...
const _idCounters = {};

// Константы раскладки setup-панели.
const PAD_X = 24;
const PAD_Y = 8;
const STACK_OFFSET = 3;         // смещение по X между одинаковыми юнитами в стопке
const GAP = 4;                  // вертикальный зазор между строками
const PANEL_Y = 135;
const PANEL_RIGHT_MARGIN = 51;

// Точка входа: вызывается из main.js после PhaseManager.setPhase('setup').
// State.currentScenario уже установлен в loadScenario — здесь дубль не нужен.
export function startSetup(scen) {
    initSetupSide(scen.setup.whoSetsUpFirst);
}

// Инициализирует setup-подфазу для стороны. Вызывается из startSetup и handler'а EndSetupSide.
export async function initSetupSide(side) {
    State.setupSide = side;              // сторона, которая сейчас расставляет; читается хендлерами и правилами
    State.setupSelectedUnits = [];       // id'шки выбранных юнитов (0..3); сброс при входе
    State.setupDiceRolled = false;       // защита от повторного ролла и расстановки до ролла
    State.idsInSetupPool = [];           // id'шки юнитов, которые сейчас в панели

    // scen.setup.sides — объект {defender: {...}, attacker: {...}}.
    // side — строка 'defender' | 'attacker'. sideCfg — конфиг конкретной стороны:
    //   { pool: [{templateId:'ge_447', count:9}, ...] }
    //   или с diceRoll: { pool: [...], diceRoll: {dice:'d6', outcomes:{...}} }
    const sideCfg = State.currentScenario.setup.sides[side];

    // Фиксированный pool — spawnим всех юнитов сразу (hex=null, inSetupPool=true).
    // for..await — последовательно (не параллельно); картинки уже в кэше, каждый spawn миллисекунды.
    if (sideCfg.pool) {
        for (const entry of sideCfg.pool) {
            for (let i = 0; i < entry.count; i++) {
                await _spawnPoolEntry(entry.templateId, side);
            }
        }
    }
    if (sideCfg.diceRoll) {
        UIState.addButton('RollDice', { x: 10, y: 60, label: 'RollDice' });
    }
    refreshSetupPanel();
    refreshEndSetupSideButton();
    console.log(`[Setup] ${side} starts, pool size=${State.idsInSetupPool.length}`);
}

// Spawnит одного юнита без карты, кладёт его node в uiLayer, пушит id в пул.
async function _spawnPoolEntry(templateId, side) {
    _idCounters[templateId] = (_idCounters[templateId] || 0) + 1;
    const n = String(_idCounters[templateId]).padStart(2, '0');
    const id = `${templateId}_${n}`;   // напр. ge_447_01, am_667_03
    await spawn_unit(templateId, id, null, State.uiLayer, side);
    State.units[id].inSetupPool = true;
    State.idsInSetupPool.push(id);
}

// Применяем результат dice-roll: ищем диапазон, в который попал roll, спавним соответствующий набор.
export async function applyDiceRoll(roll) {
    const sideCfg = State.currentScenario.setup.sides[State.setupSide];
    for (const [range, poolCfg] of Object.entries(sideCfg.diceRoll.outcomes)) {
        // range — '1' или '1-3'. '1-3' даст rangeStart=1, rangeEnd=3; '1' — оба =1.
        const parts = range.split('-').map(Number);
        const rangeStart = parts[0];
        const rangeEnd   = parts.length > 1 ? parts[1] : parts[0];
        if (roll >= rangeStart && roll <= rangeEnd) {
            for (const entry of poolCfg) {
                for (let i = 0; i < entry.count; i++) {
                    await _spawnPoolEntry(entry.templateId, State.setupSide);
                }
            }
            break;
        }
    }
    State.setupDiceRolled = true;
    // Поставим VP-порог Allied по результату броска.
    const winConditions = State.currentScenario.winConditions;
    const vpTargets = winConditions && winConditions.atGameEnd && winConditions.atGameEnd.targets;   // путь может отсутствовать в сценарии без VP-условия → каждый шаг проверяем на null
    if (vpTargets) {
        State.alliedVpTarget = vpTargets[String(roll)] ?? null;
        UIState.setAlliedVPText(`VP: ${State.alliedVP ?? 0} / ${State.alliedVpTarget ?? '-'}`);
    }
    UIState.removeButton('RollDice');
    refreshSetupPanel();
    refreshEndSetupSideButton();
}

// Пересчитать позиции юнитов в панели + попросить rendererUI нарисовать фон нужного размера.
export function refreshSetupPanel() {
    const ids = State.idsInSetupPool;
    if (!ids.length) {
        UIState.hideSetupPanel();
        return;
    }
    const items = _buildIDCoordsArr(ids);   // [{id, x, y}] — локальные координаты внутри панели
    const maxX = Math.max(...items.map(it => it.x));
    const maxY = Math.max(...items.map(it => it.y));
    const w = maxX + UNIT_IMAGE_SIZE + PAD_X * 2;
    const h = maxY + UNIT_IMAGE_SIZE + PAD_Y * 2;

    const stage = State.uiLayer.getStage();
    const panelX = stage.width() - w - PANEL_RIGHT_MARGIN;
    const panelY = PANEL_Y;

    // Фон рисует rendererUI (чтобы Konva-логика лежала там).
    UIState.showSetupPanel({ x: panelX, y: panelY, w, h });

    // Позиции самих юнитов — ставим прямо (без tween).
    for (const { id, x, y } of items) {
        const node = State.units[id].node;
        node.x(panelX + PAD_X + x);
        node.y(panelY + PAD_Y + y);
    }
    State.uiLayer.batchDraw();
}

// Проход по id'шкам пула: одинаковые templateId → в одну стопку (X сдвиг +3px),
// другой templateId → новая строка (Y += uh+GAP). Возвращает [{id, x, y}].
// Пример: [{id:'setup_1', x:0, y:0}, {id:'setup_2', x:3, y:0}, {id:'setup_7', x:0, y:48}, ...]
function _buildIDCoordsArr(ids) {   // ids: ['setup_1','setup_2',...]
    const items = [];
    let x = 0, y = 0, prevTpl = null;
    for (const id of ids) {
        const tpl = State.units[id].templateId;
        if (tpl === prevTpl) {
            x += STACK_OFFSET;
        } else {
            if (prevTpl !== null) y += UNIT_IMAGE_SIZE + GAP;
            x = 0;
        }
        items.push({ id, x, y });
        prevTpl = tpl;
    }
    return items;
}

// Кнопка EndSetupSide доступна когда пул пустой И (dice был брошен ИЛИ его не было вовсе).
export function refreshEndSetupSideButton() {
    const sideCfg = State.currentScenario.setup.sides[State.setupSide];
    const needsRoll = sideCfg.diceRoll && !State.setupDiceRolled;
    if (State.idsInSetupPool.length === 0 && !needsRoll) {
        UIState.addButton('EndSetupSide', { x: 10, y: 100, label: 'EndSetupSide' });
    } else {
        UIState.removeButton('EndSetupSide');
    }
}

// Пул → карта. Юнит переезжает: hex устанавливается, node переходит в unitLayer.
export function placeFromPool(unitId, hex) {
    const u = State.units[unitId];
    u.hex = hex;
    u.path = [{ hex, isRoad: Rules._isRoadHex(hex) }];
    u.inSetupPool = false;
    u.node.moveTo(State.unitLayer);
    const idx = State.idsInSetupPool.indexOf(unitId);
    if (idx >= 0) State.idsInSetupPool.splice(idx, 1);
    recalculateHexInstant(hex);   // поставить юнит в стандартную позицию стека нового hex'а
    refreshSetupPanel();
    refreshEndSetupSideButton();
}

// Мгновенное перемещение юнита между гексами на карте (без tween). Для setup-фазы.
export function instantUnitMoveFromHexToHex(unitId, newHex) {
    const u = State.units[unitId];
    const oldHex = u.hex;
    u.hex = newHex;
    u.path = [{ hex: newHex, isRoad: Rules._isRoadHex(newHex) }];
    recalculateHexInstant(oldHex);
    recalculateHexInstant(newHex);
}

// Карта → пул. Юнит переезжает обратно, вставляется рядом с сородичем для группировки стопки.
export function returnToPool(unitId) {
    const u = State.units[unitId];
    const oldHex = u.hex;
    u.hex = null;
    u.path = [];
    u.inSetupPool = true;
    u.node.moveTo(State.uiLayer);
    const tpl = u.templateId;
    const tplList = State.idsInSetupPool.map(id => State.units[id].templateId);
    const lastIdx = tplList.lastIndexOf(tpl);
    if (lastIdx >= 0) State.idsInSetupPool.splice(lastIdx + 1, 0, unitId);
    else              State.idsInSetupPool.push(unitId);
    recalculateHexInstant(oldHex);
    refreshSetupPanel();
    refreshEndSetupSideButton();
}
