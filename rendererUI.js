import { UIState } from './uiState.js';
import { hexToPixel } from './hexUtils.js';

// Два слоя: uiLayer — screen-fixed (кнопки, крутилка); worldFxLayer — world-anchored (LoS, residual, smoke).
let uiLayer;
let worldFxLayer;
const losLines = [];
const residualNodes = new Map();   // hexKey → Konva.Group для residual FP счётчиков

export const RendererUI = {
    // Очищает residualFP-счётчики и LoS-линии на worldFxLayer + все .img-* на uiLayer.
    // Кнопки не трогаем — ими управляет UIState через add/remove.
    clearAll() {
        for (const [, node] of residualNodes) node.destroy();
        residualNodes.clear();
        losLines.forEach(l => l.destroy());
        losLines.length = 0;
        worldFxLayer?.batchDraw();
        // Удалить все .img-* (крутилка и другие персистентные UI-картинки)
        uiLayer?.getChildren(n => n.name()?.startsWith('img-')).forEach(n => n.destroy());
        uiLayer?.batchDraw();
    },

    init(ui, worldFx) {
        uiLayer      = ui;
        worldFxLayer = worldFx;

        UIState.subscribe((action, label, data) => {
            if (action === 'add')            RendererUI.drawButton(data);
            if (action === 'remove')         RendererUI.removeButton(label);
            if (action === 'addImage')       RendererUI.drawImage(label, data);
            if (action === 'removeImage')    RendererUI.removeImage(label);
            if (action === 'rotateImage')    RendererUI.rotateImage(label, data.delta);
            if (action === 'flashLOS')       RendererUI.drawLOSLine(data.from, data.to, data.color);
            if (action === 'flashHitPoints') RendererUI.drawHitPoints(data);
            if (action === 'setResidualFP')  RendererUI.drawResidualCounter(data.hex, data.fp);
            if (action === 'setSmoke')       RendererUI.drawSmoke(data.hex);
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
        worldFxLayer.add(line);
        losLines.push(line);
        worldFxLayer.batchDraw();
    },

    // Простая анимация дыма — 4 полупрозрачных серых кружка, поднимаются и растворяются
    // со сдвигом фазы, чтобы дым всегда был "живой".
    drawSmoke(hex) {
        const { x, y } = hexToPixel(hex.col, hex.row);
        const group = new Konva.Group({ x, y, listening: false });

        const N = 8;   // погуще: 8 puff'ов вместо 4
        const puffs = [];
        for (let i = 0; i < N; i++) {
            const puff = new Konva.Circle({
                x: 0, y: 28,   // старт ещё ниже
                radius: 6,
                fill: '#888',
                opacity: 0.6,
            });
            group.add(puff);
            puffs.push(puff);
        }
        worldFxLayer.add(group);

        // Каждый кружок проходит цикл ~2.5 сек: растёт, поднимается, покачивается, растворяется.
        // Фазы со сдвигом (i / N) — всегда несколько puff'ов на разных стадиях.
        const anim = new Konva.Animation((frame) => {
            const t = frame.time / 1000;
            puffs.forEach((puff, i) => {
                const phase = (t * 0.4 + i / N) % 1;
                const r     = 6 + phase * 18;
                const yOff  = 28 - phase * 46;   // старт ещё ниже (+28), поднимается до -18
                const alpha = (1 - phase) * 0.7;
                // Амплитуда покачивания растёт с фазой: маленькая у только что появившихся,
                // широкая у поднявшихся вверх
                const amp   = 5 + phase * 9;
                const xOff  = Math.sin(phase * Math.PI * 2 + i) * amp;
                puff.radius(r);
                puff.x(xOff);
                puff.y(yOff);
                puff.opacity(alpha);
            });
        }, worldFxLayer);
        anim.start();
        return { group, anim };
    },

    drawResidualCounter(hex, fp) {
        const key = `${hex.col},${hex.row}`;
        // удалить старый если есть (обновление или очистка)
        const old = residualNodes.get(key);
        if (old) { old.destroy(); residualNodes.delete(key); }

        if (fp <= 0) { worldFxLayer.batchDraw(); return; }

        const { x, y } = hexToPixel(hex.col, hex.row);
        const group = new Konva.Group({ x, y, listening: false });

        // Комиксный бёрст: 12 лучей, псевдо-рандомно неровные (seed от хекса — стабильно),
        // тонкая красная обводка, прозрачная заливка
        const seed = (hex.col * 31 + hex.row * 17) & 0xffff;
        let s = seed || 1;
        const rng = () => (s = (s * 9301 + 49297) % 233280) / 233280;

        const numPoints = 12;
        const outerR    = 30;
        const innerR    = 14;
        const jitter    = 6;
        const points    = [];
        for (let i = 0; i < numPoints * 2; i++) {
            const isOuter = i % 2 === 0;
            const baseR   = isOuter ? outerR : innerR;
            const r       = baseR + (rng() - 0.5) * jitter;
            const angle   = (i / (numPoints * 2)) * Math.PI * 2 - Math.PI / 2;
            points.push(r * Math.cos(angle), r * Math.sin(angle));
        }
        group.add(new Konva.Line({
            points,
            stroke:      'red',
            strokeWidth: 1,
            closed:      true,
        }));

        // Текст в три строки по центру звезды: Residual / Fire / число
        const lines      = ['Residual', 'Fire', String(fp)];
        const lineHeight = 8;
        const startY     = -(lines.length * lineHeight) / 2;
        lines.forEach((line, i) => {
            group.add(new Konva.Text({
                x: -30, y: startY + i * lineHeight,
                width: 60, height: lineHeight,
                text: line,
                fill: 'white',
                fontSize: 7,
                fontStyle: 'bold',
                align: 'center',
                verticalAlign: 'middle',
            }));
        });
        worldFxLayer.add(group);
        residualNodes.set(key, group);
        worldFxLayer.batchDraw();
    },

    drawHitPoints(points) {
        points.forEach(p => {
            const circle = new Konva.Circle({
                x: p.x, y: p.y,
                radius: 3,
                fill: 'lime',
                listening: false,
            });
            worldFxLayer.add(circle);
        });
        worldFxLayer.batchDraw();
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

    async drawImage(name, { src, x, y, opacity = 1, listening = false, scale = 1 }) {
        RendererUI.removeImage(name);
        const img = await new Promise((res, rej) => {
            const i = new Image();
            i.onload = () => res(i);
            i.onerror = rej;
            i.src = src;
        });
        // pivot в центре — чтобы rotation крутил вокруг центра, а не угла
        const node = new Konva.Image({
            image: img,
            x: x + img.width / 2,
            y: y + img.height / 2,
            offsetX: img.width / 2,
            offsetY: img.height / 2,
            scaleX: scale, scaleY: scale,
            opacity, listening,
            name: `img-${name}`,
        });
        uiLayer.add(node);
        uiLayer.batchDraw();
    },

    removeImage(name) {
        const node = uiLayer.findOne(`.img-${name}`);
        if (node) { node.destroy(); uiLayer.batchDraw(); }
    },

    rotateImage(name, delta) {
        const node = uiLayer.findOne(`.img-${name}`);
        if (!node) return;
        node.to({ rotation: node.rotation() + delta, duration: 0.4 });
    },
};
