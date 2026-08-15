import { UIState } from './uiState.js';

let uiLayer;
const losLines = [];

export const RendererUI = {
    init(layer) {
        uiLayer = layer;

        UIState.subscribe((action, label, data) => {
            if (action === 'add')            RendererUI.drawButton(data);
            if (action === 'remove')         RendererUI.removeButton(label);
            if (action === 'flashLOS')       RendererUI.drawLOSLine(data.from, data.to, data.color);
            if (action === 'flashHitPoints') RendererUI.drawHitPoints(data);
        });

        // первичная отрисовка уже добавленных кнопок
        Object.values(UIState.buttons).forEach(def => RendererUI.drawButton(def));
    },

    drawLOSLine(from, to, color = 'red') {
        const line = new Konva.Line({
            points: [from.x, from.y, to.x, to.y],
            stroke: color,
            strokeWidth: 1,
            listening: false,
        });
        uiLayer.add(line);
        losLines.push(line);
        uiLayer.batchDraw();
    },

    drawHitPoints(points) {
        points.forEach(p => {
            const circle = new Konva.Circle({
                x: p.x, y: p.y,
                radius: 3,
                fill: 'lime',
                listening: false,
            });
            uiLayer.add(circle);
        });
        uiLayer.batchDraw();
    },

    drawButton({ x, y, label }) {
        RendererUI.removeButton(label);
        const group = new Konva.Group({ x, y, name: `btn-${label}` });
        group.setAttr('buttonLabel', label);
        const rect  = new Konva.Rect({ width: 120, height: 36, fill: '#333', cornerRadius: 4 });
        const text  = new Konva.Text({ text: label, fill: '#fff',
                        width: 120, height: 36, align: 'center', verticalAlign: 'middle' });
        group.add(rect, text);
        uiLayer.add(group);
        uiLayer.batchDraw();
    },

    removeButton(label) {
        const btn = uiLayer.findOne(`.btn-${label}`);
        if (btn) { btn.destroy(); uiLayer.batchDraw(); }
    },
};
