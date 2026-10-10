// Save/Load system — snapshot State в localStorage.
// Ограничения: Map/Set поля юнитов (routPathHexes, hexToHexesCostsMap) не сериализуются,
// при load юнит в середине RtPh потеряет коридор, игроку надо кликнуть SelectRouter заново.

import { State } from './state.js';
import { UIState } from './uiState.js';
import { RendererUI } from './rendererUI.js';
import { PhaseManager } from './phase_manager.js';
import { spawn_unit } from './unitloading.js';
import { recalculateHexInstant } from './positioning.js';
import { scenarios } from './scenarios.js';
import { refreshSetupPanel, refreshEndSetupSideButton } from './setupPhase.js';
import { refreshSideBadge } from './main.js';
import { refreshSetupBoundsHighlight } from './engine.js';

const KEY = 'wproject11.save';

// Имена полей State, которые сохраняем в snapshot.
// Остальное State не сериализуется: units — отдельной веткой, subscribers — функции,
// unitLayer/uiLayer — Konva-объекты.
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
    // setup-фаза
    'setupSide', 'idsInSetupPool', 'setupSelectedUnits', 'setupDiceRolled',
];

// Поля юнита, которые НЕ сохраняем — Konva-ноды и Map/Set, не JSON-сериализуются.
const UNIT_FIELDS_SKIP = new Set([
    'image', 'brokenImage', 'node', 'x', 'y',
    'routPathHexes', 'hexToHexesCostsMap', 'routMinCostToShelter',
]);

// Обратный поиск ключа по значению. Проходим словарь scenarios: для каждой пары
// [name, obj] проверяем ту же ли ссылку в памяти передали — если да, возвращаем имя.
function _findScenarioName(scen) {   // scen: объект сценария, например scenarios.A — {hexmapModule, cardVisuals, setup, ...}
    if (!scen) return null;
    for (const [name, obj] of Object.entries(scenarios)) {
        if (obj === scen) return name;
    }
    return null;
}

// --- save ---

export function save() {
    const snapshot = _buildSnapshot();
    // JSON.stringify превращает объект в строку вида '{"phase":"movement","units":{...}}'.
    // localStorage хранит только строки.
    localStorage.setItem(KEY, JSON.stringify(snapshot));
    UIState.redrawButton('Load');   // кнопка Load могла быть гашена из-за отсутствия сейва — переподнимаем
    console.log('[save] snapshot saved');
}

// Есть ли сохранёнка в localStorage.
export function hasSave() {
    return localStorage.getItem(KEY) !== null;
}

function _buildSnapshot() {
    const snapshot = {
        phase: PhaseManager.getPhase(),
        units: _serializeUnits(),
        setupScenarioName: _findScenarioName(State.currentScenario),
        // Снимок UI — кнопки и картинки на момент сохранения. На load re-add из этого.
        ui: {
            buttons: UIState.buttons,
            images:  UIState.images ?? {},
        },
    };
    for (const field of STATE_FIELDS) snapshot[field] = State[field];
    return snapshot;
}

// Пройти по всем юнитам, вытащить все их поля кроме Konva-нод и несериализуемых.
function _serializeUnits() {
    const units = {};
    for (const [unitId, unit] of Object.entries(State.units)) {
        units[unitId] = _serializeOneUnit(unit);
    }
    return units;
}

// Собрать плоский объект из полей юнита. Пары [ключ, значение] — например:
// ['id','ge_447_01'], ['side','defender'], ['hex',{col:38,row:9}], ['image',<HTMLImageElement>] (пропустим).
function _serializeOneUnit(unit) {
    const data = {};
    for (const [fieldName, fieldValue] of Object.entries(unit)) {
        if (UNIT_FIELDS_SKIP.has(fieldName)) continue;
        data[fieldName] = fieldValue;
    }
    return data;
}

// --- load ---

export async function load() {
    const raw = localStorage.getItem(KEY);
    if (!raw) { console.log('[load] no save found'); return; }
    const snapshot = JSON.parse(raw);

    _clearCurrentUI();
    _destroyCurrentUnits();
    _restoreStateFields(snapshot);
    PhaseManager.setPhase(snapshot.phase);
    await _respawnUnits(snapshot);
    _restackHexes();
    _restoreUI(snapshot);
    // addImage асинхронный — rotateImage до создания ноды был бы no-op. Отложим на tick.
    setTimeout(() => _restoreTurnphaseRotation(snapshot.phase), 50);
    _restoreSetupPanelIfNeeded(snapshot);
    _restoreSetupBoundsHighlightIfNeeded(snapshot);
    _restoreSmokeVisuals();

    console.log('[load] snapshot loaded');
}

// Пере-отрисовать дым из State.dynamicTerrain. State поле восстановлено, но clearAll уничтожил
// визуальные ноды — нужно заново дёрнуть setSmoke для каждого hex с тегом 'smoke'.
function _restoreSmokeVisuals() {
    for (const [key, tags] of Object.entries(State.dynamicTerrain ?? {})) {
        if (!tags.includes('smoke')) continue;
        const [col, row] = key.split('-').map(Number);
        UIState.setSmoke({ col, row });
    }
}

// Снести текущие кнопки, картинки и визуальные остатки (LOS, residual, крутилка, значки, оверлеи).
function _clearCurrentUI() {
    for (const b of Object.keys(UIState.buttons))      UIState.removeButton(b);
    for (const n of Object.keys(UIState.images ?? {})) UIState.removeImage(n);
    RendererUI.removeSetupPanel();   // Konva.Rect name='setupPanel' — clearAll его не чистит
    RendererUI.clearAll();
}

// Крутилка turnphase поворачивается на -45° за фазу (engine.NextPhase). После load переустанавливаем
// поворот явно, т.к. он хранится на Konva-ноде, а при restoreUI создаётся новая нода с rotation=0.
const PHASES_ORDER = ['rally', 'prepFire', 'movement', 'defensiveFire', 'advancingFire', 'rout', 'advance', 'closeCombat'];
function _restoreTurnphaseRotation(phase) {
    const idx = PHASES_ORDER.indexOf(phase);
    if (idx <= 0) return;   // Rally = 0, по умолчанию
    UIState.rotateImage('turnphase', idx * -45);
}

// Восстановить кнопки и картинки из snapshot и выставить активный бок-значок.
function _restoreUI(snapshot) {
    for (const [label, def] of Object.entries(snapshot.ui?.buttons ?? {})) UIState.addButton(label, def);
    for (const [name,  def] of Object.entries(snapshot.ui?.images  ?? {})) UIState.addImage(name, def);
    // changeBadge переключает видимость sideAllied/sideAxis — не хранится в UIState,
    // вычисляется из нации attacker-пехоты. Задержка — чтобы addImage успел создать Konva-ноды.
    setTimeout(refreshSideBadge, 50);
}

// Снести Konva-ноды текущих юнитов и очистить State.units.
function _destroyCurrentUnits() {
    for (const unit of Object.values(State.units)) unit.node?.destroy();
    State.units = {};
}

// Залить STATE_FIELDS из snapshot + восстановить ссылку на сценарий по имени.
// Сначала всё в undefined — защита от мусора в полях, которых в snapshot нет.
function _restoreStateFields(snapshot) {
    for (const field of STATE_FIELDS) State[field] = undefined;
    for (const field of STATE_FIELDS) State[field] = snapshot[field];
    State.currentScenario = snapshot.setupScenarioName ? scenarios[snapshot.setupScenarioName] : null;
}

// Пересоздать юниты. Infantry сначала, потом carried (carried берут hex от possessor'а).
// Для пул-юнитов (inSetupPool) переносим node на uiLayer.
async function _respawnUnits(snapshot) {
    const allUnits = Object.values(snapshot.units);
    const order = [
        ...allUnits.filter(u => u.category === 'infantry'),
        ...allUnits.filter(u => u.category === 'carried'),
    ];
    for (const saved of order) {
        const unit = await spawn_unit(saved.templateId, saved.id, saved.hex, State.unitLayer, saved.side);
        if (saved.inSetupPool) unit.node.moveTo(State.uiLayer);
        _applySavedFields(saved);
    }
}

// Применить сохранённые поля к уже созданному юниту через setUnit (чтобы подписчики обновили визуал).
// Служебные поля из UNIT_FIELDS_SKIP и те, что spawn_unit уже установил — пропускаем.
// 'broken' применяется напрямую (без setUnit), иначе renderer запустил бы flip-tween,
// которая анимирует x и ломает позиционирование в стеке.
function _applySavedFields(saved) {
    for (const [fieldName, fieldValue] of Object.entries(saved)) {
        if (UNIT_FIELDS_SKIP.has(fieldName)) continue;
        if (fieldName === 'id' || fieldName === 'side' || fieldName === 'hex' || fieldName === 'templateId') continue;
        if (fieldName === 'broken') continue;
        State.setUnit(saved.id, fieldName, fieldValue);
    }
    if (saved.broken) {
        const u = State.units[saved.id];
        u.broken = true;
        if (u.brokenImage) u.node.findOne('Image').image(u.brokenImage);
    }
}

// Расставить юниты по стекам без tween — для юнитов на карте (hex != null).
// Пул-юниты (hex=null) здесь не трогаем — ими займётся refreshSetupPanel.
function _restackHexes() {
    const uniqueHexes = new Set();
    for (const u of Object.values(State.units)) {
        if (u.hex) uniqueHexes.add(`${u.hex.col},${u.hex.row}`);
    }
    for (const key of uniqueHexes) {
        const [col, row] = key.split(',').map(Number);
        recalculateHexInstant({ col, row });
    }
    State.unitLayer?.batchDraw();
}

// Если грузимся в setup-фазу — попросить setupPhase перерисовать панель.
// Это поставит пул-юнитов на их места в панели + отрисует фон-подложку.
function _restoreSetupPanelIfNeeded(snapshot) {
    if (snapshot.phase !== 'setup') return;
    refreshSetupPanel();
    refreshEndSetupSideButton();
}

// Если грузимся в setup-фазу и был выделен юнит — пересчитать подсветку легальной зоны.
function _restoreSetupBoundsHighlightIfNeeded(snapshot) {
    if (snapshot.phase !== 'setup') return;
    if (State.setupSelectedUnits.length === 0) return;   // в save нет выделения — подсвечивать нечего
    refreshSetupBoundsHighlight();
}
