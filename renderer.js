import { State } from './state.js';

// Анимация флипа юнита на broken-сторону
function flipRendering(node, unit) {
    const x0 = unit.x;                // стабильная target-позиция из state — защищает от race с pos-tween
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
// удаляет старую и создаёт новую), затем новая разжимается на её target-позиции из state.
// .to() — метод Konva.Node для анимации свойств: плавно интерполирует свойства ноды от
// текущих значений к указанным за duration секунд, вызывая onFinish в конце.
export function flipReplaceUnit(oldNode, onMidflip) {
    const x0Old = oldNode.x();
    const w     = oldNode.findOne('Image').width();
    const cxOld = x0Old + w / 2;

    oldNode.to({
        x: cxOld, scaleX: 0, duration: 0.15,
        onFinish: async () => {
            const newNode = await onMidflip();
            if (!newNode) return;
            // Target-позиция новой ноды берётся из state (после recalculateHex она правильная).
            // Иначе flip-tween затёр бы pos-tween от positioning.
            const newUnit = State.units[newNode.getAttr('unitId')];
            const x0New   = newUnit ? newUnit.x : x0Old;
            const cxNew   = x0New + w / 2;
            newNode.scaleX(0);
            newNode.x(cxNew);
            newNode.to({ x: x0New, scaleX: 1, duration: 0.15 });
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

        // DM (Desperation Morale) — центр каунтера
        if (key === 'desperationMorale') {
            node.findOne('.dmText').visible(value);
        }

        // wounded — белая полоска сверху: жирный "+" слева, "wound" по центру
        if (key === 'wounded') {
            node.findOne('.woundedRect').visible(value);
            node.findOne('.woundedCross').visible(value);
            node.findOne('.woundedText').visible(value);
        }

        // firing status:
        //   FirstFire → белая полоска внизу с "first fire"
        //   FinalFire → крупное центральное "FF"
        if (key === 'firingStatus') {
            node.findOne('.ffRect').visible(value === 'FirstFire');
            node.findOne('.ffText').visible(value === 'FirstFire');
            node.findOne('.ffBigText').visible(value === 'FinalFire');
        }

        // broken — флип на broken-сторону
        if (key === 'broken' && value === true) {
            flipRendering(node, State.units[id]);
        }

        // Prep Fire marker — юнит отстрелялся в PFPh, движение в MPh заблокировано
        if (key === 'prepFired') {
            node.findOne('.pfText').visible(value);
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