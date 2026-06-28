import { State } from './state.js';

export function initRenderer() {
    State.subscribe((id, key, value, oldValue) => {
        const node = State.units[id].node;
        const image = node.findOne('Image');
        let borderRect = node.findOne('Name', 'borderRect');

        // if (key === 'selected') {
        //     image.stroke(value ? 'red' : null);    // обводка при выборе
        //     image.strokeWidth(value ? 1 : 0);
        //     if (value) node.moveToTop();            // поднимаем наверх z-порядка
        // }

        // if (key === 'selected') {
        //     node.findOne('.selectRect').visible(value);
        //     if (value) node.moveToTop();
        //     console.log('Selected state changed for unit', id, 'New selected value:', value);
        // }

        // Рамка для movement group
        if (key === 'inMovementGroup') {

            node.findOne('.addToMovementGroupRect').visible(value);
            if (value) node.moveToTop();

        }

        // Рамка для fire group 
        if (key === 'inFireGroup') {
            node.findOne('.addToFireGroupRect').visible(value);
            if (value) node.moveToTop();
        }

        // Анимация перемещения по pixel-позиции (рассчитанной Positioning)
        if (key === 'pos') {
            node.to({ x: State.units[id].x, y: State.units[id].y, duration: 0.3 });
        }

        // Полоска "moved" — юнит закончил движение
        if (key === 'movementCompleted') {
            node.findOne('.movedRect').visible(value);
            node.findOne('.movedText').visible(value);
            if (value) {
                // скрываем "active" — теперь юнит "moved"
                node.findOne('.activeRect').visible(false);
                node.findOne('.activeText').visible(false);
            }
        }

        // CX-маркер при exhausted (после DT)
        if (key === 'exhausted') {
            node.findOne('.cxText').visible(value);
        }

        // Полоска "active" — юнит начал двигаться (но не закончил)
        if (key === 'hasStartedMoving') {
            const completed = State.units[id].movementCompleted;
            node.findOne('.activeRect').visible(value && !completed);
            node.findOne('.activeText').visible(value && !completed);
        }

        node.getLayer().batchDraw();
    });
}