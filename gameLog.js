// Видимый лог игры: прозрачное окно в правом нижнем углу.
// Клик по заголовку — свернуть/развернуть. По умолчанию свёрнуто.
// API: initGameLog(uiLayer), gameLog(msg).
// Konva подключён глобально через <script> в index.html, импорта не нужно.

const LOG_W         = 400;   // ширина окна
const LOG_H         = 220;   // высота развёрнутого окна (вместе с заголовком)
const HEADER_H      = 20;    // высота полосы заголовка
const LINE_H        = 14;    // шаг строки
const MARGIN        = 6;     // отступ от края экрана
const MAX_LINES     = 200;   // храним историю, рисуем влезающие снизу
const COLLAPSED_SHIFT_Y = 160; // когда свёрнуто, планка «▸ Log» опускается вниз на столько px

let group     = null;        // корневая группа лога
let bodyRect  = null;        // прозрачный фон тела (видим только когда развёрнуто)
let headerBg  = null;        // полоса заголовка (всегда видна)
let headerTxt = null;        // текст заголовка со стрелкой
let linesGrp  = null;        // группа текстовых строк
let layerRef  = null;        // uiLayer для batchDraw
let expanded  = false;       // текущее состояние
let scrollOffsetPx = 0;      // на сколько px «отмотано» вверх от самой свежей строки (0 = прижато к низу)
let scrollBar = null;        // индикатор прокрутки (вертикальная полоска у правого края)
let baseY     = 0;           // базовая Y развёрнутого окна (сохраняем для toggle)
const buffer  = [];          // кольцевой буфер сообщений

export function initGameLog(uiLayer) {
    layerRef = uiLayer;

    // Позиция — правый нижний угол окна.
    const x = window.innerWidth  - LOG_W - MARGIN;
    baseY   = window.innerHeight - LOG_H - MARGIN;

    // стартуем свёрнутыми — планка опущена на COLLAPSED_SHIFT_Y вниз
    group = new Konva.Group({ x, y: baseY + COLLAPSED_SHIFT_Y, name: 'gameLog' });

    // Тело окна: полупрозрачная заливка + рамка. Скрыто пока свёрнуто.
    bodyRect = new Konva.Rect({
        x: 0, y: HEADER_H,
        width: LOG_W, height: LOG_H - HEADER_H,
        fill: 'rgba(0,0,0,0.35)',
        stroke: '#888', strokeWidth: 1,
        visible: false,
    });

    // Полоса заголовка — всегда видна, по ней кликают для свёртки.
    headerBg = new Konva.Rect({
        x: 0, y: 0,
        width: LOG_W, height: HEADER_H,
        fill: 'rgba(0,0,0,0.6)',
        stroke: '#888', strokeWidth: 1,
    });
    headerTxt = new Konva.Text({
        x: 8, y: 4,
        text: '▸ Log',
        fontFamily: 'monospace', fontSize: 12,
        fill: '#ddd',
    });

    // Группа строк — внутри тела, clip по размеру тела.
    linesGrp = new Konva.Group({
        x: 6, y: HEADER_H + 4,
        clip: { x: 0, y: 0, width: LOG_W - 12, height: LOG_H - HEADER_H - 8 },
        visible: false,
    });

    // индикатор прокрутки: тонкая вертикальная полоска у правого края тела
    scrollBar = new Konva.Rect({
        x: LOG_W - 4, y: HEADER_H,
        width: 3, height: 0,     // высоту и y ставим в _rebuildLines
        fill: '#aaa',
        listening: false,        // колесо/клики идут мимо — на group
        visible: false,          // показываем только когда есть что скроллить
    });

    group.add(bodyRect, headerBg, headerTxt, linesGrp, scrollBar);

    // Клик по заголовку (фону или тексту) — тогглим состояние.
    const toggle = () => {
        expanded = !expanded;
        bodyRect.visible(expanded);
        linesGrp.visible(expanded);
        scrollBar.visible(false);        // при свёртке гасим; при разворачивании _rebuildLines сам решит показывать
        headerTxt.text(expanded ? '▾ Log' : '▸ Log');
        group.y(expanded ? baseY : baseY + COLLAPSED_SHIFT_Y);
        if (expanded) _rebuildLines();
        layerRef.batchDraw();
    };
    headerBg.on('click', toggle);
    headerTxt.on('click', toggle);

    // прокрутка колесом над окном лога (вешаем на группу, чтобы ловить над любым узлом внутри)
    group.on('wheel', (e) => {
        if (!expanded) return;           // в свёрнутом режиме колесо игнорим
        e.evt.preventDefault();          // не даём странице скроллиться
        scrollOffsetPx -= e.evt.deltaY;  // колесо вверх → показываем более старое (offset растёт)
        _rebuildLines();
        layerRef.batchDraw();
    });

    uiLayer.add(group);
    group.moveToTop();
}

// Публичный API — добавить строку в лог.
export function gameLog(msg) {
    const line = typeof msg === 'string' ? msg : String(msg);
    buffer.push(line);
    if (buffer.length > MAX_LINES) buffer.shift();
    scrollOffsetPx = 0;                  // новое сообщение → прыгаем к низу (вариант B)
    if (expanded && linesGrp) {
        _rebuildLines();
        layerRef.batchDraw();
    }
}

// Перерисовать видимые строки: нижняя — самая свежая.
// Содержимое клипится телом; scrollOffsetPx сдвигает контент вверх/вниз.
function _rebuildLines() {
    linesGrp.destroyChildren();
    const bodyH = LOG_H - HEADER_H - 8;

    // прогон 1: создаём все ноды в памяти, замеряем каждую, считаем totalH
    const nodes = [];
    let totalH = 0;
    for (let i = 0; i < buffer.length; i++) {
        const t = new Konva.Text({
            x: 0, y: 0,            // y поставим в прогоне 2
            text: buffer[i],
            fontFamily: 'monospace', fontSize: 11,
            fill: '#eee',
            width: LOG_W - 12,
            wrap: 'word',
        });
        const rows = Math.max(1, Math.ceil(t.height() / LINE_H));
        const h = rows * LINE_H;
        nodes.push({ t, h });
        totalH += h;
    }

    // clamp scrollOffsetPx: нельзя уйти ниже 0, выше — только насколько не влез контент
    const maxScroll = Math.max(0, totalH - bodyH);
    if (scrollOffsetPx < 0)          scrollOffsetPx = 0;
    if (scrollOffsetPx > maxScroll)  scrollOffsetPx = maxScroll;

    // базовый y для первой ноды: самое свежее прижато к низу, потом отматываем scrollOffsetPx вверх
    let y = bodyH - totalH + scrollOffsetPx;
    for (const { t, h } of nodes) {
        t.y(y);
        linesGrp.add(t);
        y += h;
    }

    // индикатор прокрутки: высота пропорциональна видимой части, позиция — текущему положению
    if (maxScroll <= 0) {
        scrollBar.visible(false);                            // контент влезает — индикатор не нужен
    } else {
        const barH = Math.max(12, bodyH * (bodyH / totalH)); // мин. 12 px чтобы был видим
        // scrollOffsetPx == 0 → внизу; == maxScroll → вверху
        const ratio = scrollOffsetPx / maxScroll;            // 0..1
        const barY = HEADER_H + (1 - ratio) * (bodyH - barH);
        scrollBar.y(barY);
        scrollBar.height(barH);
        scrollBar.visible(true);
    }
}
