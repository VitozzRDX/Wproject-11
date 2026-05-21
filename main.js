import * as interpreter from "/interpreter.js"; 

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

async function init() {

    await load_and_draw_background();
      
    stage.on('click', function (e) {

        interpreter.interpretEvent(e);  // handle - interpretEvent

    });
}
init();