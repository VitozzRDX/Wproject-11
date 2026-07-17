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
import { hexToPixel, COL_COUNT, ROW_COUNT, R, hexLabel } from './hexUtils.js';

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
    for (let col = -COL_COUNT; col < COL_COUNT; col++) {
        for (let row = 1; row <= ROW_COUNT; row++) {
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

    // Загружаем изображения карт (доски стыкуются вертикально по BOARD_H=645, горизонтально по 1800)
    // 1-я доска: base + terrain (заменяет 1.gif)
    const img1base = await loadImage('./graf/base_layer.png');
    backgroundLayer.add(new Konva.Image({ image: img1base, x: 0, y: 0, id: 'map1_base' }));
    const img1terrain = await loadImage('./graf/terrain_inside_1.png');
    backgroundLayer.add(new Konva.Image({ image: img1terrain, x: 0, y: 0, id: 'map1_terrain' }));

    // Доска bdu слева от 1-й
    const bduBase = await loadImage('./graf/bdu_base_layer.png');
    backgroundLayer.add(new Konva.Image({ image: bduBase, x: -1800, y: 0, id: 'bdu_base' }));
    const bduTerrain = await loadImage('./graf/bdu_terrain_inside.png');
    backgroundLayer.add(new Konva.Image({ image: bduTerrain, x: -1800, y: 0, id: 'bdu_terrain' }));


    // Оверлеи контуров террейнов V-карты (x=0, y=0)
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
    backgroundLayer.add(groupV);

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
    groupU.visible(true);   // включаем U-контуры по умолчанию
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
    PhaseManager.setPhase('german movement phase');

    stage.on('click', function (e) {

        interpreter.interpretEvent(e);  // handle - interpretEvent
        
    });

    window.addEventListener('keydown', interpreter.interpretKeyEvent);

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