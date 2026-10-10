import * as interpreter from "/interpreter.js";
import * as unitloading from "/unitloading.js";
import { UNIT_IMAGE_SIZE } from './unitloading.js';
import { PhaseManager } from './phase_manager.js';
import * as renderer from './renderer.js';
import { initPositioning, recalculateHex, restoreUnitZ } from './positioning.js';
import { RendererUI } from './rendererUI.js';
import { UIState } from './uiState.js';
import { runFireSimulation } from './fireSimulation.js';
import { runWoundSimulation } from './woundSimulation.js';
import { initTerrainLOS } from './terrainLOS.js';
import { hexToPixel, pixelToHex, COL_COUNT, ROW_COUNT, R, hexLabel, hexesInRect } from './hexUtils.js';
import { terrainAt, setHexMap } from './cards.js';
import { State } from './state.js';
import { scenarios } from './scenarios.js';
import { save, load, hasSave } from './saveLoad.js';
import { startSetup } from './setupPhase.js';

const stage = new Konva.Stage({
    container: 'container',
    width:  window.innerWidth,
    height: window.innerHeight,
});

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload  = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${src}`));
    img.src = src;
  });
}


function draw_hex_grid(layer) {
    const labelsGroup = new Konva.Group({ listening: false });
    // new coords: col in [0, 2*COL_COUNT-1] (uA → col -1 отрицательный, вне канона — пропускаем),
    // row in [2, ROW_COUNT+1] (row 1 = ряд над uB1, за пределами карты — пропускаем).
    for (let col = 0; col < 2 * COL_COUNT - 1; col++) {
        for (let row = 1; row <= ROW_COUNT + 1; row++) {
            const { x, y } = hexToPixel(col, row);
            layer.add(new Konva.RegularPolygon({
                x, y,
                sides: 6,
                radius: R,
                stroke: 'rgba(0,0,0,0.35)',
                strokeWidth: 0.5,
                rotation: 30,   // flat-top
                listening: false,
            }));
            const label = hexLabel(col, row);
            const text = new Konva.Text({
                text: label,
                fontSize: 9,
                fill: 'rgba(0,0,0,0.6)',
                listening: false,
            });
            text.x(x - text.width() / 2);
            text.y(y - R * 0.75);
            labelsGroup.add(text);
        }
    }
    layer.add(labelsGroup);
    labelsGroup.cache();   // кешируем только лейблы
}

// Draws card visuals per scenario config: каждая карта = Konva.Group с pivot
// в центре карты + rotation (позволяет вращать ту же PNG для сценария B).
async function drawCardVisuals(layer, cardVisuals) {
    for (const card of cardVisuals) {
        const group = new Konva.Group({
            x: card.x + card.width / 2,          // позиция группы в мире = центр карты
            y: card.y + card.height / 2,
            offsetX: card.width / 2,             // локальный центр вращения
            offsetY: card.height / 2,
            rotation: card.rotation,
        });
        // base + terrain images
        for (const src of card.images) {
            const img = await loadImage(src);
            group.add(new Konva.Image({ image: img, x: 0, y: 0 }));
        }
        // Оверлеи контуров террейнов — скрыты по умолчанию, вращаются с картой
        const overlayGroup = new Konva.Group({ visible: false });
        for (const src of card.overlayImages ?? []) {
            const img = await loadImage(src);
            overlayGroup.add(new Konva.Image({ image: img, x: 0, y: 0, listening: false }));
        }
        group.add(overlayGroup);
        // Road overlay отключён (подсветка контура дорог).
        // if (card.roadImage) {
        //     const img = await loadImage(card.roadImage);
        //     group.add(new Konva.Image({ image: img, x: 0, y: 0, listening: false }));
        // }
        layer.add(group);
    }
}

// Слои сцены (background + units) пересоздаются при loadScenario.
// UI-слой (uiLayer) — persistent, живёт всю жизнь приложения.
let backgroundLayer = null;
let ccLayer = null;         // world-anchored, ПОД юнитами: CC-хекс подсветка
let unitLayer = null;
let uiLayer = null;         // screen-fixed: кнопки + крутилка
let worldFxLayer = null;    // world-anchored: LoS, residual, smoke, hit points

// Определяет сторону attacker'а (axis/allied) по нации любого attacker-пехотинца и переключает значок.
const AXIS_NATIONS = new Set(['german', 'italian', 'japanese']);
// Setup-фаза: выбранные юниты «липнут» к курсору со сдвигом вниз-вправо.
// Сдвиг нужен чтобы курсор физически попадал на то, что под sticky — hover работает дальше.
const STICKY_OFFSET_X = 1;
const STICKY_OFFSET_Y = 1;
function _setupStickyCursor() {
    if (PhaseManager.getPhase() !== 'setup') return;
    if (State.setupSelectedUnits.length === 0) return;
    const pointer = stage.getPointerPosition();
    State.setupSelectedUnits.forEach((id, i) => {
        const u = State.units[id];
        const offset = i * 3;   // лёгкая стопка при нескольких выбранных (dblclick)
        if (u.inSetupPool) {
            // uiLayer — screen coords.
            u.node.x(pointer.x + STICKY_OFFSET_X + offset);
            u.node.y(pointer.y + STICKY_OFFSET_Y);
        } else {
            // unitLayer — world coords (учитываем stage-скролл).
            u.node.x(pointer.x - stage.x() + STICKY_OFFSET_X + offset);
            u.node.y(pointer.y - stage.y() + STICKY_OFFSET_Y);
        }
    });
    State.uiLayer.batchDraw();
    State.unitLayer.batchDraw();
}

// Поднимаем только наведённый юнит — чтобы его оружие (или другие соседи по стеку) его не закрывали.
function _raiseHoveredUnit(unitId) {
    const u = State.units[unitId];
    if (!u) return;
    u.node.moveToTop();
    u.node.getLayer()?.batchDraw();
}

export function refreshSideBadge() {
    const attackerUnit = Object.values(State.units).find(u => u.side === 'attacker' && u.category === 'infantry');
    const isAxis = AXIS_NATIONS.has(attackerUnit?.nation);
    UIState.changeBadge(isAxis);
}

// Загрузка сценария: полная перезагрузка карты, юнитов, параметров.
// Вызывается при старте (init) и из консоли (window.Game.loadScenario('B')).
async function loadScenario(name) {
    const scen = scenarios[name];
    if (!scen) { console.warn(`[loadScenario] '${name}' не найден`); return; }
    console.log(`[loadScenario] ${name}`);
    State.currentScenario = scen;   // доступно всему коду, независимо от наличия setup-блока

    // 1. Wipe State — все игровые данные
    State.units = {};
    State.movementGroup = [];
    State.movementStackHex = null;
    State.fireGroup = [];
    State.fireGroupHexesArray = [];
    State.original_group = [];
    State.splitted_group = [];
    State.moved_movement_group = null;
    State.pendingMove = null;
    State.pendingSmoke = false;
    State.fired_from_on_target_in_hex = {};
    State.residualFP = {};
    State.dynamicTerrain = {};
    State.mfspent = false;

    // 2. Wipe UI: кнопки + residualFP/LoS visuals
    for (const b of Object.keys(UIState.buttons)) UIState.removeButton(b);
    RendererUI.clearAll();

    // 3. Destroy layers сцены
    backgroundLayer?.destroy();
    ccLayer?.destroy();
    unitLayer?.destroy();
    backgroundLayer = null;
    ccLayer = null;
    unitLayer = null;

    // 4. Параметры сценария
    State.orchardInSeason = scen.orchardInSeason;
    // Если сценарий описывает setup — заходим в неё, иначе сразу rally (fallback для сценариев без setup, напр. B).
    if (scen.setup) {
        PhaseManager.setPhase('setup');
    } else {
        PhaseManager.setPhase('rally');
    }

    // 5. Пиксельные наборы + hexmap
    await initTerrainLOS(scen.pixelsUrl, scen.roadsUrl);
    setHexMap(await scen.hexmapModule());

    // 6. Background: карты (rotation/offset per card) + hex grid
    backgroundLayer = new Konva.Layer();
    await drawCardVisuals(backgroundLayer, scen.cardVisuals);
    draw_hex_grid(backgroundLayer);
    stage.add(backgroundLayer);
    backgroundLayer.moveToBottom();

    // 7. CC layer — под юнитами, для CC-хекс подсветки (RtPh-подсветки идут в worldFxLayer, выше юнитов).
    ccLayer = new Konva.Layer();
    stage.add(ccLayer);

    // 8. Юниты + первичное позиционирование (State.addUnit не триггерит subscribers,
    // поэтому проходим по уникальным хексам и вручную вызываем recalculateHex)
    unitLayer = new Konva.Layer();
    State.unitLayer = unitLayer;   // save/load использует этот слой для spawn_unit
    State.uiLayer   = uiLayer;     // setupPhase использует для перекладывания нод юнитов пул↔карта
    await unitloading.createAndLoadUnits(unitLayer, scen.units);
    stage.add(unitLayer);
    worldFxLayer.moveToTop();   // эффекты (LoS, residual, smoke) над юнитами
    uiLayer.moveToTop();        // UI (кнопки, крутилка) поверх всего
    RendererUI.setCCLayer(ccLayer);   // передать актуальный ccLayer в rendererUI (пересоздаётся при loadScenario)
    const uniqueHexes = new Set();
    Object.values(State.units).forEach(u => {
        if (u.hex) uniqueHexes.add(`${u.hex.col},${u.hex.row}`);
    });
    uniqueHexes.forEach(k => {
        const [col, row] = k.split(',').map(Number);
        recalculateHex({ col, row });
    });

    // 8. Стандартные UI: кнопки + крутилка
    // NextPhase в фазе setup не показываем — добавляется в EndSetupSide после последней стороны.
    if (!scen.setup) {
        UIState.addButton('NextPhase', { x: 10, y: 10, label: 'NextPhase' });
    }
    UIState.addButton('Save',      { x: 160, y: 10, label: 'Save' });
    UIState.addButton('Load',      { x: 310, y: 10, label: 'Load' });
    if (!hasSave()) UIState.fadeButton('Load');   // нет сейва — кнопка неактивна
    UIState.addImage('turnphase', {
        src: './graf/turnphase.gif',
        x: window.innerWidth - 170, y: 15,
        opacity: 1,
        scale: 0.8,
        overlayPolygon: { sides: 8, radius: 53, rotation: 22.5, stroke: 'white', strokeWidth: 2 },
    });
    // Два значка стороны поверх крутилки — показываем один из них через changeBadge.
    // Сдвиг +30/+30 — ручная подгонка центра относительно turnphase (разные размеры картинок).
    UIState.addImage('sideAllied', {
        src: './graf/turnphaseallied.gif',
        x: window.innerWidth - 170 + 35, y: 15 + 35,
        opacity: 0.5, scale: 0.8,
    });
    UIState.addImage('sideAxis', {
        src: './graf/turnphaseaxis.gif',
        x: window.innerWidth - 170 + 24, y: 15 + 24,
        opacity: 0.5, scale: 0.8,
    });
    // addImage асинхронно грузит картинки (await loadImage). Ждём чтобы ноды успели создаться,
    // иначе changeBadge не найдёт их и оба баджа останутся видимыми.
    setTimeout(refreshSideBadge, 50);

    // Setup-фаза: расстановка юнитов. Если сценарий описывает setup — стартуем её.
    if (scen.setup) {
        startSetup(scen);
    }

    // 9. Камера + компенсация uiLayer (UI остаётся на месте при скролле)
    stage.x(scen.initialCamera?.x ?? 0);
    stage.y(scen.initialCamera?.y ?? 0);
    uiLayer.x(-stage.x());
    uiLayer.y(-stage.y());

    stage.batchDraw();
}

// Экспозиция в глобал для консольного управления сценарием.
window.Game = { loadScenario, save, load };

async function init() {

    // One-time subscribers: Renderer/Positioning живут всё время приложения,
    // handlers сами реагируют на setUnit для новых юнитов при loadScenario.
    // Сначала Renderer подписывается на State
    renderer.initRenderer();
    // Потом Positioning — он сразу пройдёт по гексам и расставит юниты,
    // Renderer уже услышит pos-события и анимирует
    initPositioning();

    // UI слои (persistent): worldFx для эффектов на карте (LoS/residual/smoke), ui для кнопок/крутилки.
    worldFxLayer = new Konva.Layer();
    uiLayer      = new Konva.Layer();
    stage.add(worldFxLayer);
    stage.add(uiLayer);
    RendererUI.init(uiLayer, worldFxLayer);

    // Тёмная полоса под UI: от верха экрана до чуть ниже NextPhase. Кнопки/крутилка/значки
    // внутри uiLayer рендерятся поверх (полоса moveToBottom этого слоя); карта и юниты
    // в нижних слоях остаются под ней (uiLayer — верхний слой сцены).
    const topBar = new Konva.Rect({
        x: 0, y: 0,
        width: window.innerWidth,
        height: 56,   // NextPhase y=10 + высота кнопки 36 + 10 отступ снизу
        fill: 'rgba(0,0,0,0.6)',
        listening: false,
        name: 'topBar',
    });
    uiLayer.add(topBar);
    topBar.moveToBottom();

    // --- DEBUG tagging mode ---
    // F — toggle; в режиме клики собирают hex-лейблы в Set (повторный клик = убрать)
    // P — печать сета и очистка. C — просто очистка.
    const _tagged = new Set();
    let _tagMode = false;

    // Hover: поднять наведённый юнит. При смене наведённого — восстанавливаем z-порядок стопки предыдущего.
    let _hoveredUnitId = null;

    // --- Lasso: резиновая рамка для группового выбора ---
    let _dragStart     = null;    // точка начала drag в мировых координатах (null — не тянем)
    let _dragRectNode  = null;    // видимый Konva.Rect во время drag
    let _dragWasReal   = false;   // был ли drag значимым (чтобы подавить следующий click)

    // Переводит положение мыши в мировые координаты карты. Konva даёт экранную позицию внутри canvas,
    // stage.x/y — сдвиг от WASD-скроллинга. Вычитаем сдвиг чтобы получить точку в неподвижной системе карты.
    function _worldPos() {
        const raw = stage.getPointerPosition();
        return { x: raw.x - stage.x(), y: raw.y - stage.y() };
    }

    stage.on('mousedown', (e) => {
        if (e.evt.button !== 0) return;                         // только левая кнопка
        if (e.target.getAttr('unitId')) return;                 // по юниту — не drag
        if (e.target.getParent()?.getAttr('buttonLabel')) return;   // по кнопке — не drag
        if (e.target.name?.() === 'setupPanel') return;         // по setup-подложке — не drag
        _dragStart = _worldPos();
        _dragRectNode = new Konva.Rect({
            x: _dragStart.x, y: _dragStart.y, width: 0, height: 0,
            stroke: 'blue', strokeWidth: 1,
            dash: [4, 2],   // пунктир: 4 пикселя линия, 2 пикселя пустоты, повтор
            listening: false,
        });
        worldFxLayer.add(_dragRectNode);
    });

    stage.on('mousemove', (e) => {
        // Setup «липкий курсор»: позиционирует выбранных юнитов, hover работает ниже параллельно.
        _setupStickyCursor();

        // Во время drag — обновляем рамку, hover подавлен.
        if (_dragStart) {
            const pt = _worldPos();
            _dragRectNode.x(Math.min(_dragStart.x, pt.x));
            _dragRectNode.y(Math.min(_dragStart.y, pt.y));
            _dragRectNode.width(Math.abs(pt.x - _dragStart.x));
            _dragRectNode.height(Math.abs(pt.y - _dragStart.y));
            worldFxLayer.batchDraw();
            return;
        }
        // Обычный hover.
        const unitId = e.target.getAttr('unitId');
        if (unitId === _hoveredUnitId) return;
        const prevId = _hoveredUnitId;
        _hoveredUnitId = unitId;
        if (prevId) restoreUnitZ(prevId);
        if (unitId) _raiseHoveredUnit(unitId);
    });

    stage.on('mouseup', (e) => {
        if (!_dragStart) return;
        const pt = _worldPos();
        const w = Math.abs(pt.x - _dragStart.x);
        const h = Math.abs(pt.y - _dragStart.y);
        _dragRectNode.destroy();
        _dragRectNode = null;
        const start = _dragStart;
        _dragStart = null;
        if (w < 4 && h < 4) return;   // слишком маленько — обычный клик обработается отдельно
        _dragWasReal = true;
        const rect = {
            x: Math.min(start.x, pt.x), y: Math.min(start.y, pt.y),
            w, h,
        };
        interpreter.interpretLassoRelease(hexesInRect(rect));
        worldFxLayer.batchDraw();
    });

    // Dbl-клик по юниту: групповое добавление в MG (MPh) или FG (фазы огня).
    stage.on('dblclick', (e) => interpreter.interpretDblClickEvent(e));

    stage.on('click', function (e) {
        // После реального drag Konva всё равно фирит click — подавляем один раз.
        if (_dragWasReal) { _dragWasReal = false; return; }
        const st  = e.target.getStage();
        const raw = st.getPointerPosition();
        const pos = { x: raw.x - st.x(), y: raw.y - st.y() };
        const h   = pixelToHex(pos.x, pos.y);
        const label = hexLabel(h.col, h.row);
        // console.log(`[click] world(${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}) hex ${label}`);
        if (_tagMode) {
            if (_tagged.has(label)) {
                _tagged.delete(label);
                console.log(`[tag] -${label} (total: ${_tagged.size})`);
            } else {
                _tagged.add(label);
                console.log(`[tag] +${label} (total: ${_tagged.size})`);
            }
            return;
        }
        interpreter.interpretEvent(e);
    });

    // Debug overlay для visual verification hexmap
    const TERRAIN_COLOR = {
        forest:         'rgba(0,100,0,0.35)',
        brush:          'rgba(140,160,60,0.35)',
        orchard:        'rgba(80,200,80,0.30)',
        hill:           'rgba(160,100,60,0.35)',
        stoneBuilding:  'rgba(120,120,120,0.45)',
        woodenBuilding: 'rgba(190,140,80,0.45)',
        dirtRoad:       'rgba(180,140,80,0.40)',
        pavedRoad:      'rgba(60,60,60,0.50)',
        'Woods-Road':   'rgba(80,120,60,0.40)',
    };
    let _overlayLayer = null;

    function _toggleTerrainOverlay() {
        if (_overlayLayer) {
            _overlayLayer.destroy();
            _overlayLayer = null;
            stage.batchDraw();
            console.log('[overlay] OFF');
            return;
        }
        _overlayLayer = new Konva.Layer({ listening: false });
        // Все terrain-хексы (new coords: col 0..2*COL_COUNT-1, row 2..ROW_COUNT+1)
        for (let col = 0; col < 2 * COL_COUNT - 1; col++) {
            for (let row = 1; row <= ROW_COUNT + 1; row++) {
                const terrain = terrainAt(col, row);
                if (terrain.length === 0) continue;
                const { x, y } = hexToPixel(col, row);
                // Заливка по первому "площадному" терпейну (если есть)
                const areaT = terrain.find(t => t !== 'crestLine');
                const color = TERRAIN_COLOR[areaT] ?? 'rgba(200,50,200,0.3)';
                _overlayLayer.add(new Konva.RegularPolygon({
                    x, y, sides: 6, radius: R,
                    fill: color,
                    stroke: terrain.includes('crestLine') ? 'red' : null,
                    strokeWidth: terrain.includes('crestLine') ? 2 : 0,
                    rotation: 30,
                    listening: false,
                }));
                const label = terrain.join('+');
                const t = new Konva.Text({
                    text: label,
                    fontSize: 8,
                    fill: 'white',
                    stroke: 'black',
                    strokeWidth: 0.5,
                    listening: false,
                });
                t.x(x - t.width() / 2);
                t.y(y - 4);
                _overlayLayer.add(t);
            }
        }
        stage.add(_overlayLayer);
        stage.batchDraw();
        console.log('[overlay] ON');
    }

    window.addEventListener('keydown', (e) => {
        if (e.key === 'F' || e.key === 'f') {
            _tagMode = !_tagMode;
            console.log(`[MODE] tagging ${_tagMode ? 'ON' : 'OFF'}`);
            return;
        }
        if (e.key === 'P' || e.key === 'p') {
            const arr = Array.from(_tagged).sort();
            console.log(`=== tagged (${arr.length}): ===\n${arr.join(', ')}`);
            _tagged.clear();
            return;
        }
        if (e.key === 'C' || e.key === 'c') {
            _tagged.clear();
            console.log('[tag] cleared');
            return;
        }
        if (e.key === 'D' || e.key === 'd') {
            _toggleTerrainOverlay();
            return;
        }
        interpreter.interpretKeyEvent(e);
    });

    // Скроллинг WASD через RAF — плавный без auto-repeat задержки
    const pressedKeys = new Set();
    window.addEventListener('keydown', (e) => {
        if (['KeyW','KeyA','KeyS','KeyD'].includes(e.code)) pressedKeys.add(e.code);
    });
    window.addEventListener('keyup', (e) => pressedKeys.delete(e.code));
    (function scrollLoop() {
        const SPEED = 8;   // px per frame
        let dx = 0, dy = 0;
        if (pressedKeys.has('KeyW')) dy += SPEED;
        if (pressedKeys.has('KeyS')) dy -= SPEED;
        if (pressedKeys.has('KeyA')) dx += SPEED;
        if (pressedKeys.has('KeyD')) dx -= SPEED;
        if (dx || dy) {
            stage.x(stage.x() + dx);
            stage.y(stage.y() + dy);
            uiLayer.x(-stage.x());   // синхронизация: UI на месте на экране
            uiLayer.y(-stage.y());
            stage.batchDraw();
        }
        requestAnimationFrame(scrollLoop);
    })();

    // Предзагрузка картинок всех TEMPLATES в кэш unitloading. После этого
    // getImage/loadImage по любому TEMPLATES.src возвращаются мгновенно.
    await unitloading.preloadAllTemplateImages();

    // Стартовый сценарий
    await loadScenario('A');

    // runFireSimulation();
    // runWoundSimulation();
}
init();
