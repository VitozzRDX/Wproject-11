import * as interpreter from "/interpreter.js";
import * as unitloading from "/unitloading.js";
import { PhaseManager } from './phase_manager.js';
import * as renderer from './renderer.js';
import { initPositioning } from './positioning.js';
import { RendererUI } from './rendererUI.js';
import { UIState } from './uiState.js';
import { runFireSimulation } from './fireSimulation.js';
import { runWoundSimulation } from './woundSimulation.js';
import { initTerrainLOS } from './terrainLOS.js';
import { hexToPixel, pixelToHex, COL_COUNT, ROW_COUNT, R, hexLabel } from './hexUtils.js';
import { terrainAt } from './cards.js';

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
        for (let row = 2; row <= ROW_COUNT + 1; row++) {
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

async function load_and_draw_background() {
    // Создаём новый слой для фона
    const backgroundLayer = new Konva.Layer();

    // V-карта — обёрнута в Konva.Group для возможности поворота/переворота
    const V_W = 1800, V_H = 645;
    const cardV = new Konva.Group({
        name: 'card-v',
        x: V_W / 2, y: V_H / 2,           // позиция группы в мире
        offsetX: V_W / 2, offsetY: V_H / 2, // локальный центр вращения
        rotation: 180,
    });
    const img1base = await loadImage('./graf/base_layer.png');
    cardV.add(new Konva.Image({ image: img1base, x: 0, y: 0, id: 'map1_base' }));
    const img1terrain = await loadImage('./graf/terrain_inside_1.png');
    cardV.add(new Konva.Image({ image: img1terrain, x: 0, y: 0, id: 'map1_terrain' }));

    // Оверлеи контуров террейнов V-карты — внутри cardV, вращаются вместе
    const overlaysV = [
        './graf/woods_outline.png',
        './graf/buildings_outline.png',
        './graf/hills_outline_1.png',
        './graf/orchard_outline_1.png',
        './graf/brush_outline.png',
    ];
    const groupV = new Konva.Group({ name: 'overlays-v' });
    for (const src of overlaysV) {
        const overlayImg = await loadImage(src);
        groupV.add(new Konva.Image({ image: overlayImg, x: 0, y: 0, listening: false }));
    }
    groupV.visible(false);
    cardV.add(groupV);

    // Отдельный оверлей дорог поверх террейна — виден всегда, поворачивается с картой
    const roadsImg = await loadImage('./graf/roads_outline.png');
    cardV.add(new Konva.Image({ image: roadsImg, x: 0, y: 0, listening: false }));

    backgroundLayer.add(cardV);

    // Доска bdu слева от V
    const bduBase = await loadImage('./graf/bdu_base_layer.png');
    backgroundLayer.add(new Konva.Image({ image: bduBase, x: -1800, y: 0, id: 'bdu_base' }));
    const bduTerrain = await loadImage('./graf/bdu_terrain_inside.png');
    backgroundLayer.add(new Konva.Image({ image: bduTerrain, x: -1800, y: 0, id: 'bdu_terrain' }));

    // Оверлеи контуров террейнов U-карты (x=-1800, y=0)
    const overlaysU = [
        './graf/bdu_woods_outline.png',
        './graf/bdu_buildings_outline.png',
        './graf/bdu_hills_outline.png',
        './graf/bdu_orchard_outline.png',
        './graf/bdu_brush_outline.png',
    ];
    const groupU = new Konva.Group({ name: 'overlays-u' });
    for (const src of overlaysU) {
        const overlayImg = await loadImage(src);
        groupU.add(new Konva.Image({ image: overlayImg, x: -1800, y: 0, listening: false }));
    }
    groupU.visible(false);
    backgroundLayer.add(groupU);

    draw_hex_grid(backgroundLayer);

    stage.add(backgroundLayer);
    backgroundLayer.batchDraw();
}

async function load_and_draw_units() {
    
    const unitLayer = new Konva.Layer();   
    await unitloading.createAndLoadUnits(unitLayer);
    stage.add(unitLayer);
    unitLayer.batchDraw();

}

async function init() {

    await initTerrainLOS();
    await load_and_draw_background();
    await load_and_draw_units();
    PhaseManager.setPhase('movement');
    PhaseManager.setActiveRole('attacker');

    // --- DEBUG tagging mode ---
    // F — toggle; в режиме клики собирают hex-лейблы в Set (повторный клик = убрать)
    // P — печать сета и очистка. C — просто очистка.
    const _tagged = new Set();
    let _tagMode = false;

    stage.on('click', function (e) {
        const st  = e.target.getStage();
        const raw = st.getPointerPosition();
        const pos = { x: raw.x - st.x(), y: raw.y - st.y() };
        const h   = pixelToHex(pos.x, pos.y);
        const label = hexLabel(h.col, h.row);
        console.log(`[click] world(${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}) hex ${label}`);
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
            for (let row = 2; row <= ROW_COUNT + 1; row++) {
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
            stage.batchDraw();
        }
        requestAnimationFrame(scrollLoop);
    })();

    // Сначала Renderer подписывается на State
    renderer.initRenderer();
    // Потом Positioning — он сразу пройдёт по гексам и расставит юниты,
    // Renderer уже услышит pos-события и анимирует
    initPositioning();

    // UI слой для кнопок
    const uiLayer = new Konva.Layer();
    stage.add(uiLayer);
    UIState.addButton('NextPhase', { x: 10, y: 10, label: 'NextPhase' });
    RendererUI.init(uiLayer);

    runFireSimulation();
    runWoundSimulation();
}
init();