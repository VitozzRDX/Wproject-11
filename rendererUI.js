import { UIState } from './uiState.js';
import { hexToPixel, R } from './hexUtils.js';

// Два слоя: uiLayer — screen-fixed (кнопки, крутилка); worldFxLayer — world-anchored (LoS, residual, smoke).
let uiLayer;
let worldFxLayer;
let ccLayer;                        // world-anchored, ПОД юнитами — только для CC-хекс подсветки
const losLines = [];
const residualNodes = new Map();   // hexKey → Konva.Group для residual FP счётчиков
const routLegalNodes = [];         // Konva-ноды подсветки легальных rout-hex'ов (green)
const routShelterNodes = [];       // Konva-ноды подсветки потенциальных укрытий (blue)
const routPathNodes    = [];       // Konva-ноды подсветки коридора путей до укрытий (purple)
const ccHexNodes       = [];       // Konva-ноды подсветки CC-хексов (orange)

export const RendererUI = {
    // Очищает residualFP-счётчики и LoS-линии на worldFxLayer + все .img-* на uiLayer.
    // Кнопки не трогаем — ими управляет UIState через add/remove.
    clearAll() {
        for (const [, node] of residualNodes) node.destroy();
        residualNodes.clear();
        losLines.forEach(l => l.destroy());
        losLines.length = 0;
        routLegalNodes.forEach(n => n.destroy());
        routLegalNodes.length = 0;
        routShelterNodes.forEach(n => n.destroy());
        routShelterNodes.length = 0;
        routPathNodes.forEach(n => n.destroy());
        routPathNodes.length = 0;
        ccHexNodes.forEach(n => n.destroy());
        ccHexNodes.length = 0;
        worldFxLayer?.batchDraw();
        // Удалить все .img-* (крутилка и другие персистентные UI-картинки)
        uiLayer?.getChildren(n => n.name()?.startsWith('img-')).forEach(n => n.destroy());
        // Удалить CC-панель если была.
        RendererUI.removeCCPanel();
        uiLayer?.batchDraw();
    },

    init(ui, worldFx) {
        uiLayer      = ui;
        worldFxLayer = worldFx;
    },

    // ccLayer пересоздаётся при loadScenario, устанавливается отдельно от init.
    setCCLayer(cc) {
        ccLayer = cc;

        UIState.subscribe((action, label, data) => {
            if (action === 'add')            RendererUI.drawButton(data);
            if (action === 'remove')         RendererUI.removeButton(label);
            if (action === 'addImage')       RendererUI.drawImage(label, data);
            if (action === 'removeImage')    RendererUI.removeImage(label);
            if (action === 'rotateImage')    RendererUI.rotateImage(label, data.delta);
            if (action === 'changeBadge')    RendererUI.changeBadge(data.isAxis);
            if (action === 'fadeButton')     RendererUI.fadeButton(label);
            if (action === 'flashLOS')       RendererUI.drawLOSLine(data.from, data.to, data.color);
            if (action === 'flashHitPoints') RendererUI.drawHitPoints(data);
            if (action === 'setResidualFP')  RendererUI.drawResidualCounter(data.hex, data.fp);
            if (action === 'setSmoke')       RendererUI.drawSmoke(data.hex);
            if (action === 'setRoutLegalHexes') RendererUI.drawRoutLegalHexes(data.hexes);
            if (action === 'setRoutShelters')   RendererUI.drawRoutShelters(data.hexes);
            if (action === 'setRoutPathHexes')  RendererUI.drawRoutPathHexes(data.hexes);
            if (action === 'setCCHexes')        RendererUI.drawCCHexes(data.hexes);
            if (action === 'showCCPanel')       RendererUI.drawCCPanel(data.units);
            if (action === 'hideCCPanel')       RendererUI.removeCCPanel();
            if (action === 'setCCPanelSelect')  RendererUI.updateCCPanelSelect(data.selectedIds);
            if (action === 'showTransferPanel')     RendererUI.drawTransferPanel(data.units);
            if (action === 'hideTransferPanel')     RendererUI.removeTransferPanel();
            if (action === 'setTransferPanelSelect') RendererUI.updateTransferPanelSelect(data.selectedIds);
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

    // Подсветка легальных hex'ов для routing unit (RtPh): зелёные полупрозрачные ромбы.
    // Пустой массив → очистить подсветку.
    drawRoutLegalHexes(hexes) {
        routLegalNodes.forEach(n => n.destroy());
        routLegalNodes.length = 0;
        for (const h of hexes) {
            const { x, y } = hexToPixel(h.col, h.row);
            const node = new Konva.RegularPolygon({
                x, y, sides: 6, radius: R,
                fill: 'rgba(80,220,80,0.35)',
                stroke: 'rgba(30,180,30,0.9)',
                strokeWidth: 2,
                rotation: 30,
                listening: false,
            });
            worldFxLayer.add(node);
            routLegalNodes.push(node);
        }
        worldFxLayer.batchDraw();
    },

    // Подсветка потенциальных укрытий router'а (RtPh): синие полупрозрачные ромбы.
    // Пустой массив → очистить.
    drawRoutShelters(hexes) {
        routShelterNodes.forEach(n => n.destroy());
        routShelterNodes.length = 0;
        for (const h of hexes) {
            const { x, y } = hexToPixel(h.col, h.row);
            const node = new Konva.RegularPolygon({
                x, y, sides: 6, radius: R,
                fill: 'rgba(80,140,240,0.35)',
                stroke: 'rgba(30,80,200,0.9)',
                strokeWidth: 2,
                rotation: 30,
                listening: false,
            });
            worldFxLayer.add(node);
            routShelterNodes.push(node);
        }
        worldFxLayer.batchDraw();
    },

    // Подсветка коридора путей до shelter'ов (RtPh): фиолетовые полупрозрачные ромбы.
    // Пустой массив → очистить.
    drawRoutPathHexes(hexes) {
        routPathNodes.forEach(n => n.destroy());
        routPathNodes.length = 0;
        for (const h of hexes) {
            const { x, y } = hexToPixel(h.col, h.row);
            const node = new Konva.RegularPolygon({
                x, y, sides: 6, radius: R,
                fill: 'rgba(180,80,220,0.30)',
                stroke: 'rgba(140,30,180,0.9)',
                strokeWidth: 2,
                rotation: 30,
                listening: false,
            });
            worldFxLayer.add(node);
            routPathNodes.push(node);
        }
        worldFxLayer.batchDraw();
    },

    // Подсветка CC-хексов (CCPh): красные полупрозрачные ромбы, под юнитами.
    drawCCHexes(hexes) {
        ccHexNodes.forEach(n => n.destroy());
        ccHexNodes.length = 0;
        if (!ccLayer) return;
        for (const h of hexes) {
            const { x, y } = hexToPixel(h.col, h.row);
            const node = new Konva.RegularPolygon({
                x, y, sides: 6, radius: R,
                fill: 'rgba(220,20,20,0.35)',
                stroke: 'rgba(180,0,0,0.9)',
                strokeWidth: 2,
                rotation: 30,
                listening: false,
            });
            ccLayer.add(node);
            ccHexNodes.push(node);
        }
        ccLayer.batchDraw();
    },

    // Панель для CC-разрешения: вертикальный список Konva.Image юнитов из currentCCHex.
    // Каждая мини-группа имеет attr ccPanel=true + unitId для interpreter'а.
    drawCCPanel(units) {
        RendererUI.removeCCPanel();
        if (!units.length) return;

        const first = units[0].image;
        const uw = first.width;
        const uh = first.height;
        const gap = 4;
        const totalH = units.length * (uh + gap) - gap;
        const stage = uiLayer.getStage();
        const panelX = stage.width() - uw - 24;
        const panelY = 60;

        const panel = new Konva.Group({ x: panelX, y: panelY, name: 'ccPanel' });
        panel.add(new Konva.Rect({
            x: -8, y: -8, width: uw + 16, height: totalH + 16,
            fill: 'rgba(0,0,0,0.7)', cornerRadius: 4,
        }));

        units.forEach((u, i) => {
            const y = i * (uh + gap);
            const row = new Konva.Group({ x: 0, y, name: 'ccPanelRow' });
            row.setAttr('ccPanel', true);
            row.setAttr('unitId', u.id);
            const image = new Konva.Image({ image: u.image, x: 0, y: 0, width: uw, height: uh });
            image.setAttr('unitId', u.id);   // клик по image → interpreter возьмёт unitId
            const selRect = new Konva.Rect({
                x: 0, y: 0, width: uw, height: uh,
                stroke: 'red', strokeWidth: 1,
                visible: false,
                name: `ccPanelSelect-${u.id}`,
                listening: false,
            });
            row.add(image, selRect);
            panel.add(row);
        });

        uiLayer.add(panel);
        uiLayer.batchDraw();
    },

    removeCCPanel() {
        const panel = uiLayer?.findOne('.ccPanel');
        if (panel) { panel.destroy(); uiLayer.batchDraw(); }
    },

    // Панель для transfer weapons (RPh): аналог CC-панели, но attr transferPanel.
    drawTransferPanel(units) {
        RendererUI.removeTransferPanel();
        if (!units.length) return;

        const first = units[0].image;
        const uw = first.width;
        const uh = first.height;
        const gap = 4;
        const totalH = units.length * (uh + gap) - gap;
        const stage = uiLayer.getStage();
        const panelX = stage.width() - uw - 24;
        const panelY = 60;

        const panel = new Konva.Group({ x: panelX, y: panelY, name: 'transferPanel' });
        panel.add(new Konva.Rect({
            x: -8, y: -8, width: uw + 16, height: totalH + 16,
            fill: 'rgba(0,0,0,0.7)', cornerRadius: 4,
        }));

        units.forEach((u, i) => {
            const y = i * (uh + gap);
            const row = new Konva.Group({ x: 0, y, name: 'transferPanelRow' });
            row.setAttr('transferPanel', true);
            row.setAttr('unitId', u.id);
            const image = new Konva.Image({ image: u.image, x: 0, y: 0, width: uw, height: uh });
            image.setAttr('unitId', u.id);
            const selRect = new Konva.Rect({
                x: 0, y: 0, width: uw, height: uh,
                stroke: 'red', strokeWidth: 1,
                visible: false,
                name: `transferPanelSelect-${u.id}`,
                listening: false,
            });
            row.add(image, selRect);
            panel.add(row);
        });

        uiLayer.add(panel);
        uiLayer.batchDraw();
    },

    updateTransferPanelSelect(selectedIds) {
        const panel = uiLayer?.findOne('.transferPanel');
        if (!panel) return;
        const set = new Set(selectedIds);
        panel.find('Rect').forEach(r => {
            const name = r.name() || '';
            if (!name.startsWith('transferPanelSelect-')) return;
            const uid = name.slice('transferPanelSelect-'.length);
            r.visible(set.has(uid));
        });
        uiLayer.batchDraw();
    },

    removeTransferPanel() {
        const panel = uiLayer?.findOne('.transferPanel');
        if (panel) { panel.destroy(); uiLayer.batchDraw(); }
    },

    // Обновить visibility selectRect'ов в панели по списку выделенных.
    updateCCPanelSelect(selectedIds) {
        const panel = uiLayer?.findOne('.ccPanel');
        if (!panel) return;
        const set = new Set(selectedIds);
        panel.find('Rect').forEach(r => {
            const name = r.name() || '';
            if (!name.startsWith('ccPanelSelect-')) return;
            const uid = name.slice('ccPanelSelect-'.length);
            r.visible(set.has(uid));
        });
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

    // Показывает соответствующий значок стороны (axis или allied) поверх крутилки.
    changeBadge(isAxis) {
        const allied = uiLayer?.findOne('.img-sideAllied');
        const axis   = uiLayer?.findOne('.img-sideAxis');
        allied?.visible(!isAxis);
        axis?.visible(isAxis);
        uiLayer?.batchDraw();
    },

    // Делает кнопку полупрозрачной и неактивной (без удаления из UIState.buttons).
    fadeButton(label) {
        const btn = uiLayer?.findOne(`.btn-${label}`);
        if (!btn) return;
        btn.opacity(0.5);
        btn.listening(false);
        uiLayer.batchDraw();
    },
};
