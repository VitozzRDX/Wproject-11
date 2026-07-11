export const State = {
    selected: null,
    units: {},
    mfspent: false,
    fireGroup: [],
    movementGroup: [],
    movementStackHex: null,
    original_group: [],            // снимок mg при последнем Esc
    splitted_group: [],            // оставшиеся "в ожидании" при дроблении
    moved_movement_group: null,    // последний реально двинувшийся стек
    pendingMove: null,             // отложенный мув (Woods-Road: ждём UseWoods/UseRoad)
    fired_from_on_target_in_hex: {},   // { shooterHex: { targetId: targetHexAtFireTime } } — правило 3.3.3

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
