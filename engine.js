import { State } from './state.js';
import { Rules } from './rules.js';
import { PhaseManager } from './phase_manager.js';
import { pixelToHex } from './hexUtils.js';
import { UIState } from './uiState.js';

const handlers = {
    // SELECT_UNIT: (ctx) => {
    //     console.log('SELECTED UNIT',ctx.unitId);
    //     // Отменяем селекшн предыдущего юнита перед выбором нового
    //     if (State.selected !== null) {
    //         State.setUnit(State.selected, 'selected', false);
    //     }
    //     State.selected = ctx.unitId;
    //     State.setUnit(ctx.unitId, 'selected', true);
    //     _addToMovementGroup(ctx.unitId);
    //     _addToFireGroup(ctx.unitId);
    // },
    addToMovingGroup: (ctx) => {
        _addToMovementGroup(ctx.unitId);
    },
    addToFireGroup: (ctx) => {
        _addToFireGroup(ctx.unitId);
    },

    MOVE: (ctx) => {

        const targetHex = pixelToHex(ctx.pos.x, ctx.pos.y);

        // Woods-Road — отложить мув, спросить игрока
        if (Rules._hasWoodsRoad(targetHex) && !State.pendingMove) {
            State.pendingMove = { targetHex };
            UIState.addButton('UseWoods', { x: 10, y: 180, label: 'UseWoods' });
            UIState.addButton('UseRoad',  { x: 10, y: 220, label: 'UseRoad' });
            return;
        }

        _executeMove(targetHex, null);
    },
    UseWoods: () => {
        if (!State.pendingMove) return;
        _executeMove(State.pendingMove.targetHex, 'forest');
    },
    UseRoad: () => {
        if (!State.pendingMove) return;
        _executeMove(State.pendingMove.targetHex, 'dirtRoad');
    },
    DESELECT_ALL: () => {
        // если ждём выбор Woods-Road — отменяем, но MG не сбрасываем
        if (State.pendingMove) {
            State.pendingMove = null;
            UIState.removeButton('UseWoods');
            UIState.removeButton('UseRoad');
            return;
        }
        if (State.fireGroup.length > 0) {
            for (const unitId of State.fireGroup) {
                State.setUnit(unitId, 'inFireGroup', false);
            }
            State.fireGroup = [];
            return;
        }
        if (State.movementGroup.length > 0) {
            // отмена деклараций AM/DT для юнитов которые ещё не двинулись
            for (const id of State.movementGroup) {
                const u = State.units[id];
                if (u.hasStartedMoving) continue;
                if (u.assaultMovement) {
                    State.setUnit(id, 'assaultMovement', false);
                }
                if (u.doubleTime) {
                    State.setUnit(id, 'mf', u.mf - 2);
                    State.setUnit(id, 'doubleTime', false);
                    State.setUnit(id, 'exhausted', false);
                }
            }

            // копируем текущую MG в original_group ДО очистки
            State.original_group = [...State.movementGroup];
            for (const unitId of State.movementGroup) {
                State.setUnit(unitId, 'inMovementGroup', false);
            }
            State.movementGroup = [];
            State.movementStackHex = null;
            UIState.removeButton('DoubleTime');
            UIState.removeButton('AssaultMovement');

            return;
        }
    },
    DefensiveFirstFire: (ctx) => {
        // Здесь должна быть логика атаки, которая использует State.fireGroup и ctx.unitId
    },
    NextPhase: () => {
        // заглушка — позже здесь PhaseManager.next() + обновление UIState под новую фазу
    },
    DoubleTime: () => {
        if (!Rules.checkIfDoubleTimeForMovementGroupIsValid(State.movementGroup, State.units)) return;
        State.movementGroup.forEach(id => {
            State.setUnit(id, 'mf', State.units[id].mf + 2);
            State.setUnit(id, 'doubleTime', true);
            State.setUnit(id, 'exhausted', true);
        });
        UIState.removeButton('DoubleTime');
        UIState.removeButton('AssaultMovement');
    },
    AssaultMovement: () => {
        if (!Rules.checkIfAssaultMovementForMovementGroupIsValid(State.movementGroup, State.units)) return;
        State.movementGroup.forEach(id => {
            State.setUnit(id, 'assaultMovement', true);
        });
        UIState.removeButton('AssaultMovement');
        UIState.removeButton('DoubleTime');
    },
}

// Выполнить мув с возможным overrideTerrain (UseWoods='forest' / UseRoad='dirtRoad')
function _executeMove(targetHex, overrideTerrain) {
    const result = Rules.arrangeMovement({
        movementGroup:   State.movementGroup,
        units:           State.units,
        targetHex,
        overrideTerrain,
    });
    if (!result) return;

    _create_splitted_group_in_State(State.movementGroup);
    _finalize_unfinished_previous_MG();
    _apply_movement_result_in_State_for_all_MG(result, targetHex, overrideTerrain);
    _create_moved_movement_group_in_State();
    _clear_MG_if_all_completed();

    State.mfspent = true;

    // UseWoods — пометить юнитов, что использовали Woods-Road защиту
    if (overrideTerrain === 'forest') {
        Object.keys(result.unitChanges).forEach(id => {
            State.setUnit(id, 'usedWoodsRoad', true);
        });
    }

    // чистим pendingMove и кнопки (если были)
    if (State.pendingMove) {
        State.pendingMove = null;
        UIState.removeButton('UseWoods');
        UIState.removeButton('UseRoad');
    }
}

// Авто-очистка movementGroup если все юниты реально закончили движение
// (mf=0 ещё не значит "конец" — может быть доступен road/leader bonus)
function _clear_MG_if_all_completed() {
    if (!State.movementGroup.every(id => State.units[id].movementCompleted)) return;

    State.movementGroup.forEach(id => State.setUnit(id, 'inMovementGroup', false));
    State.movementGroup    = [];
    State.movementStackHex = null;
}

// Применить результат arrangeMovement — per-unit изменения
function _apply_movement_result_in_State_for_all_MG(result, targetHex, overrideTerrain) {
    const isRoad = Rules._isRoadHex(targetHex, overrideTerrain);
    Object.entries(result.unitChanges).forEach(([unitId, fields]) => {
        const u = State.units[unitId];
        State.setUnit(unitId, 'path',              [...u.path, { hex: targetHex, isRoad }]);
        State.setUnit(unitId, 'mf',                fields.mf);
        State.setUnit(unitId, 'hex',               targetHex);
        State.setUnit(unitId, 'leaderBonus',       fields.leaderBonus);
        State.setUnit(unitId, 'roadBonus',         fields.roadBonus);
        State.setUnit(unitId, 'hasStartedMoving',  fields.hasStartedMoving);
        State.setUnit(unitId, 'movementCompleted', fields.movementCompleted);
    });
}

// При движении субсета — отщепить остаток в splitted_group
function _create_splitted_group_in_State(mg) {
    // субсет original_group → отщепляем остаток
    if (State.original_group.length > 1 &&
        mg.every(id => State.original_group.includes(id))) {
        State.splitted_group = State.original_group.filter(id => !mg.includes(id));
        return;
    }
    // субсет splitted_group → ещё дробим
    if (State.splitted_group.length > 1 &&
        mg.every(id => State.splitted_group.includes(id))) {
        State.splitted_group = State.splitted_group.filter(id => !mg.includes(id));
        return;
    }
}

// Финализировать всех "недвинувшихся" предыдущих (правило 1)
function _finalize_unfinished_previous_MG() {
    // 1) если в mg есть юнит вне moved_movement_group — финализировать мовед
    if (State.moved_movement_group &&
        State.movementGroup.some(id => !State.moved_movement_group.includes(id))) {
        State.moved_movement_group.forEach(id => {
            State.setUnit(id, 'mf', 0);
            State.setUnit(id, 'movementCompleted', true);
            State.setUnit(id, 'inMovementGroup', false);
        });
        State.moved_movement_group = null;
    }

    // 2) финализировать всех кто начал движение и не в mg, не в splitted_group
    Object.values(State.units).forEach(u => {
        if (!u.hasStartedMoving)                  return;
        if (u.movementCompleted)                  return;
        if (State.movementGroup.includes(u.id))   return;
        if (State.splitted_group.includes(u.id))  return;
        State.setUnit(u.id, 'mf', 0);
        State.setUnit(u.id, 'movementCompleted', true);
        State.setUnit(u.id, 'inMovementGroup', false);
    });
}

// Обновить moved_movement_group до текущей mg (всегда после успешного мува)
function _create_moved_movement_group_in_State() {
    State.moved_movement_group = [...State.movementGroup];
}

function _addToMovementGroup(unitId) {
    const unit = State.units[unitId];
    const activeSide = PhaseManager.getActiveSide();

    // Если movementStackHex не установлен, записываем гекс текущего юнита
    if (!State.movementStackHex) {
        State.movementStackHex = unit.hex;
    }

    if (!Rules.checkIfAddingToMovementGroupIsValid(unit, State.movementStackHex, activeSide, State.movementGroup, State.units)) {
        return;
    }
    if (!State.movementGroup.includes(unitId)) {
        State.movementGroup.push(unitId);
        State.setUnit(unitId, 'inMovementGroup', true);

        if (Rules.checkIfDoubleTimeForMovementGroupIsValid(State.movementGroup, State.units)) {
            UIState.addButton('DoubleTime', { x: 10, y: 100, label: 'DoubleTime' });
        } else {
            UIState.removeButton('DoubleTime');
        }

        if (Rules.checkIfAssaultMovementForMovementGroupIsValid(State.movementGroup, State.units)) {
            UIState.addButton('AssaultMovement', { x: 10, y: 140, label: 'AssaultMovement' });
        } else {
            UIState.removeButton('AssaultMovement');
        }
    }
}

function _addToFireGroup(unitId) {
    const unit = State.units[unitId];
    const defSide = PhaseManager.getDefendingSide();

    if (!Rules.checkIfAddingToFireGroupIsValid(unit, defSide, State.fireGroup, State.units)) {
        return;
    }
    if (!State.fireGroup.includes(unitId)) {
        State.fireGroup.push(unitId);
        State.setUnit(unitId, 'inFireGroup', true);
    }
}


export const Engine = {

  // Получаем команду от Interpreter и выполняем нужный handler
  execute(command) {  // command → { name: 'MOVE_TO' ctx: { unitId: ..., pos: ... } }
    
    const handler = handlers[command.name];   // достаём обработчик по имени команды
    const ctx = command.ctx;                     // и контекст (вся остальная информация)
    if (!handler) {
      return;
    }
    handler(ctx);                         // вызываем, передаём всю команду
 
  }
}