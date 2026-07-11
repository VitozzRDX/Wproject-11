import { State } from './state.js';

// Анимация флипа юнита на broken-сторону
function flipRendering(node, unit) {
    const x0 = node.x();
    const w  = node.findOne('Image').width();
    const cx = x0 + w / 2;

    node.to({
        x: cx, scaleX: 0, duration: 0.15,
        onFinish: () => {
            if (unit.brokenImage) node.findOne('Image').image(unit.brokenImage);
            node.to({ x: x0, scaleX: 1, duration: 0.15 });
        }
    });
}

// Поднять юнит на верх z-порядка своего слоя
export function raiseToTop(unit) {
    unit.node.moveToTop();
    unit.node.getLayer()?.batchDraw();
}

// Флип с заменой: старая нода сжимается, вызывается onMidflip (там Engine
// удаляет старую и создаёт новую), затем новая разжимается на том же месте.
export function flipReplaceUnit(oldNode, onMidflip) {
    const x0 = oldNode.x();
    const w  = oldNode.findOne('Image').width();
    const cx = x0 + w / 2;

    oldNode.to({
        x: cx, scaleX: 0, duration: 0.15,
        onFinish: async () => {
            const newNode = await onMidflip();
            if (!newNode) return;
            newNode.scaleX(0);
            newNode.x(cx);
            newNode.to({ x: x0, scaleX: 1, duration: 0.15 });
        }
    });
}

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

        // pin-маркер
        if (key === 'pinned') {
            node.findOne('.pinBg').visible(value);
            node.findOne('.pinText').visible(value);
        }

        // broken — флип на broken-сторону
        if (key === 'broken' && value === true) {
            flipRendering(node, State.units[id]);
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