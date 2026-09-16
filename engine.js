import { State } from './state.js';
import { Rules } from './rules.js';
import { PhaseManager } from './phase_manager.js';
import { pixelToHex, hexToPixel, hexLabel, hexDistance, isSameHex, isAdjacent, calcNearestHexes, bfsHexes, dijkstraHexes, reconstructPath } from './hexUtils.js';
import { terrainAt } from './cards.js';
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
    
    Fire: async (ctx) => _handleFire(ctx),

    SelectRouter: (ctx) => {
        const uid = ctx.unitId;

        // Снять жёлтую рамку с прежнего router'а (если это не тот же юнит).
        if (State.routingUnit && State.routingUnit !== uid) {
            State.setUnit(State.routingUnit, 'inRouting', false);
        }
        State.routingUnit = uid;
        State.setUnit(uid, 'inRouting', true);
        const u = State.units[uid];

        // Уже считали для этого юнита в этом RtPh — просто перерисовать по кэшу.
        if (u.routComputed) {
            _redrawRoutOverlay(u);
            return;
        }

        // Первый выбор — считаем всё с нуля.
        State.setUnit(uid, 'mf', 6);

        // 1. KEU-список (merge со стартовым — при первом клике не должен прирасти).
        const keuIDs = _updateKEUList(u, u.keuIDsList);
        State.setUnit(uid, 'keuIDsList', keuIDs);
        const keuUnits = keuIDs.map(id => State.units[id]);

        // 2. Карта MF-цен от юнита до каждого достижимого легального хекса в бюджете 6.
        const hexToHexesCostsMap = Rules.calc_hex_to_every_hex_dist_map(u.hex, keuUnits, 6);

        // 3. Nearest-by-MF shelter'ы (пустой массив если ни один не достижим).
        const shelters = Rules.pickNearestShelters(hexToHexesCostsMap);

        // Кэшируем на юните.
        State.setUnit(uid, 'hexToHexesCostsMap', hexToHexesCostsMap);
        State.setUnit(uid, 'shelterHexes',       shelters);
        _clearCorridor(u);
        State.setUnit(uid, 'routComputed',       true);

        console.log(`[RtPh] selected ${uid}, MF=6, KEU=[${keuIDs.join(',')}], shelters=${shelters.length}`);

        _redrawRoutOverlay(State.units[uid]);
    },

    PickShelter: (ctx) => {
        const unit = State.units[State.routingUnit];
        if (!unit) return;

        const clickedHex = pixelToHex(ctx.pos.x, ctx.pos.y);
        if (!(unit.shelterHexes || []).some(s => isSameHex(s, clickedHex))) return;

        const keuUnits = unit.keuIDsList.map(id => State.units[id]);
        _buildCorridor(unit, clickedHex, keuUnits, unit.mf, unit.hexToHexesCostsMap);

        console.log(`[RtPh] ${unit.id} chose shelter (${clickedHex.col},${clickedHex.row}), corridor=${unit.routPathHexes.size}`);
        _redrawRoutOverlay(unit);
    },

    RoutMove: (ctx) => {
        const unit = State.units[State.routingUnit];
        const targetHex = pixelToHex(ctx.pos.x, ctx.pos.y);
        const targetKey = `${targetHex.col},${targetHex.row}`;

        if (!isAdjacent(unit.hex, targetHex)) return;

        // Легальность: коридор ИЛИ (в free-rout mode) isLegalRoutStep.
        const keuUnitsOld = unit.keuIDsList.map(id => State.units[id]);
        const legal = unit.routPathHexes
            ? unit.routPathHexes.has(targetKey)
            : Rules.isLegalRoutStep(unit.hex, targetHex, keuUnitsOld);
        if (!legal) {
            console.log(`[RtPh] ${unit.id}: (${targetHex.col},${targetHex.row}) не легален`);
            return;
        }

        // Cost + move (Woods-Road автоматически как forest в rout-фазе).
        const isWoodsRoad = Rules._hasWoodsRoad(targetHex);
        const cost = Rules.checkCost(targetHex, unit.hex, isWoodsRoad ? 'forest' : null);
        if (unit.mf < cost) {
            console.log(`[RtPh] ${unit.id}: не хватает MF (${unit.mf} < ${cost})`);
            return;
        }

        const isRoad = isWoodsRoad ? false : Rules._isRoadHex(targetHex);
        State.setUnit(unit.id, 'path', [...unit.path, { hex: targetHex, isRoad }]);
        State.setUnit(unit.id, 'mf', unit.mf - cost);
        State.setUnit(unit.id, 'hex', targetHex);
        if (isWoodsRoad) State.setUnit(unit.id, 'usedWoodsRoad', true);
        console.log(`[RtPh] ${unit.id} → (${targetHex.col},${targetHex.row}), MF=${unit.mf}`);

        // Auto-end: пришли в chosenShelter ИЛИ MF=0.
        const reachedShelter = unit.chosenShelter && isSameHex(unit.chosenShelter, targetHex);
        const mfExhausted   = unit.mf === 0;
        if (reachedShelter || mfExhausted) {
            UIState.setRoutShelters([]);
            UIState.setRoutPathHexes([]);
            UIState.setRoutLegalHexes([]);
            State.setUnit(unit.id, 'inRouting', false);
            State.setUnit(unit.id, 'mustRout', false);
            State.setUnit(unit.id, 'hexToHexesCostsMap', null);
            _clearCorridor(unit);
            State.setUnit(unit.id, 'routComputed', false);
            State.routingUnit = null;
            console.log(`[RtPh] ${unit.id} rout ended (${reachedShelter ? 'shelter' : 'MF=0'})`);
            return;
        }

        // Обновить KEU-список с новой позиции.
        const oldKEUIDs = unit.keuIDsList;
        const newKEUIDs = _updateKEUList(unit, oldKEUIDs);

        if (newKEUIDs.length === oldKEUIDs.length) return;   // KEU не менялся → ничего не пересчитываем

        State.setUnit(unit.id, 'keuIDsList', newKEUIDs);     // KEU расширился → пересчёт
        console.log(`[RtPh] ${unit.id} new KEU: [${newKEUIDs.filter(id => !oldKEUIDs.includes(id)).join(',')}]`);
        const keuUnits = newKEUIDs.map(id => State.units[id]);

        const newCostsFromCurrent = Rules.calc_hex_to_every_hex_dist_map(unit.hex, keuUnits, unit.mf);   // forward от новой позиции с новым KEU и остатком MF
        State.setUnit(unit.id, 'hexToHexesCostsMap', newCostsFromCurrent);

        const chosenKey = unit.chosenShelter ? `${unit.chosenShelter.col},${unit.chosenShelter.row}` : null;
        const oldStillReachable = chosenKey && newCostsFromCurrent.has(chosenKey);   // старый chosenShelter всё ещё достижим?

        if (oldStillReachable) {
            _buildCorridor(unit, unit.chosenShelter, keuUnits, unit.mf, newCostsFromCurrent);
        } else {
            const newShelters = Rules.pickNearestShelters(newCostsFromCurrent);   // destination потерян → ищем новый nearest
            State.setUnit(unit.id, 'shelterHexes', newShelters);
            _clearCorridor(unit);
            console.log(`[RtPh] ${unit.id} destination lost → ${newShelters.length ? `pick new nearest (${newShelters.length})` : 'free-rout'}`);
        }

        _redrawRoutOverlay(unit);
    },

    NextPhase: () => {
        const prevPhase = PhaseManager.getPhase();
        const p = PhaseManager.next();
        UIState.rotateImage('turnphase', -45);   // 1/8 оборота против часовой (одна грань)
        console.log(`[phase] → ${p}`);

        // Конец MPh: убрать все Residual FP counters с карты.
        if (prevPhase === 'movement') {
            for (const key of Object.keys(State.residualFP)) {
                const [col, row] = key.split(',').map(Number);
                UIState.setResidualFP({ col, row }, 0);
            }
            State.residualFP = {};
            console.log('[MPh end] cleared Residual FP counters');
        }

        // Правило DFPh: убрать все First/Final Fire counters в конце фазы.
        if (prevPhase === 'defensiveFire') {
            for (const u of Object.values(State.units)) {
                if (u.firingStatus !== undefined && u.firingStatus !== ' ') {
                    State.setUnit(u.id, 'firingStatus', ' ');
                }
            }
            console.log('[DFPh end] cleared First/Final Fire counters');
        }

        // Правило AFPh: убрать все Prep Fire и Adv Fire counters в конце фазы.
        if (prevPhase === 'advancingFire') {
            for (const u of Object.values(State.units)) {
                if (u.prepFired) State.setUnit(u.id, 'prepFired', false);
                if (u.advFired)  State.setUnit(u.id, 'advFired', false);
            }
            console.log('[AFPh end] cleared Prep Fire and Adv Fire markers');
        }

        // Вход в RtPh: пометить всех, кто обязан раутиться (3.6). Плюс закэшировать на юните:
        //   keuIDsList  — enemy с LoS до юнита (для правила "не сокращать range");
        //   shelterHexes — потенциальные укрытия (woods/building) в радиусе 6, не хуже старта.
        // Вход в RtPh: пометить обязанных раутиться + кэш стартового KEU-списка.
        // Shelter'ы и коридор НЕ считаем — это делается при SelectRouter.
        if (p === 'rout') {
            for (const u of Object.values(State.units)) {
                if (Rules.mustRout(u, State.units, State.orchardInSeason)) {
                    State.setUnit(u.id, 'mustRout', true);
                    const keu = Rules.buildKEUList(u, State.units, State.orchardInSeason);
                    State.setUnit(u.id, 'keuIDsList', keu.map(k => k.id));
                    console.log(`[RtPh] ${u.id} must rout, KEU=[${keu.map(k => k.id).join(',')}]`);
                }
            }
        }

        // Выход из RtPh: снять все rout-поля + overlay.
        if (prevPhase === 'rout') {
            for (const u of Object.values(State.units)) {
                if (u.mustRout)              State.setUnit(u.id, 'mustRout', false);
                if (u.keuIDsList?.length)    State.setUnit(u.id, 'keuIDsList', []);
                if (u.shelterHexes?.length)  State.setUnit(u.id, 'shelterHexes', []);
                if (u.chosenShelter)         State.setUnit(u.id, 'chosenShelter', null);
                if (u.hexToHexesCostsMap)    State.setUnit(u.id, 'hexToHexesCostsMap', null);
                if (u.routPathHexes)         State.setUnit(u.id, 'routPathHexes', null);
                if (u.routMinCostToShelter)  State.setUnit(u.id, 'routMinCostToShelter', null);
                if (u.routComputed)          State.setUnit(u.id, 'routComputed', false);
                if (u.inRouting)             State.setUnit(u.id, 'inRouting', false);
            }
            State.routingUnit = null;
            UIState.setRoutLegalHexes([]);
            UIState.setRoutShelters([]);
            UIState.setRoutPathHexes([]);
            console.log('[RtPh end] cleared all rout state');
        }
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

// Общий пайплайн огня для всех фаз (MPh DFF, PFPh prep, DFPh Final Fire).
// Structure: сначала формируем sub-FGs + рисуем LoS-визуал; затем switch по фазе
// с pre-checks и loop по sub-FG (у каждой фазы свой target getter и пост-обработка).
// -----------------------------------------------------------------------------
// Обновляет KEU-список router'а: добавляет enemy, которые теперь в LoS к его hex'у.
// По правилу список только растёт ("nor may it move towards such a unit after
// leaving its LOS during that RtPh"). Возвращает merged id-list.
// -----------------------------------------------------------------------------
function _updateKEUList(unit, existingKEUIDs) {
    const merged = new Set(existingKEUIDs);
    for (const other of Object.values(State.units)) {
        if (other.side === unit.side) continue;
        if (other.category === 'carried') continue;
        if (merged.has(other.id)) continue;
        if (!Rules.checkLOS(other.hex, unit.hex, State.orchardInSeason)) continue;
        merged.add(other.id);
    }
    return [...merged];
}

// -----------------------------------------------------------------------------
// Перерисовывает rout overlay из уже посчитанных кэшированных полей юнита.
// Три состояния:
//   1. chosenShelter + routPathHexes → shelter (синий) + коридор (фиолетовый)
//   2. shelterHexes есть, chosenShelter нет → все shelter'ы (синие), ждём PickShelter
//   3. shelter'ов нет → free-rout mode, легальные adjacent (зелёные)
// -----------------------------------------------------------------------------
function _redrawRoutOverlay(unit) {
    if (unit.chosenShelter && unit.routPathHexes) {
        UIState.setRoutShelters([unit.chosenShelter]);
        UIState.setRoutPathHexes([...unit.routPathHexes].map(k => {
            const [c, r] = k.split(',').map(Number); return { col: c, row: r };
        }));
        UIState.setRoutLegalHexes([]);
    } else if (unit.shelterHexes?.length) {
        UIState.setRoutShelters(unit.shelterHexes);
        UIState.setRoutPathHexes([]);
        UIState.setRoutLegalHexes([]);
    } else {
        UIState.setRoutShelters([]);
        UIState.setRoutPathHexes([]);
        const keuUnits = unit.keuIDsList.map(id => State.units[id]);
        UIState.setRoutLegalHexes(Rules.legalRoutNeighbors(unit, keuUnits));
    }
}

// -----------------------------------------------------------------------------
// Строит коридор для конкретного chosenShelter (reverse Dijkstra + фильтр по бюджету).
// Кэширует routPathHexes + costsToShelter + chosenShelter на юните.
// -----------------------------------------------------------------------------
function _buildCorridor(unit, chosenShelter, keuUnits, budget, costsFromCurrent) {
    const costsToShelter = Rules.calc_hex_to_every_hex_dist_map(chosenShelter, keuUnits, budget, true);
    const corridor = new Set();
    costsFromCurrent.forEach((costFromUnit, key) => {
        const costToShelter = costsToShelter.get(key);
        if (costToShelter != null && costFromUnit + costToShelter <= budget) corridor.add(key);
    });
    State.setUnit(unit.id, 'chosenShelter', chosenShelter);
    State.setUnit(unit.id, 'routPathHexes', corridor);
    State.setUnit(unit.id, 'routMinCostToShelter', costsToShelter);
}

// Сбрасывает commitment (chosenShelter + коридор + reverse-таблицу). shelterHexes не трогаем.
function _clearCorridor(unit) {
    State.setUnit(unit.id, 'chosenShelter', null);
    State.setUnit(unit.id, 'routPathHexes', null);
    State.setUnit(unit.id, 'routMinCostToShelter', null);
}

async function _handleFire(ctx) {
    const targetHex = pixelToHex(ctx.pos.x, ctx.pos.y);
    const phase = PhaseManager.getPhase();

    // FG объекты + accumulator для weapon RoF (заполняется в loop, читается в _set_firing_Status).
    const firegroupUnits    = State.fireGroup.map(id => State.units[id]);
    const weaponsKeepingRoF = new Set();

    // Отсеиваем стрелков без LoS/hindrance≥6 → validHexes. Затем bins по adjacency → subFGsArray.
    const validHexes  = Rules.filter_hexes_with_Los(State.fireGroupHexesArray, targetHex, State.orchardInSeason);
    const subFGsArray = _form_sub_Fire_Groups(firegroupUnits, validHexes);

    // Визуал LoS-линий и точки блока (даже если атака abort'нется дальше).
    console.log(`[${phase}] valid ${validHexes.length}/${State.fireGroupHexesArray.length} shooter hexes`);
    _drawLOS(State.fireGroupHexesArray, targetHex, validHexes);
    const hit = getLastHit();
    UIState.flashHitPoints(hit ? [hit] : []);

    switch (phase) {
        // ============================================================
        // MPh — DFF: defender стреляет по двинувшимся attacker'ам.
        // ============================================================
        case 'movement': {
            // Свежий список целей — двинувшиеся в hex этой MPh (движущиеся моменту).
            // Функция, а не массив: между sub-FG некоторые цели могут быть eliminated.
            const getTargets = () => _movedTargetsInHex(targetHex);
            if (getTargets().length === 0) return;

            // 3.2.2 (same-hex FG unity) + 3.3.3 (shots ≤ MF цели). Логи внутри функций.
            if (Rules.check_separate_attack(getTargets(), firegroupUnits, State.fired_from_on_target_in_hex)) return;
            if (Rules.check_shots_exceed_mf(getTargets(), firegroupUnits, State.fired_from_on_target_in_hex)) return;
            // SFF/FPF preconditions на всей FG — нарушение одного → отмена всей атаки.
            if (!Rules.checkSFFValid(firegroupUnits, targetHex, State.units, State.orchardInSeason)) return;
            if (!Rules.checkFPFValid(firegroupUnits, targetHex)) return;

            for (const subFG of subFGsArray) {
                const targets = getTargets();
                if (targets.length === 0) break;

                console.log(`[${phase}] sub-FG units=${subFG.map(u=>u.id).join(',')}`);
                const result = Rules.fireAttack(subFG, targetHex, targets, State.units, State.orchardInSeason);
                if (result === null) continue;

                for (const id of result.weaponsKeepingRoF) weaponsKeepingRoF.add(id);
                await _apply_changes_for_targets(result.changes);
                // MPh-специфика: история "из hex X стреляли по цели Y" + residualFP counter.
                _recordFiredFrom(subFG, targets);
                _set_residualFP_in_hex(targetHex, result);
            }
            break;
        }

        // ============================================================
        // PFPh — Prep Fire: attacker стреляет по стоящим defender'ам.
        // ============================================================
        case 'prepFire': {
            const getTargets = () => _defenderInfantryInHex(targetHex);
            if (getTargets().length === 0) return;

            // Никаких SFF/FPF/illegal_targets — цель не двигается, эти правила неприменимы.
            for (const subFG of subFGsArray) {
                const targets = getTargets();
                if (targets.length === 0) break;

                console.log(`[${phase}] sub-FG units=${subFG.map(u=>u.id).join(',')}`);
                const result = Rules.fireAttack(subFG, targetHex, targets, State.units, State.orchardInSeason);
                if (result === null) continue;

                for (const id of result.weaponsKeepingRoF) weaponsKeepingRoF.add(id);
                await _apply_changes_for_targets(result.changes);
            }
            break;
        }

        // ============================================================
        // AFPh — Advancing Fire: attacker стреляет с половинной FP.
        // Ограничения (в rules.checkIfAddingToFireGroupIsValid):
        //   — юнит, стрелявший в PFPh (prepFired) — не может.
        //   — юнит, уже стрелявший в AFPh (advFired) — не может.
        //   — MMG/HMG если possessor двигался в MPh — не может.
        // ============================================================
        case 'advancingFire': {
            const getTargets = () => _defenderInfantryInHex(targetHex);
            if (getTargets().length === 0) return;

            for (const subFG of subFGsArray) {
                const targets = getTargets();
                if (targets.length === 0) break;

                console.log(`[${phase}] sub-FG units=${subFG.map(u=>u.id).join(',')}`);
                const result = Rules.fireAttack(subFG, targetHex, targets, State.units, State.orchardInSeason);
                if (result === null) continue;

                for (const id of result.weaponsKeepingRoF) weaponsKeepingRoF.add(id);
                await _apply_changes_for_targets(result.changes);
            }
            break;
        }

        // ============================================================
        // DFPh — Final Fire: defender стреляет по стоящим attacker'ам.
        // ============================================================
        case 'defensiveFire': {
            const getTargets = () => _attackerInfantryInHex(targetHex);
            if (getTargets().length === 0) return;

            // FirstFire → только adjacent/same. Нарушение любого юнита → отмена всей атаки.
            // FinalFire уже отсечён на addToFireGroup (rules.checkIfAddingToFireGroupIsValid).
            if (!Rules.checkDFPhFinalFireValid(firegroupUnits, targetHex)) return;

            for (const subFG of subFGsArray) {
                const targets = getTargets();
                if (targets.length === 0) break;

                console.log(`[${phase}] sub-FG units=${subFG.map(u=>u.id).join(',')}`);
                const result = Rules.fireAttack(subFG, targetHex, targets, State.units, State.orchardInSeason);
                if (result === null) continue;

                for (const id of result.weaponsKeepingRoF) weaponsKeepingRoF.add(id);
                await _apply_changes_for_targets(result.changes);
            }
            break;
        }

        default: return;   // Fire не поддерживается в этой фазе
    }

    // Пост-обработка: firingStatus / prepFired маркеры по phase-логике.
    _set_firing_Status(phase, firegroupUnits, weaponsKeepingRoF);

    // Финальный cleanup FG: снять рамку inFireGroup и очистить массив.
    State.fireGroup.forEach(id => State.setUnit(id, 'inFireGroup', false));
    State.fireGroup = [];
    State.fireGroupHexesArray = [];
}

// Разбивает FG на sub-FG по LoS + adjacency компонентам. validHexes — уже вычисленный
// список shooter hex'ов, прошедших фильтр (LoS OK + hindrance < 6).
function _form_sub_Fire_Groups(firegroupUnits, validHexes) {
    return Rules.array_of_adjacent_Hexes_arrays(validHexes)
        .map(hexesArr => firegroupUnits.filter(u => Rules.hexInList(u.hex, hexesArr)));
}

// Обновляет residual FP в target hex'e (правило 3.3.5): больший счётчик заменяет меньший.
function _set_residualFP_in_hex(targetHex, result) {
    const hexKey = `${targetHex.col},${targetHex.row}`;
    if ((result.residualFP ?? 0) > (State.residualFP[hexKey] ?? 0)) {
        State.residualFP[hexKey] = result.residualFP;
        UIState.setResidualFP(targetHex, result.residualFP);
        console.log(`[residual] ${hexKey} → ${result.residualFP}`);
    }
}

// Финализация firingStatus + phase-specific marker'ов после огня.
function _set_firing_Status(phase, firegroupUnits, weaponsKeepingRoF) {
    if (phase === 'movement') {
        // MPh: ' ' → FirstFire → FinalFire
        firegroupUnits.forEach(u => {
            if (weaponsKeepingRoF.has(u.id)) return;
            if (u.firingStatus === undefined) return;
            if (u.firingStatus === 'FirstFire')      State.setUnit(u.id, 'firingStatus', 'FinalFire');
            else if (u.firingStatus === ' ')         State.setUnit(u.id, 'firingStatus', 'FirstFire');
        });
    } else if (phase === 'defensiveFire') {
        // DFPh: любой стрелявший → FinalFire
        firegroupUnits.forEach(u => {
            if (weaponsKeepingRoF.has(u.id)) return;
            if (u.firingStatus === undefined) return;
            State.setUnit(u.id, 'firingStatus', 'FinalFire');
        });
    } else if (phase === 'prepFire') {
        // PFPh: prepFired + снять CX
        firegroupUnits.forEach(u => {
            State.setUnit(u.id, 'prepFired', true);
            if (u.category !== 'carried') State.setUnit(u.id, 'exhausted', false);
        });
    } else if (phase === 'advancingFire') {
        // AFPh: advFired (маркер "уже стрелял в этой AFPh").
        firegroupUnits.forEach(u => {
            State.setUnit(u.id, 'advFired', true);
        });
    }
}

// Все defender-пехотинцы в указанном hex'e (цели для prep-fire).
function _defenderInfantryInHex(targetHex) {
    return Object.values(State.units).filter(u =>
        u.category === 'infantry' &&
        u.side === 'defender' &&
        u.hex && isSameHex(u.hex, targetHex)
    );
}

// Все attacker-пехотинцы в указанном hex'e (цели для Final Fire в DFPh).
function _attackerInfantryInHex(targetHex) {
    return Object.values(State.units).filter(u =>
        u.category === 'infantry' &&
        u.side === 'attacker' &&
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

// применить changes от fireAttack: { unitId: 'broken'|'pinned'|'eliminated'|'reduced'|'wounded' }
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
    //   PFPh / AFPh → attacker (prep fire / advancing fire).
    //   MPh  / DFPh → defender (DFF / Final Fire).
    const phase = PhaseManager.getPhase();
    const firingSide = (phase === 'prepFire' || phase === 'advancingFire') ? 'attacker' : 'defender';

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