// Видимый лог игры: прозрачное окно в правом нижнем углу.
// Клик по заголовку — свернуть/развернуть. По умолчанию свёрнуто.
// Кнопка [copy] в заголовке копирует весь лог сессии в буфер обмена.
// API: initGameLog(uiLayer), gameLog(msg).
// Konva подключён глобально через <script> в index.html, импорта не нужно.

const LOG_W         = 400;   // ширина окна
const LOG_H         = 220;   // высота развёрнутого окна (вместе с заголовком)
const HEADER_H      = 20;    // высота полосы заголовка
const LINE_H        = 14;    // шаг строки
const MARGIN        = 6;     // отступ от края экрана
const MAX_SHOWN     = 200;   // сколько последних сообщений показываем и прокручиваем в окне; в buffer хранится весь лог сессии
const COLLAPSED_SHIFT_Y = 160; // когда свёрнуто, планка «▸ Log» опускается вниз на столько px

let group     = null;        // корневая группа лога
let bodyRect  = null;        // прозрачный фон тела (видим только когда развёрнуто)
let headerBg  = null;        // полоса заголовка (всегда видна)
let headerTxt = null;        // текст заголовка со стрелкой
let copyTxt   = null;        // кнопка «copy» в заголовке
let linesGrp  = null;        // группа текстовых строк
let layerRef  = null;        // uiLayer для batchDraw
let expanded  = false;       // текущее состояние
let scrollOffsetPx = 0;      // на сколько px «отмотано» вверх от самой свежей строки (0 = прижато к низу)
let scrollBar = null;        // индикатор прокрутки (вертикальная полоска у правого края)
let baseY     = 0;           // базовая Y развёрнутого окна (сохраняем для toggle)
const buffer  = [];          // весь лог сессии: по строке на сообщение

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

    // Кнопка «copy» справа в заголовке: копирует весь лог в буфер обмена.
    copyTxt = new Konva.Text({
        x: LOG_W - 84, y: 0,
        width: 80, padding: 4, align: 'right',   // высота кнопки равна высоте заголовка; фиксированная ширина, чтобы подпись «copied» не сдвигала её
        text: '[copy]',
        fontFamily: 'monospace', fontSize: 12,
        fill: '#9cf',
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

    group.add(bodyRect, headerBg, headerTxt, copyTxt, linesGrp, scrollBar);

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

    // Клик по заголовку не должен доходить до карты (иначе попытка хода): гасим всплытие только у элементов заголовка
    const headerClick = (action) => (e) => { e.cancelBubble = true; action(); };
    headerBg.on('click',  headerClick(toggle));
    headerTxt.on('click', headerClick(toggle));
    copyTxt.on('click',   headerClick(_copyLog));

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
    const shown = buffer.slice(-MAX_SHOWN);   // в окне — последние сообщения, чтобы перерисовка не дорожала с ростом лога

    // прогон 1: создаём все ноды в памяти, замеряем каждую, считаем totalH
    const nodes = [];
    let totalH = 0;
    for (let i = 0; i < shown.length; i++) {
        const t = new Konva.Text({
            x: 0, y: 0,            // y поставим в прогоне 2
            text: shown[i],
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

// Копирует весь лог сессии в буфер обмена (по строке на сообщение) и на секунду показывает результат на кнопке.
function _copyLog() {
    if (!navigator.clipboard) {                    // буфер обмена доступен только на localhost / https
        _flashCopyLabel('copy failed');
        return;
    }
    navigator.clipboard.writeText(buffer.join('\n')).then(
        () => _flashCopyLabel('copied'),
        () => _flashCopyLabel('copy failed')
    );
}

// Меняет подпись кнопки на секунду, потом возвращает «[copy]».
function _flashCopyLabel(text) {
    copyTxt.text(text);
    layerRef.batchDraw();
    setTimeout(() => {
        copyTxt.text('[copy]');
        layerRef.batchDraw();
    }, 1000);
}
