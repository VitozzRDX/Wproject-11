import * as interpreter from "/interpreter.js";
import * as unitloading from "/unitloading.js";
import { PhaseManager } from './phase_manager.js';
import * as renderer from './renderer.js';
import { initPositioning } from './positioning.js';
import { RendererUI } from './rendererUI.js';
import { UIState } from './uiState.js';
import { runFireSimulation } from './fireSimulation.js';
import { runWoundSimulation } from './woundSimulation.js';

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


async function load_and_draw_background() {
    // Создаём новый слой для фона
    const backgroundLayer = new Konva.Layer();
    
    // Загружаем изображение карты асинхронно
    const img = await loadImage('./graf/1.gif');
    
    // Добавляем загруженное изображение на слой с координатами (0,0)
    backgroundLayer.add(new Konva.Image({ image: img, x: 0, y: 0, id: 'map' }));
    
    // Добавляем слой на сцену
    stage.add(backgroundLayer);
    
    // Отрисовываем слой батчевой отрисовкой для оптимизации
    backgroundLayer.batchDraw()
}

async function load_and_draw_units() {
    
    const unitLayer = new Konva.Layer();   
    await unitloading.createAndLoadUnits(unitLayer);
    stage.add(unitLayer);
    unitLayer.batchDraw();

}

async function init() {

    await load_and_draw_background();
    await load_and_draw_units();
    PhaseManager.setPhase('german movement phase');

    stage.on('click', function (e) {

        interpreter.interpretEvent(e);  // handle - interpretEvent
        
    });

    window.addEventListener('keydown', interpreter.interpretKeyEvent);

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