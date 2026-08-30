import { State } from './state.js';
import { Rules } from './rules.js';
import { PhaseManager } from './phase_manager.js';
import { pixelToHex, hexToPixel, hexLabel, hexDistance, isSameHex } from './hexUtils.js';
import { UIState } from './uiState.js';
import { spawn_unit } from './unitloading.js';
import { getLastHit } from './terrainLOS.js';
import { flipReplaceUnit, raiseToTop } from './renderer.js';
import { recalculateHex } from './positioning.js';

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
            State.fireGroupHexesArray = [];
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
                _setInMovementGroup(unitId, false);
            }
            State.movementGroup = [];
            State.movementStackHex = null;
            UIState.removeButton('DoubleTime');
            UIState.removeButton('AssaultMovement');
            UIState.removeButton('PlaceSmoke');
            UIState.removeButton('Drop');
            UIState.removeButton('Recover');

            return;
        }
    },
    
    Fire: async (ctx) => {
        const phase = PhaseManager.getPhase();
        if (phase === 'movement')  return _handleFire(ctx, 'dff');
        if (phase === 'prepFire')  return _handleFire(ctx, 'prep');
    },

    NextPhase: () => {
        const p = PhaseManager.next();
        UIState.rotateImage('turnphase', -45);   // 1/8 оборота против часовой (одна грань)
        console.log(`[phase] → ${p}`);
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
    Drop: () => {
        if (!Rules.checkDropCapability(State.movementGroup, State.units)) return;
        for (const posId of State.movementGroup) {
            let dropped = false;
            Object.values(State.units).forEach(unit => {
                if (unit.category !== 'carried' || unit.possessorId !== posId) return;
                State.setUnit(unit.id, 'possessorId', null);
                State.setUnit(unit.id, 'movedThisMPh', true);
                State.setUnit(unit.id, 'inMovementGroup', false);
                dropped = true;
            });
            if (dropped) recalculateHex(State.units[posId].hex);
        }
        UIState.removeButton('Drop');
    },

    PlaceSmoke: () => {
        State.pendingSmoke = true;
        console.log('[smoke] выбор хекса: свой (1 MF) или соседний (2 MF)');
        UIState.removeButton('PlaceSmoke');
    },

    Drop: () => {
        if (!Rules.checkDropCapability(State.movementGroup, State.units)) return;
        for (const posId of State.movementGroup) {
            let dropped = false;
            Object.values(State.units).forEach(w => {
                if (w.category !== 'carried' || w.possessorId !== posId) return;
                State.setUnit(w.id, 'possessorId', null);
                State.setUnit(w.id, 'movedThisMPh', true);
                State.setUnit(w.id, 'inMovementGroup', false);
                dropped = true;
            });
            if (dropped) recalculateHex(State.units[posId].hex);
        }
        _refreshMGButtons();
    },

    Recover: () => {
        const cand = Rules.findRecoverCandidate(State.movementGroup, State.units);
        if (!cand) return;
        const u = State.units[cand.unitId];

        _expend_mf(cand.unitId, 1);

        const { success } = Rules.rollRecoverAttempt(u);
        if (success) {
            State.setUnit(cand.weaponId, 'possessorId', cand.unitId);
            State.setUnit(cand.weaponId, 'movedThisMPh', true);
            State.setUnit(cand.weaponId, 'inMovementGroup', true);
            recalculateHex(u.hex);
        }
        _refreshMGButtons();
    },

    PlaceSmokeTarget: (ctx) => {
        State.pendingSmoke = false;   // сброс — один клик = одна попытка (успех или отмена)
        const targetHex = pixelToHex(ctx.pos.x, ctx.pos.y);

        const firstId = State.movementGroup[0];
        if (!firstId) return;
        const currentHex = State.units[firstId].hex;
        const dist = hexDistance(currentHex, targetHex);

        let mfCost;
        if (dist === 0)      mfCost = 1;
        else if (dist === 1) mfCost = 2;
        else {
            console.log(`[smoke] хекс (${targetHex.col},${targetHex.row}) слишком далеко — отмена`);
            return;
        }

        const results = Rules.rollSmokePlacementAttempts(State.units, State.movementGroup, mfCost);
        let anySuccess = false;

        for (const [id, r] of Object.entries(results)) {
            _expend_mf(id, mfCost);
            State.setUnit(id, 'smokeAttempted', true);
            if (r.success) anySuccess = true;
            if (r.mfEnded) {
                State.setUnit(id, 'mf', 0);
                State.setUnit(id, 'movementCompleted', true);
                console.log(`[smoke] ${id}: original dr=6 → MPh ended`);
            }
        }

        if (anySuccess) _place_Smoke_if_possible(targetHex);
    },
}

// Общий пайплайн огня: DFF в MPh и prep fire в PFPh отличаются target'ами и пост-обработкой.
// mode: 'dff' | 'prep'
async function _handleFire(ctx, mode) {
    const targetHex = pixelToHex(ctx.pos.x, ctx.pos.y);

    // Target getter: DFF → двинувшиеся atacker'ы; Prep → все defender-infantry в hex'e.
    const getTargets = mode === 'dff'
        ? () => _movedTargetsInHex(targetHex)
        : () => _defenderInfantryInHex(targetHex);

    const initialTargets = getTargets();
    if (initialTargets.length === 0) return;

    const firegroupUnits = State.fireGroup.map(id => State.units[id]);

    // 3.3.3 / 3.2.2 — только для DFF (в PFPh цель не двигается).
    if (mode === 'dff') {
        const illegalReason = _illegal_targets(initialTargets, firegroupUnits);
        if (illegalReason) { console.log(illegalReason); return; }
    }

    const validHexes = Rules.filter_hexes_with_Los(State.fireGroupHexesArray, targetHex, State.orchardInSeason);
    console.log(`[${mode}] valid ${validHexes.length}/${State.fireGroupHexesArray.length} shooter hexes`);

    _drawLOS(State.fireGroupHexesArray, targetHex, validHexes);
    const hit = getLastHit();
    UIState.flashHitPoints(hit ? [hit] : []);

    const firedUnits        = new Set();
    const weaponsKeepingRoF = new Set();

    for (const hexesArr of Rules.array_of_adjacent_Hexes_arrays(validHexes)) {
        const subFG = firegroupUnits.filter(u => Rules.hexInList(u.hex, hexesArr));
        if (subFG.length === 0) continue;
        const targets = getTargets();
        if (targets.length === 0) break;

        console.log(`[${mode}] sub-FG hexes=${hexesArr.map(h=>`(${h.col},${h.row})`).join(',')} units=${subFG.map(u=>u.id).join(',')}`);

        const result = Rules.defensiveFF(subFG, targetHex, targets, State.units, State.orchardInSeason);
        if (result === null) continue;

        subFG.forEach(u => firedUnits.add(u.id));
        for (const id of result.weaponsKeepingRoF) weaponsKeepingRoF.add(id);
        await _apply_changes_for_targets(result.changes);

        // DFF-специфика: fired-from history + residual FP.
        if (mode === 'dff') {
            _recordFiredFrom(subFG, targets);
            const hexKey = `${targetHex.col},${targetHex.row}`;
            if ((result.residualFP ?? 0) > (State.residualFP[hexKey] ?? 0)) {
                State.residualFP[hexKey] = result.residualFP;
                UIState.setResidualFP(targetHex, result.residualFP);
                console.log(`[residual] ${hexKey} → ${result.residualFP}`);
            }
        }
    }

    // Стрелки без LoS всё равно считаются выстрелившими (attempt = fire per rules).
    firegroupUnits.forEach(u => {
        const hasLos = validHexes.some(h => isSameHex(h, u.hex));
        if (!hasLos) firedUnits.add(u.id);
    });

    // firingStatus counter — только для DFF (в PFPh нет FF/FinalFire, есть Prep Fire marker).
    if (mode === 'dff') {
        firegroupUnits.forEach(u => {
            if (!firedUnits.has(u.id)) return;
            if (weaponsKeepingRoF.has(u.id)) return;
            if (u.firingStatus === undefined) return;
            if (u.firingStatus === 'FirstFire') {
                State.setUnit(u.id, 'firingStatus', 'FinalFire');
            } else if (u.firingStatus === ' ') {
                State.setUnit(u.id, 'firingStatus', 'FirstFire');
            }
        });
    }

    // PFPh-специфика: mark prepFired + снять CX (по правилу PFPh).
    if (mode === 'prep') {
        firegroupUnits.forEach(u => {
            if (!firedUnits.has(u.id)) return;
            State.setUnit(u.id, 'prepFired', true);
            if (u.category !== 'carried') State.setUnit(u.id, 'exhausted', false);
        });
    }

    State.fireGroup.forEach(id => State.setUnit(id, 'inFireGroup', false));
    State.fireGroup = [];
    State.fireGroupHexesArray = [];
}

// Все defender-пехотинцы в указанном hex'e (цели для prep-fire).
function _defenderInfantryInHex(targetHex) {
    return Object.values(State.units).filter(u =>
        u.category === 'infantry' &&
        u.side === 'defender' &&
        u.hex && isSameHex(u.hex, targetHex)
    );
}

// Пытается положить дым в хекс. Если уже есть дым — не заменяет (MVP).
function _place_Smoke_if_possible(hex) {
    const hexKey = `${hex.col},${hex.row}`;
    const existing = State.dynamicTerrain[hexKey] ?? [];
    if (existing.some(t => t === 'smoke')) return;
    State.dynamicTerrain[hexKey] = [...existing, 'smoke'];
    UIState.setSmoke(hex);
}

// Централизованная трата MF — любое действие, расходующее MF юнита
// (движение, дым и т.д.). Обновляет mf, накапливает mf_spent_in_current_hex
// и сбрасывает историю огня.
function _expend_mf(unitId, cost) {
    const u = State.units[unitId];
    const newMf = u.mf - cost;
    State.setUnit(unitId, 'mf', newMf);
    State.setUnit(unitId, 'mf_spent_in_current_hex', u.mf_spent_in_current_hex + cost);
    State.setUnit(unitId, 'hasStartedMoving', true);
    State.fired_from_on_target_in_hex = {};
    State.mfspent = true;
    if (newMf === 0) State.setUnit(unitId, 'movementCompleted', true);   // MF исчерпан → MPh закончена

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
// Возвращает строку с причиной отказа (для лога), либо null если ограничений нет.
function _illegal_targets(targets, firegroupUnits) {
    for (const shooter of firegroupUnits) {
        const shooterLabel = hexLabel(shooter.hex.col, shooter.hex.row);
        const record = State.fired_from_on_target_in_hex[shooterLabel] || {};

        for (const t of targets) {
            const entry = record[t.id];
            if (!entry) continue;   // из этого гекса по этой цели ещё не стреляли — пропускаем

            // 3.2.2 (проверяем первой — более специфичная причина): сепаратная атака.
            // В текущей FG есть юнит из этого гекса, которого не было в оригинальной группе стрелявших.
            const shootersFromThisHex = firegroupUnits
                .filter(f => hexLabel(f.hex.col, f.hex.row) === shooterLabel)
                .map(f => f.id);
            const isSeparateAttack = shootersFromThisHex.some(id => !entry.firers.includes(id));
            if (isSeparateAttack) {
                return `Rule 3.2.2: юниты в одном hex, стреляющие в одну цель, обязаны стрелять как единая FG (hex ${shooterLabel}, цель ${t.id})`;
            }

            // 3.3.3: количество выстрелов уже равно MF цели → больше нельзя
            if (entry.count >= t.mf_spent_in_current_hex) {
                return `Rule 3.3.3: из hex ${shooterLabel} по цели ${t.id} уже ${entry.count} выстрел(ов) = MF цели (${t.mf_spent_in_current_hex}), больше нельзя`;
            }
        }
    }
    return null;
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
function _drawLOS(shooterHexes, targetHex, validHexes) {
    const targetCenter = hexToPixel(targetHex.col, targetHex.row);
    shooterHexes.forEach(h => {
        const isValid = validHexes.some(v => isSameHex(v, h));
        UIState.flashLOS(
            hexToPixel(h.col, h.row),
            targetCenter,
            isValid ? 'lime' : 'red'
        );
    });
}

// удалить юнит из игры (Konva + State)
function _remove_unit(unitId) {
    const u = State.units[unitId];
    if (!u) return;
    const hexOfDead = u.hex;   // запомнить чтобы перепозиционировать weapons после удаления
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

    // Possessed weapons убитого юнита — падают на землю (drop):
    // сбрасываем possessorId, снимаем рамки MG/FG, вычёркиваем из State.fireGroup
    Object.values(State.units).forEach(w => {
        if (w.category !== 'carried' || w.possessorId !== unitId) return;
        State.setUnit(w.id, 'possessorId', null);
        State.setUnit(w.id, 'inMovementGroup', false);
        State.setUnit(w.id, 'inFireGroup', false);
        State.fireGroup = State.fireGroup.filter(x => x !== w.id);
    });

    // Перепозиционировать хекс — unpossessed weapons уйдут в низ стека по _stackOrder
    if (hexOfDead) recalculateHex(hexOfDead);

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
    const side  = old.side;   // роль наследуется — новый HS/reduced юнит той же стороны

    // Список weapons possessed старым юнитом — переедут на нового (reduce ≠ гибель)
    const inheritedWeapons = Object.values(State.units)
        .filter(u => u.category === 'carried' && u.possessorId === oldId)
        .map(u => u.id);

    // Был ли старый юнит в moved_movement_group — новый должен занять его место
    // (иначе _movedTargetsInHex не увидит HS как валидную цель для последующего DFF)
    const wasInMovedMG = State.moved_movement_group?.includes(oldId) ?? false;

    flipReplaceUnit(old.node, async () => {
        _remove_unit(oldId);   // временно сбросит possessorId у weapons — восстановим ниже
        const newUnit = await spawn_unit(newTemplateId, newId, hex, layer, side);
        for (const [key, val] of Object.entries(inherit)) {
            if (val) State.setUnit(newId, key, true);
        }
        // Восстанавливаем possessorship weapons на новом юните
        for (const wid of inheritedWeapons) {
            State.setUnit(wid, 'possessorId', newId);
        }
        // Возвращаем нового юнита в moved_movement_group (для DFF на HS)
        if (wasInMovedMG) {
            if (!State.moved_movement_group) State.moved_movement_group = [];
            if (!State.moved_movement_group.includes(newId)) {
                State.moved_movement_group.push(newId);
            }
        }
        // Перепозиционировать стек: weapon (снова possessed) над HS
        recalculateHex(hex);
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
        // quality_reduce (ELR 5.1) — юнит заменяется на lower-quality того же размера
        if (state === 'quality_reduce') {
            const u = State.units[id];
            if (u?.lowerQuality) _replace_unit(id, u.lowerQuality, id);
            await sleep(300);
            continue;
        }
        // reduce_then_quality — original 12 + fail > ELR: сначала CR, потом quality reduce на новом HS
        if (state === 'reduce_then_quality') {
            const u = State.units[id];
            if (u?.halfSquad) {
                _replace_unit(id, u.halfSquad, id);
                await sleep(300);
                const newHS = State.units[id];
                if (newHS?.lowerQuality) {
                    _replace_unit(id, newHS.lowerQuality, id);
                    await sleep(300);
                }
            }
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
        // (только для infantry — у weapon нет pinned/exhausted)
        if (u && state === 'broken' && u.category !== 'carried') {
            State.setUnit(id, 'pinned',    u.pinned);
            State.setUnit(id, 'exhausted', u.exhausted);
        }
        if ((state === 'pinned' || state === 'broken') && State.movementGroup.includes(id)) {
            _setInMovementGroup(id, false);
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
        .filter(u => isSameHex(u.hex, targetHex));
}

// Выполнить мув с возможным overrideTerrain (UseWoods='forest' / UseRoad='dirtRoad')
async function _executeMove(targetHex, overrideTerrain) {
    const result = Rules.arrangeMovement({
        movementGroup:   State.movementGroup,
        units:           State.units,
        targetHex,
        overrideTerrain,
    });
    if (!result) return;

    _create_splitted_group_in_State(State.movementGroup);
    _finalize_unfinished_previous_MG();
    await _apply_movement_result_in_State_for_all_MG(result, targetHex, overrideTerrain);
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

    // hex юнитов сменился → Recover eligibility могла появиться/пропасть
    _refreshMGButtons();
}

// Авто-очистка movementGroup если все юниты реально закончили движение
// (mf=0 ещё не значит "конец" — может быть доступен road/leader bonus)
function _clear_MG_if_all_completed() {
    if (!State.movementGroup.every(id => State.units[id].movementCompleted)) return;

    State.movementGroup.forEach(id => _setInMovementGroup(id, false));
    State.movementGroup    = [];
    State.movementStackHex = null;
}

// Применить результат arrangeMovement — per-unit изменения
async function _apply_movement_result_in_State_for_all_MG(result, targetHex, overrideTerrain) {
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

        // Possessed carried едут с possessor'ом
        Object.values(State.units).forEach(w => {
            if (w.category === 'carried' && w.possessorId === unitId) {
                State.setUnit(w.id, 'hex', targetHex);
            }
        });
    });

    // Residual FP (правило 3.3.5): если в хексе есть residual counter,
    // все только что вошедшие юниты атакуются одной IFT DR (leader first через _processMC)
    const hexKey     = `${targetHex.col},${targetHex.row}`;
    const residualFP = State.residualFP[hexKey] ?? 0;
    if (residualFP > 0) {
        const enteringUnits = Object.keys(result.unitChanges).map(id => State.units[id]);
        console.log(`[residual trigger] hex=${hexKey} FP=${residualFP} targets=${enteringUnits.map(u=>u.id).join(',')}`);
        const changes = Rules.residualAttack(residualFP, enteringUnits, targetHex);
        if (Object.keys(changes).length > 0) {
            await _apply_changes_for_targets(changes);
        }
    }
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
            _setInMovementGroup(id, false);
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
        _setInMovementGroup(u.id, false);
    });
}

// Обновить moved_movement_group до текущей mg (всегда после успешного мува)
function _create_moved_movement_group_in_State() {
    State.moved_movement_group = [...State.movementGroup];
}

// Синхронно ставит/снимает inMovementGroup у юнита И всех его possessed carried
function _setInMovementGroup(unitId, value) {
    State.setUnit(unitId, 'inMovementGroup', value);
    Object.values(State.units).forEach(u => {
        if (u.category === 'carried' && u.possessorId === unitId) {
            State.setUnit(u.id, 'inMovementGroup', value);
        }
    });
}

function _addToMovementGroup(unitId) {
    let unit = State.units[unitId];

    // Клик по carried → редиректим на possessor'а (weapon сам не добавляется в MG,
    // но при добавлении possessor'а подсветится через _setInMovementGroup)
    if (unit?.category === 'carried' && unit.possessorId) {
        unitId = unit.possessorId;
        unit   = State.units[unitId];
    }

    // Если movementStackHex не установлен, записываем гекс текущего юнита
    if (!State.movementStackHex) {
        State.movementStackHex = unit.hex;
    }

    // В MPh движется attacker (interpreter уже отфильтровал phase — сюда доходит только в MPh).
    if (!Rules.checkIfAddingToMovementGroupIsValid(unit, State.movementStackHex, 'attacker', State.movementGroup, State.units)) {
        return;
    }
    if (!State.movementGroup.includes(unitId)) {
        State.movementGroup.push(unitId);
        _setInMovementGroup(unitId, true);
        _refreshMGButtons();
    }
}

// Централизованно пересчитывает состояние кнопок MG (DoubleTime/AssaultMovement/
// PlaceSmoke/Drop/Recover). Вызывать после любого изменения MG: добавление юнита,
// после мува (hex сменился), после Drop/Recover (possessed weapons изменились).
function _refreshMGButtons() {
    const mg = State.movementGroup;

    if (Rules.checkIfDoubleTimeForMovementGroupIsValid(mg, State.units)) {
        UIState.addButton('DoubleTime', { x: 10, y: 100, label: 'DoubleTime' });
    } else {
        UIState.removeButton('DoubleTime');
    }

    if (Rules.checkIfAssaultMovementForMovementGroupIsValid(mg, State.units)) {
        UIState.addButton('AssaultMovement', { x: 10, y: 140, label: 'AssaultMovement' });
    } else {
        UIState.removeButton('AssaultMovement');
    }

    if (Rules.checkIfPlaceSmokeForMovementGroupIsValid(mg, State.units)) {
        UIState.addButton('PlaceSmoke', { x: 10, y: 260, label: 'PlaceSmoke' });
    } else {
        UIState.removeButton('PlaceSmoke');
    }

    if (Rules.checkDropCapability(mg, State.units)) {
        UIState.addButton('Drop', { x: 10, y: 300, label: 'Drop' });
    } else {
        UIState.removeButton('Drop');
    }

    if (Rules.findRecoverCandidate(mg, State.units)) {
        UIState.addButton('Recover', { x: 10, y: 340, label: 'Recover' });
    } else {
        UIState.removeButton('Recover');
    }
}

function _addToFireGroup(unitId) {
    const unit = State.units[unitId];
    // Сторона стреляющих зависит от фазы:
    //   PFPh → attacker (prep fire).
    //   MPh  → defender (DFF).
    const firingSide = PhaseManager.getPhase() === 'prepFire' ? 'attacker' : 'defender';

    if (!Rules.checkIfAddingToFireGroupIsValid(unit, firingSide, State.fireGroup, State.units)) {
        return;
    }
    if (!State.fireGroup.includes(unitId)) {
        State.fireGroup.push(unitId);
        State.setUnit(unitId, 'inFireGroup', true);

        const key = `${unit.hex.col},${unit.hex.row}`;
        if (!State.fireGroupHexesArray.some(h => `${h.col},${h.row}` === key)) {
            State.fireGroupHexesArray.push({ col: unit.hex.col, row: unit.hex.row });
        }
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