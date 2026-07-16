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
import { hexToPixel, COL_COUNT, ROW_COUNT, R } from './hexUtils.js';

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
    for (let col = 0; col < COL_COUNT; col++) {
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
        }
    }
}

async function load_and_draw_background() {
    // Создаём новый слой для фона
    const backgroundLayer = new Konva.Layer();

    // Загружаем изображения карт (доски стыкуются вертикально по BOARD_H=645)
    const img = await loadImage('./graf/1.gif');
    backgroundLayer.add(new Konva.Image({ image: img, x: 0, y: 0, id: 'map' }));

    const img2 = await loadImage('./graf/bdu.gif');
    backgroundLayer.add(new Konva.Image({ image: img2, x: 0, y: 645, id: 'map2' }));

    // Оверлеи с контурами террейнов (прозрачные PNG)
    const overlays = [
        './graf/woods_outline.png',
        './graf/buildings_outline.png',
        './graf/hills_outline_1.png',
        './graf/orchard_outline_1.png',
        './graf/brush_outline.png',
    ];
    for (const src of overlays) {
        const overlayImg = await loadImage(src);
        backgroundLayer.add(new Konva.Image({ image: overlayImg, x: 0, y: 0, listening: false }));
    }

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