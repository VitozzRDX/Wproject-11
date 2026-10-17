export const UIState = {
    buttons: {},
    subscribers: [],

    addButton(label, def) {
        this.buttons[label] = def;
        this.subscribers.forEach(sub => sub('add', label, def));
    },

    removeButton(label) {
        if (!this.buttons[label]) return;
        delete this.buttons[label];
        this.subscribers.forEach(sub => sub('remove', label));
    },

    addImage(name, def) {
        this.images ??= {};
        this.images[name] = def;
        this.subscribers.forEach(sub => sub('addImage', name, def));
    },

    removeImage(name) {
        if (!this.images?.[name]) return;
        delete this.images[name];
        this.subscribers.forEach(sub => sub('removeImage', name));
    },

    rotateImage(name, delta) {
        this.subscribers.forEach(sub => sub('rotateImage', name, { delta }));
    },

    // Переключение значка стороны (Axis / Allied) поверх крутилки турнфазы.
    changeBadge(isAxis) {
        this.subscribers.forEach(sub => sub('changeBadge', null, { isAxis }));
    },

    // Делает кнопку полупрозрачной и неактивной (без удаления).
    fadeButton(label) {
        this.subscribers.forEach(sub => sub('fadeButton', label));
    },

    // Перерисовать кнопку с нуля по уже сохранённому def'у — «восстановить» после fadeButton.
    // Шлём событие 'add' повторно: rendererUI вызовет drawButton, который сначала удалит старую
    // (возможно затушёванную) ноду, затем создаст свежую с исходными цветами и кантиком.
    redrawButton(label) {
        const def = this.buttons[label];
        if (!def) return;
        this.subscribers.forEach(sub => sub('add', label, def));
    },

    // bounds: {x, y, w, h} — rendererUI рисует Konva.Rect-подложку с этими размерами.
    showSetupPanel(bounds) {
        this.subscribers.forEach(sub => sub('showSetupPanel', null, { bounds }));
    },

    hideSetupPanel() {
        this.subscribers.forEach(sub => sub('hideSetupPanel', null, {}));
    },

    // hexes: массив {col,row} — подсветка легальной зоны расстановки для выбранного юнита.
    setSetupBounds(hexes) {
        this.subscribers.forEach(sub => sub('setSetupBounds', null, { hexes }));
    },

    // Пара d6 — colored (красный) и white. Отображается под крутилкой; клик скрывает.
    showDice(colored, white) {
        this.subscribers.forEach(sub => sub('showDice', null, { colored, white }));
    },
    hideDice() {
        this.subscribers.forEach(sub => sub('hideDice', null, {}));
    },

    // Текст номера turn'а под крутилкой: "Turn 2 / 7".
    setTurnText(text) {
        this.subscribers.forEach(sub => sub('setTurnText', null, { text }));
    },

    // Текст счётчика контроля hill-гексов под кубиками: "Hill: Ax 30 / Al 15".
    setHillControlText(text) {
        this.subscribers.forEach(sub => sub('setHillControlText', null, { text }));
    },

    // Счётчик VP Allied под Hill-counter: "VP: 7 / 18".
    setAlliedVPText(text) {
        this.subscribers.forEach(sub => sub('setAlliedVPText', null, { text }));
    },

    // Счётчик VP Axis под Allied-счётчиком: "VP: 3 / 12".
    setAxisVPText(text) {
        this.subscribers.forEach(sub => sub('setAxisVPText', null, { text }));
    },

    // Панель с иконками юнитов текущей MG/FG (правый край под счётчиками).
    showGroupPanel(payload) {
        this.subscribers.forEach(sub => sub('showGroupPanel', null, payload));
    },
    hideGroupPanel() {
        this.subscribers.forEach(sub => sub('hideGroupPanel', null, null));
    },

    // Панель целей по итогу огня: по строке на цель, слева before, справа after.
    showTargetPanel(targets) {
        this.subscribers.forEach(sub => sub('showTargetPanel', null, { targets }));
    },
    hideTargetPanel() {
        this.subscribers.forEach(sub => sub('hideTargetPanel', null, null));
    },

    // Текст с итоговым FP у hex'а-цели при hover в огневой фазе.
    setHoverFP(hex, fp) {
        this.subscribers.forEach(sub => sub('setHoverFP', null, { hex, fp }));
    },
    clearHoverFP() {
        this.subscribers.forEach(sub => sub('clearHoverFP', null, null));
    },

    subscribe(handler) {
        this.subscribers.push(handler);
    },

    flashLOS(from, to, color) {
        this.subscribers.forEach(sub => sub('flashLOS', null, { from, to, color }));
    },

    // Снять все LoS-линии (вызывается перед обработкой результативного клика).
    clearLOS() {
        this.subscribers.forEach(sub => sub('clearLOS', null, {}));
    },

    flashHitPoints(points) {
        this.subscribers.forEach(sub => sub('flashHitPoints', null, points));
    },

    setResidualFP(hex, fp) {
        this.subscribers.forEach(sub => sub('setResidualFP', null, { hex, fp }));
    },

    setSmoke(hex) {
        this.subscribers.forEach(sub => sub('setSmoke', null, { hex }));
    },

    setRoutLegalHexes(hexes) {
        this.subscribers.forEach(sub => sub('setRoutLegalHexes', null, { hexes }));
    },

    setRoutShelters(hexes) {
        this.subscribers.forEach(sub => sub('setRoutShelters', null, { hexes }));
    },

    setRoutPathHexes(hexes) {
        this.subscribers.forEach(sub => sub('setRoutPathHexes', null, { hexes }));
    },

    setCCHexes(hexes) {
        this.subscribers.forEach(sub => sub('setCCHexes', null, { hexes }));
    },

    showCCPanel(units) {
        this.subscribers.forEach(sub => sub('showCCPanel', null, { units }));
    },

    hideCCPanel() {
        this.subscribers.forEach(sub => sub('hideCCPanel', null, {}));
    },

    setCCPanelSelect(selectedIds) {
        this.subscribers.forEach(sub => sub('setCCPanelSelect', null, { selectedIds }));
    },

    showTransferPanel(units) {
        this.subscribers.forEach(sub => sub('showTransferPanel', null, { units }));
    },

    hideTransferPanel() {
        this.subscribers.forEach(sub => sub('hideTransferPanel', null, {}));
    },

    setTransferPanelSelect(selectedIds) {
        this.subscribers.forEach(sub => sub('setTransferPanelSelect', null, { selectedIds }));
    },
}
