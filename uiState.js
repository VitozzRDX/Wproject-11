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

    subscribe(handler) {
        this.subscribers.push(handler);
    },

    flashLOS(from, to, color) {
        this.subscribers.forEach(sub => sub('flashLOS', null, { from, to, color }));
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
}
