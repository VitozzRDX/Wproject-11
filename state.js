import { UNIT_IMAGE_SIZE } from './unitloading.js';

export const State = {
    selected: null,
    units: {},
    mfspent: false,
    fireGroup: [],
    fireGroupHexesArray: [],       // уникальные хексы стрелков FG
    movementGroup: [],
    movementStackHex: null,
    original_group: [],            // снимок mg при последнем Esc
    splitted_group: [],            // оставшиеся "в ожидании" при дроблении
    moved_movement_group: null,    // последний реально двинувшийся стек
    pendingMove: null,             // отложенный мув (Woods-Road: ждём UseWoods/UseRoad)
    pendingSmoke: false,           // выбран PlaceSmoke, ждём клик по хексу (свой = 1 MF, соседний = 2 MF)
    fired_from_on_target_in_hex: {},   // { shooterHex: { targetId: targetHexAtFireTime } } — правило 3.3.3
    residualFP: {},                    // { "col,row": fp } — Residual FP counters по хексам (3.3.5)
    dynamicTerrain: {},                // { "col,row": ['smoke', ...] } — runtime terrain overlay
    elr: { german: 3, soviet: 3 },     // Experience Level Rating по силе (5.1)
    orchardInSeason: true,             // апр-окт: orchard блокирует LoS между разными elevation
    routingUnit: null,                 // id юнита, выбранного для раута в RtPh
    pendingLowCrawl: false,            // нажата кнопка LowCrawl — следующий RoutMove работает по правилам LC
    advanceSelected: null,             // id юнита выбранного для advance-хода (APh)
    ccHexes: [],                       // хексы с CC-ситуациями (opposing infantry, populated от Advance handler)
    currentCCHex: null,                // хекс, который сейчас разрешает attacker
    ccSelectedIds: [],                 // накапливается через все Confirm'ы (сброс только на SelectCCHex/CCPh exit)
    ccAttackerAttackers: [],           // pool: свои attacker-юниты для текущей атаки (attacker declare)
    ccAttackerDefenders: [],           // pool: enemy targets для текущей атаки (attacker declare)
    ccAttackerList: [],                // подтверждённые атаки attacker-стороны
    ccDefenderAttackers: [],           // pool: свои defender-юниты (defender declare)
    ccDefenderDefenders: [],           // pool: enemy targets (defender declare)
    ccDefenderList: [],                // подтверждённые атаки defender-стороны
    ccDefenderDeclaring: false,        // true когда StartDefenderCC нажат
    ambushSide: null,                  // 'attacker' | 'defender' | null — сторона получившая ambush
    ccAmbushRound: null,               // 'round 1' | 'round 2' | null — раунд ambush-резолва
    rallySide: null,                   // 'attacker' | 'defender' | null — чья сейчас полу-фаза RPh
    rallySubPhase: null,               // 'recovery' | 'transfer' | null — текущая под-фаза RPh
    transferHex: null,                 // hex с открытой transfer-панелью (RPh)
    idTransferSelectedUnit: null,      // id оружия выбранного для transfer
    idUnitToGetWeapon: null,           // id пехоты — получатель weapon'а
    recoveryHex: null,                 // hex выбранный для Recovery Attempt (RPh)
    repairHex: null,                   // hex выбранный для Repair Attempt (RPh)
    attackerExtraMMCUsed: false,       // attacker уже использовал бонусную попытку на non-selfRally MMC
    selfRallyUnit: null,               // выбранный юнит для SelfRallyAttempt
    unitRallyUnit: null,               // выбранный юнит для UnitRallyAttempt
    currentScenario: null,             // ссылка на объект загруженного сценария (для setup и т.п.)
    setupSide: null,                   // 'attacker' | 'defender' | null — чья очередь расставлять
    idsInSetupPool: [],                // id юнитов, которые сейчас в setup-панели (ещё не на карте)
    setupSelectedUnits: [],            // id'шки выбранных юнитов setup (0..3; 1 — обычный выбор, 3 — dblclick-набор)
    playerTurn: 1,                     // 1..gameLength; +1 на каждый side-swap (3.9 Turn Record)
    hexControl: {},                    // {"col-row": "axis"|"allied"} — какая сторона контролирует hex (A26)
    alliedVP: 0,                       // накопленные Allied VP (убитые Axis)
    alliedVpTarget: null,              // VP-порог; выставляется при setup-dice-roll
    setupDiceRolled: false,            // true если dice-roll уже выполнен для текущей стороны
    uiLayer: null,                     // ссылка на uiLayer — нужна setupPhase для перемещения нод между слоями

    // массив подписчиков (Positioning, Renderer и т.д.)
    subscribers: [],

    addUnit(unit) {
        this.units[unit.id] = unit;
    },

    setUnit(id, key, value) {
        const oldValue = this.units[id]?.[key];

        if (key === 'pos') {
            // Центрирование по единой константе UNIT_IMAGE_SIZE (отрисованный размер юнита),
            // а не unit.image.width (native размер гифки).
            this.units[id].x = value.x - UNIT_IMAGE_SIZE / 2;
            this.units[id].y = value.y - UNIT_IMAGE_SIZE / 2;
        } else {
            this.units[id][key] = value;
        }

        // уведомляем всех подписчиков
        this.subscribers.forEach(sub => sub(id, key, value, oldValue));
    },

    // подписка — каждый модуль вызывает при инициализации
    subscribe(handler) {
        this.subscribers.push(handler);
    },
}

// DEBUG: экспорт в глобал для удобной отладки из DevTools Console
if (typeof window !== 'undefined') window.State = State;
