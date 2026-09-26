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

    // массив подписчиков (Positioning, Renderer и т.д.)
    subscribers: [],

    addUnit(unit) {
        this.units[unit.id] = unit;
    },

    setUnit(id, key, value) {
        const oldValue = this.units[id]?.[key];

        if (key === 'pos') {
            const unit = this.units[id];
            this.units[id].x = value.x - unit.image.width  / 2;
            this.units[id].y = value.y - unit.image.height / 2;
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
