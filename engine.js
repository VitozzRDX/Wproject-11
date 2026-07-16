import { State } from './state.js';
import { Rules } from './rules.js';
import { PhaseManager } from './phase_manager.js';
import { pixelToHex, hexToPixel, hexLabel } from './hexUtils.js';
import { UIState } from './uiState.js';
import { spawn_unit } from './unitloading.js';
import { lastHits } from './terrainLOS.js';
import { flipReplaceUnit, raiseToTop } from './renderer.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

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
            UIState.removeButton('PlaceSmoke');

            return;
        }
    },
    
    DefensiveFirstFire: async (ctx) => {
        const targetHex = pixelToHex(ctx.pos.x, ctx.pos.y);
        const hexUnits  = _movedTargetsInHex(targetHex);
        if (hexUnits.length === 0) return;

        const firegroupUnits = State.fireGroup.map(id => State.units[id]);

        // 3.3.3: тот же стрелок не может стрелять по той же цели в том же гексе если MF<2
        if (_illegal_targets(hexUnits, firegroupUnits)) {
            console.log('Rule 3.3.3: same shooter → same target in same hex with MF<2 — отклонено');
            return;
        }

        const result = Rules.defensiveFF(firegroupUnits, targetHex, hexUnits, State.units);
        if (result === null) return;   // SFF constraint violated — LOS не рисуем

        _drawLOS(firegroupUnits, targetHex);
        UIState.flashHitPoints([...lastHits]);   // DEBUG — зелёные точки в местах пересечений

        await _apply_changes_for_targets(result.changes);
        _recordFiredFrom(firegroupUnits, hexUnits);

        // defender обновляет firing counter:
        //   ' ' → FirstFire (первый выстрел этого MPh)
        //   'FirstFire' → FinalFire (после SFF)
        firegroupUnits.forEach(u => {
            if (u.firingStatus === undefined) return;
            if (u.firingStatus === 'FirstFire') {
                State.setUnit(u.id, 'firingStatus', 'FinalFire');
            } else if (u.firingStatus === ' ') {
                State.setUnit(u.id, 'firingStatus', 'FirstFire');
            }
        });

        State.fireGroup.forEach(id => State.setUnit(id, 'inFireGroup', false));
        State.fireGroup = [];
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
    PlaceSmoke: () => {
        if (!Rules.checkIfPlaceSmokeForMovementGroupIsValid(State.movementGroup, State.units)) return;
        State.movementGroup.forEach(id => _expend_mf(id, 1));
        console.log('smoke placed');
        UIState.removeButton('PlaceSmoke');
    },
}

// Централизованная трата MF — любое действие, расходующее MF юнита
// (движение, дым и т.д.). Обновляет mf, накапливает mf_spent_in_current_hex
// и сбрасывает историю огня.
function _expend_mf(unitId, cost) {
    const u = State.units[unitId];
    State.setUnit(unitId, 'mf', u.mf - cost);
    State.setUnit(unitId, 'mf_spent_in_current_hex', u.mf_spent_in_current_hex + cost);
    State.setUnit(unitId, 'hasStartedMoving', true);
    State.fired_from_on_target_in_hex = {};
    State.mfspent = true;

    // юнит потративший MF становится валидной целью DFF (правило 3.3.3)
    if (!State.moved_movement_group) State.moved_movement_group = [];
    if (!State.moved_movement_group.includes(unitId)) State.moved_movement_group.push(unitId);
}

// Проверка ограничений на огонь по конкретной цели:
//   3.3.3 — количество выстрелов из одного гекса по одной цели не может превышать
//           MF, потраченные целью на вход в текущий гекс.
//   3.2.2 — юниты в одном гексе, атакующие одну цель, обязаны стрелять как одна FG.
//           Т.е. новый юнит из того же гекса не может присоединиться после того,
//           как из этого гекса уже стреляли по этой цели без него.
// Возвращает true если хоть одно ограничение нарушено — атака запрещена целиком.
function _illegal_targets(targets, firegroupUnits) {
    for (const shooter of firegroupUnits) {
        const shooterLabel = hexLabel(shooter.hex.col, shooter.hex.row);
        const record = State.fired_from_on_target_in_hex[shooterLabel] || {};

        for (const t of targets) {
            const entry = record[t.id];
            if (!entry) continue;   // из этого гекса по этой цели ещё не стреляли — пропускаем

            // 3.3.3: количество выстрелов уже равно MF цели → больше нельзя
            if (entry.count >= t.mf_spent_in_current_hex) return true;

            // 3.2.2: сепаратная атака — в текущей FG есть юнит из этого гекса,
            // которого не было в оригинальной группе стрелявших
            const shootersFromThisHex = firegroupUnits
                .filter(f => hexLabel(f.hex.col, f.hex.row) === shooterLabel)
                .map(f => f.id);
            const isSeparateAttack = shootersFromThisHex.some(id => !entry.firers.includes(id));
            if (isSeparateAttack) return true;
        }
    }
    return false;
}

// После успешного огня — обновить историю:
//   для каждого стрелка (по его гексу) и каждой цели инкрементим count и
//   добавляем id стрелка в список firers, если его там ещё нет.
function _recordFiredFrom(firegroupUnits, hexUnits) {
    firegroupUnits.forEach(shooter => {
        const label = hexLabel(shooter.hex.col, shooter.hex.row);
        if (!State.fired_from_on_target_in_hex[label]) State.fired_from_on_target_in_hex[label] = {};
        hexUnits.forEach(t => {
            const entry = State.fired_from_on_target_in_hex[label][t.id] || { count: 0, firers: [] };
            entry.count++;
            if (!entry.firers.includes(shooter.id)) entry.firers.push(shooter.id);
            State.fired_from_on_target_in_hex[label][t.id] = entry;
        });
    });
}

// нарисовать LOS-линии от каждого стрелка к центру targetHex
function _drawLOS(firegroupUnits, targetHex) {
    const targetCenter = hexToPixel(targetHex.col, targetHex.row);
    firegroupUnits.forEach(u => {
        UIState.flashLOS(hexToPixel(u.hex.col, u.hex.row), targetCenter);
    });
}

// удалить юнит из игры (Konva + State)
function _remove_unit(unitId) {
    const u = State.units[unitId];
    if (!u) return;
    const layer = u.node.getLayer();
    u.node.destroy();
    delete State.units[unitId];
    State.movementGroup = State.movementGroup.filter(x => x !== unitId);
    if (State.movementGroup.length === 0) {
        State.movementStackHex = null;
    }
    State.fireGroup = State.fireGroup.filter(x => x !== unitId);
    if (State.moved_movement_group) {
        State.moved_movement_group = State.moved_movement_group.filter(x => x !== unitId);
    }
    layer?.batchDraw();
}

// заменить юнит на новый (по templateId) в том же гексе — с флип-анимацией.
// Перед удалением капим статусы старого; после спавна применяем их к новому
// (broken/DM/pinned/exhausted survivor должен сохраниться).
function _replace_unit(oldId, newTemplateId, newId) {
    const old = State.units[oldId];
    if (!old) return;

    const inherit = {
        broken:            old.broken,
        desperationMorale: old.desperationMorale,
        pinned:            old.pinned,
        exhausted:         old.exhausted,
    };

    const hex   = old.hex;
    const layer = old.node.getLayer();

    flipReplaceUnit(old.node, async () => {
        _remove_unit(oldId);
        const newUnit = await spawn_unit(newTemplateId, newId, hex, layer);
        for (const [key, val] of Object.entries(inherit)) {
            if (val) State.setUnit(newId, key, true);
        }
        return newUnit.node;
    });
}

// применить changes от defensiveFF: { unitId: 'broken'|'pinned'|'eliminated'|'reduced'|'wounded' }
async function _apply_changes_for_targets(changes) {
    for (const [id, state] of Object.entries(changes)) {
        // eliminated — юнит уничтожается физически
        if (state === 'eliminated') {
            _remove_unit(id);
            await sleep(300);
            continue;
        }
        // reduced — squad заменяется на свой half-squad
        if (state === 'reduced') {
            const u = State.units[id];
            if (u?.halfSquad) _replace_unit(id, u.halfSquad, id);
            await sleep(300);
            continue;
        }

        // pinned/broken/wounded — поднять юнит наверх, затем флип
        const u = State.units[id];
        if (u) raiseToTop(u);
        await sleep(150);

        State.setUnit(id, state, true);
        // Rules могли замутировать флаги — синкаем через State.setUnit чтобы Renderer их подхватил
        if (u?.desperationMorale) State.setUnit(id, 'desperationMorale', true);
        // NMC-fail сбрасывает Pin и CX — синкаем чтобы Renderer убрал маркеры
        if (u && state === 'broken') {
            State.setUnit(id, 'pinned',    u.pinned);
            State.setUnit(id, 'exhausted', u.exhausted);
        }
        if ((state === 'pinned' || state === 'broken') && State.movementGroup.includes(id)) {
            State.setUnit(id, 'inMovementGroup', false);
            State.movementGroup = State.movementGroup.filter(x => x !== id);
            if (State.movementGroup.length === 0) {
                State.movementStackHex = null;
            }
        }
        await sleep(300);
    }
}

// двинувшиеся юниты в targetHex — валидные цели Defensive First Fire
function _movedTargetsInHex(targetHex) {
    const moved = State.moved_movement_group || [];
    return moved
        .map(id => State.units[id])
        .filter(u => u.hex.col === targetHex.col && u.hex.row === targetHex.row);
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
    // 3.3.3: любая трата MF сбрасывает историю огня
    State.fired_from_on_target_in_hex = {};

    Object.entries(result.unitChanges).forEach(([unitId, fields]) => {
        const u = State.units[unitId];
        const cost = Rules.checkCost(targetHex, u.hex, overrideTerrain);
        State.setUnit(unitId, 'mf_spent_in_current_hex', cost);
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

        if (Rules.checkIfPlaceSmokeForMovementGroupIsValid(State.movementGroup, State.units)) {
            UIState.addButton('PlaceSmoke', { x: 10, y: 260, label: 'PlaceSmoke' });
        } else {
            UIState.removeButton('PlaceSmoke');
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