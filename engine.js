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
        let shelters = Rules.pickNearestShelters(hexToHexesCostsMap, uid, State.units);   // обычный nearest — как было

        const nearestKEUDist = Math.min(...keuUnits.map(k => hexDistance(u.hex, k.hex)));  // расстояние до ближайшего KEU (в гексах)

        if (shelters.length && !shelters.some(s => hexDistance(u.hex, s) > nearestKEUDist)) {   // если ни один nearest не дальше чем KEU
            const further = Rules.pickNearestShelters(hexToHexesCostsMap, uid, State.units, u.hex, nearestKEUDist);   // ищем следующий MF-tier строго дальше KEU
            shelters = [...shelters, ...further];   // добавляем к nearest
        }

        // Кэшируем на юните.
        State.setUnit(uid, 'hexToHexesCostsMap', hexToHexesCostsMap);
        State.setUnit(uid, 'shelterHexes',       shelters);
        _clearCorridor(u);
        State.setUnit(uid, 'routComputed',       true);

        console.log(`[RtPh] selected ${uid}, MF=6, KEU=[${keuIDs.join(',')}], shelters=${shelters.length}`);

        UIState.addButton('EndRout',  { x: 20, y: 100, label: 'EndRout' });    // единственный способ завершить рут
        UIState.addButton('LowCrawl', { x: 20, y: 140, label: 'LowCrawl' });   // доступна пока не сделан обычный ход
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

    // async — только чтобы дождаться sleep(300) в _handleInterdiction перед показом
    // результата interdiction'а (анимация мува = Konva tween 0.3с, чтобы не "рвать" юнит).
    RoutMove: async (ctx) => {
        const unit = State.units[State.routingUnit];
        if (unit.pinned) return;   // pinned не раутится, только EndRout

        const targetHex = pixelToHex(ctx.pos.x, ctx.pos.y);
        if (!isLegalRoutStep(unit, targetHex)) return;

        const isWoodsRoad = Rules._hasWoodsRoad(targetHex);
        if (unit.mf < Rules.checkCost(targetHex, unit.hex, isWoodsRoad ? 'forest' : null)) return;

        _applyRoutMove(unit, targetHex, isWoodsRoad);
        _updateRoutKEU(unit);

        if (!unit.usedLowCrawl && _isOpenGround(unit.hex)) {
            if (await _handleInterdiction(unit)) return;
        }

        if (_checkReachedShelter(unit, targetHex)) return;

        _recomputeCorridor(unit);
        _redrawRoutOverlay(unit);
    },

    EscortWithLeader: (ctx) => {
        const leaderId = ctx.unitId;
        const routerId = State.routingUnit;
        const current = State.units[leaderId].escortingRouter;
        if (current === routerId) {
            State.setUnit(leaderId, 'escortingRouter', null);
            console.log(`[RtPh] leader ${leaderId} escort cancelled`);
        } else {
            State.setUnit(leaderId, 'escortingRouter', routerId);
            console.log(`[RtPh] leader ${leaderId} escorts ${routerId}`);
        }
    },

    ArmLowCrawl: () => {
        State.pendingLowCrawl = true;
        UIState.removeButton('LowCrawl');
        console.log('[LowCrawl] armed — click a destination hex (1 hex, all MF, no interdiction)');
    },

    EndRout: async () => {
        const unit = State.units[State.routingUnit];
        if (!unit) return;

        // Eliminate: остался adjacent к unbroken enemy.
        const adjacentEnemy = _adjacentUnbrokenEnemy(unit);
        if (adjacentEnemy) {
            console.log(`[RtPh] ${unit.id} eliminated: ends adjacent to unbroken ${adjacentEnemy.id}`);
            await _eliminateWithKIA(unit.id);
            _finalizeRoutState();
            return;
        }
        // Eliminate: обязан был раутиться, но не двинулся ни разу.
        if (unit.mustRout) {
            console.log(`[RtPh] ${unit.id} eliminated: failed to rout (never moved)`);
            await _eliminateWithKIA(unit.id);
            _finalizeRoutState();
            return;
        }
        console.log(`[RtPh] ${unit.id} rout ended (safe)`);
        _finalizeRout(unit);
    },

    SelectCCHex: (ctx) => {
        const hex = pixelToHex(ctx.pos.x, ctx.pos.y);
        if (!State.ccHexes.some(h => isSameHex(h, hex))) return;
        // Уже Melee-hex (разрешён в этой CCPh) → повторный клик игнорируем.
        const alreadyMelee = Object.values(State.units).some(u =>
            u.category === 'infantry' && isSameHex(u.hex, hex) && u.inMelee
        );
        if (alreadyMelee) return;
        State.currentCCHex = hex;
        State.ccSelectedIds = [];
        State.ccAttackerAttackers = [];
        State.ccAttackerDefenders = [];
        State.ccAttackerList = [];
        State.ccDefenderAttackers = [];
        State.ccDefenderDefenders = [];
        State.ccDefenderList = [];
        State.ccDefenderDeclaring = false;
        const units = Object.values(State.units).filter(u =>
            u.category === 'infantry' && isSameHex(u.hex, hex)
        );
        UIState.showCCPanel(units);
        UIState.addButton('ConfirmCCAttack', { x: 20, y: 100, label: 'ConfirmCCAttack' });
        UIState.addButton('StartDefenderCC', { x: 20, y: 140, label: 'StartDefenderCC' });
        State.ambushSide = null;
        State.ccAmbushRound = null;
        // Ambush eligible: woods/building hex, и никто из юнитов не в Melee (Melee = reinforcing, не ambush).
        const anyInMelee = Object.values(State.units).some(u =>
            u.category === 'infantry' && isSameHex(u.hex, hex) && u.inMelee
        );
        if (Rules.isAmbushEligibleHex(hex) && !anyInMelee) {
            UIState.addButton('RollAmbush', { x: 20, y: 220, label: 'RollAmbush' });
        }
        console.log(`[CCPh] selected hex (${hex.col},${hex.row}), units=${units.length}`);
    },

    RollAmbush: () => {
        State.ambushSide = Rules.rollAmbush(State.currentCCHex, State.units);
        console.log(`[Ambush] result: ${State.ambushSide ?? 'none'}`);
        UIState.removeButton('RollAmbush');
        if (!State.ambushSide) return;   // нет успеха → обычный флоу
        // Ambush-режим: убираем StartDefenderCC (раунды сам переключит ResolveCC).
        UIState.removeButton('StartDefenderCC');
        State.ccAmbushRound = 'round 1';
        State.ccDefenderDeclaring = (State.ambushSide === 'defender');
        State.ccSelectedIds = [];
        UIState.addButton('ResolveCC', { x: 20, y: 180, label: 'ResolveCC' });
        console.log(`[Ambush] ${State.ambushSide} declares first`);
    },

    CCToggleUnit: (ctx) => {
        const uid = ctx.unitId;
        if (State.ccSelectedIds.includes(uid)) return;   // уже был выбран
        const u = State.units[uid];
        switch (State.ccDefenderDeclaring) {
            case false:   // AttackerDeclaring
                if (u.side === 'attacker') State.ccAttackerAttackers.push(uid);
                else                       State.ccAttackerDefenders.push(uid);
                break;
            case true:    // DefenderDeclaring
                if (u.side === 'defender') State.ccDefenderAttackers.push(uid);
                else                       State.ccDefenderDefenders.push(uid);
                break;
        }
        State.ccSelectedIds.push(uid);
        State.setUnit(uid, 'ccSelected', true);
        UIState.setCCPanelSelect(_allCurrentSelected());
    },

    ConfirmCCAttack: () => {
        const confirmed = State.ccDefenderDeclaring
            ? _confirmAttackFromPools(State.ccDefenderAttackers, State.ccDefenderDefenders, State.ccDefenderList)
            : _confirmAttackFromPools(State.ccAttackerAttackers, State.ccAttackerDefenders, State.ccAttackerList);
        if (!confirmed) return;

        for (const uid of [...confirmed.attackers, ...confirmed.targets]) {
            State.setUnit(uid, 'ccSelected', false);
        }
        UIState.setCCPanelSelect([]);
        console.log('[CCPh] atk:', State.ccAttackerList.map(a => `[${a.attackers}]→[${a.targets}]`).join(' | '),
                    '| def:', State.ccDefenderList.map(a => `[${a.attackers}]→[${a.targets}]`).join(' | '));
    },

    StartDefenderCC: () => {
        State.ccDefenderDeclaring = true;
        State.ccSelectedIds = [];   // новая declare-фаза → новое tracking
        UIState.removeButton('StartDefenderCC');
        UIState.addButton('ResolveCC', { x: 20, y: 180, label: 'ResolveCC' });
        console.log('[CCPh] defender declares');
    },

    ResolveCC: async () => {
        if (State.ccAmbushRound) await _resolveAmbushRound();
        else                     await _result_of_CC_in_hex();
    },

    SelectForAdvance: (ctx) => {
        let uid = ctx.unitId;
        let u = State.units[uid];
        // Клик на weapon → берём его possessor'а.
        if (u.category === 'carried' && u.possessorId) { uid = u.possessorId; u = State.units[uid]; }
        if (u.category !== 'infantry') return;   // только Infantry
        if (u.broken || u.pinned) return;         // только Good Order unpinned

        // Toggle
        if (State.advanceSelected === uid) {
            State.advanceSelected = null;
            State.setUnit(uid, 'selectedForAdvance', false);
            return;
        }
        if (State.advanceSelected) State.setUnit(State.advanceSelected, 'selectedForAdvance', false);
        State.advanceSelected = uid;
        State.setUnit(uid, 'selectedForAdvance', true);
        console.log(`[APh] selected ${uid}`);
    },

    Advance: (ctx) => {
        const uid = State.advanceSelected;
        if (!uid) return;
        const unit = State.units[uid];
        const targetHex = pixelToHex(ctx.pos.x, ctx.pos.y);
        if (!isAdjacent(unit.hex, targetHex)) return;

        const isWoodsRoad = Rules._hasWoodsRoad(targetHex);
        const cost = Rules.checkCost(targetHex, unit.hex, isWoodsRoad ? 'dirtRoad' : null);   // Woods-Road автоматически как road (1 MF)
        const effectiveMF = unit.mf - Rules._portageExcess(unit, State.units, [uid]);          // MF за вычетом portage excess

        if (cost > effectiveMF) { console.log(`[APh] ${uid}: cost ${cost} > mf ${effectiveMF}`); return; }
        if (cost === effectiveMF && unit.exhausted) {
            console.log(`[APh] ${uid}: CX не может advance в hex стоящий все MF`);
            return;
        }
        if (cost === effectiveMF) {
            State.setUnit(uid, 'exhausted', true);   // cost === mf → становимся CX
            console.log(`[APh] ${uid} становится CX`);
        }

        State.setUnit(uid, 'hex', targetHex);
        // Possessed weapons едут с possessor'ом.
        Object.values(State.units).forEach(w => {
            if (w.category === 'carried' && w.possessorId === uid) {
                State.setUnit(w.id, 'hex', targetHex);
            }
        });
        State.setUnit(uid, 'selectedForAdvance', false);
        State.advanceSelected = null;
        console.log(`[APh] ${uid} advanced to (${targetHex.col},${targetHex.row})`);
        _markCCHexIfEnemyPresent(unit, targetHex);
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
        // Вход в CCPh — просто перерисовать список CC-хексов (собран Advance handler'ом).
        if (p === 'closeCombat') {
            UIState.setCCHexes(State.ccHexes ?? []);
            console.log(`[CCPh] ${(State.ccHexes ?? []).length} CC хексов`);
        }
        // Выход из CCPh — очистить.
        if (prevPhase === 'closeCombat') {
            for (const u of Object.values(State.units)) {
                if (u.ccSelected) State.setUnit(u.id, 'ccSelected', false);
            }
            for (const u of Object.values(State.units)) {
                if (u.ccSelected) State.setUnit(u.id, 'ccSelected', false);
            }
            State.ccHexes = [];
            State.currentCCHex = null;
            State.ccSelectedIds = [];
            State.ccAttackerAttackers = [];
            State.ccAttackerDefenders = [];
            State.ccAttackerList = [];
            State.ccDefenderAttackers = [];
            State.ccDefenderDefenders = [];
            State.ccDefenderList = [];
            State.ccDefenderDeclaring = false;
            State.ambushSide = null;
            State.ccAmbushRound = null;
            UIState.setCCHexes([]);
            UIState.hideCCPanel();
            UIState.removeButton('ConfirmCCAttack');
            UIState.removeButton('StartDefenderCC');
            UIState.removeButton('RollAmbush');
            UIState.removeButton('ResolveCC');
        }

        // Вход в APh: сбросить MF для attacker Good Order Infantry (фаза даёт свежий MF).
        if (p === 'advance') {
            for (const u of Object.values(State.units)) {
                if (u.category !== 'infantry') continue;
                if (u.side !== 'attacker') continue;
                if (u.broken) continue;
                let mf = u.baseMF;
                if (u.wounded && u.type === 'leader') mf = Math.min(mf, 3);
                State.setUnit(u.id, 'mf', mf);
            }
            console.log('[APh] MF reset for attacker Good Order infantry');
        }

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
                if (u.escortingRouter)       State.setUnit(u.id, 'escortingRouter', null);
            }
            State.routingUnit = null;
            State.pendingLowCrawl = false;
            UIState.setRoutLegalHexes([]);
            UIState.setRoutShelters([]);
            UIState.setRoutPathHexes([]);
            UIState.removeButton('EndRout');
            UIState.removeButton('LowCrawl');
            console.log('[RtPh end] cleared all rout state');
        }

        // Выход из APh — сбросить selection.
        if (prevPhase === 'advance') {
            for (const u of Object.values(State.units)) {
                if (u.selectedForAdvance) State.setUnit(u.id, 'selectedForAdvance', false);
            }
            State.advanceSelected = null;
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
function _isOpenGround(hex) {
    return terrainAt(hex.col, hex.row).length === 0;
}

function _allCurrentSelected() {
    return State.ccDefenderDeclaring
        ? [...State.ccDefenderAttackers, ...State.ccDefenderDefenders]
        : [...State.ccAttackerAttackers, ...State.ccAttackerDefenders];
}

// Фиксирует одну CC-атаку: копирует attackers/targets в list, сбрасывает исходные пулы.
// Возвращает подтверждённый объект (или null если пулы пусты).
// FP юнита для CC: leader = 1, иначе firepower.
function _ccUnitFP(u) {
    return u.type === 'leader' ? 1 : (u.firepower || 0);
}

// Считает эффекты атак из list на их цели. Возвращает {uid: 'kia' | 'reduce'}.
// side — сторона выполняющая атаки ('attacker'|'defender'), для ambush DRM.
function _calc_effect_for_targets_CC(list, side) {
    const result = {};
    for (const group of list) {
        const atkFP = group.attackers.reduce((s, id) => s + _ccUnitFP(State.units[id]), 0);
        const defFP = group.targets.reduce((s, id) => s + _ccUnitFP(State.units[id]), 0);

        // Leader DRM применяется только если в группе есть MMC (не solo-leader).
        // Если лидеров несколько — берётся лучший (самый низкий leadershipModifier).
        const hasMMC = group.attackers.some(id => State.units[id].type !== 'leader');
        const leaders = group.attackers.map(id => State.units[id]).filter(u => u.type === 'leader');
        let drm = (leaders.length && hasMMC)
            ? Math.min(...leaders.map(l => l.leadershipModifier ?? 0))
            : 0;
        // Ambush DRM: ambusher −1 на свои атаки, ambushed +1 на свои атаки.
        if (State.ambushSide === side)                          drm -= 1;
        else if (State.ambushSide && State.ambushSide !== side) drm += 1;

        const col     = Rules.ccOddsColumn(atkFP, defFP);
        const killNum = Rules.ccKillNumber(col);
        const dr      = Rules.roll2d6();
        const finalDR = dr + drm;
        const eff     = finalDR < killNum ? 'kia' : finalDR === killNum ? 'reduce' : 'miss';
        console.log(`[CC] [${group.attackers}]→[${group.targets}]: FP ${atkFP}:${defFP} = ${col} (kill ${killNum}), DR=${dr}${drm ? `${drm>0?'+':''}${drm}` : ''}=${finalDR} → ${eff}`);

        switch (eff) {
            case 'kia':
                for (const uid of group.targets) result[uid] = 'kia';
                break;
            case 'reduce': {
                const uid = group.targets[Math.floor(Math.random() * group.targets.length)];
                result[uid] = 'reduce';
                break;
            }
            case 'miss':   /* nothing */   break;
        }
    }
    return result;
}

// Применяет эффекты {uid: 'kia'|'reduce'} — eliminate или replace.
async function _apply_effect_CC(effects) {
    for (const [uid, eff] of Object.entries(effects)) {
        if (eff === 'kia') {
            await _eliminateWithKIA(uid);
        } else if (eff === 'reduce') {
            const u = State.units[uid];
            if (u?.halfSquad) _replace_unit(uid, u.halfSquad, uid);
            else await _eliminateWithKIA(uid);
        }
    }
}

// Резолвит CC в currentCCHex: считает эффекты обоих сторон, потом применяет simultaneous.
async function _result_of_CC_in_hex() {
    const effOnDefenders = _calc_effect_for_targets_CC(State.ccAttackerList, 'attacker');
    const effOnAttackers = _calc_effect_for_targets_CC(State.ccDefenderList, 'defender');
    await _apply_effect_CC(effOnDefenders);
    await _apply_effect_CC(effOnAttackers);
    _finalizeCCHex();
}

// Резолвит один раунд ambush-СС.
async function _resolveAmbushRound() {
    const hex = State.currentCCHex;   // текущий CC-гекс — понадобится для фильтра выживших и перерисовки панели

    // Определить, чья сторона сейчас declaring, и взять её список подтверждённых атак.
    const declaringSide = State.ccDefenderDeclaring ? 'defender' : 'attacker';
    const list = declaringSide === 'attacker' ? State.ccAttackerList : State.ccDefenderList;

    // Посчитать эффект её атак (с ambush DRM внутри) и применить — часть целей гибнет или reduce'ится.
    const eff = _calc_effect_for_targets_CC(list, declaringSide);
    await _apply_effect_CC(eff);

    if (State.ccAmbushRound === 'round 1') {
        // Первый раунд закончился. Проверяем, нужен ли второй.
        // Берём "другую сторону" (не-ambusher) и её выживших пехотинцев в hex'е.
        const otherSide = State.ambushSide === 'attacker' ? 'defender' : 'attacker';
        const survivors = Object.values(State.units).filter(u =>
            u.category === 'infantry' && isSameHex(u.hex, hex) && u.side === otherSide
        );
        // Если у противника ambusher'а никого не осталось — CC закончен.
        if (!survivors.length) { _finalizeCCHex(); return; }

        // Переходим в раунд 2. Флаг ccDefenderDeclaring выставляем так, чтобы CCToggleUnit
        // роутил клики ambushed'а как нападающих, а ambusher'а — как цели. Список выбранных сбрасываем.
        State.ccAmbushRound = 'round 2';
        State.ccDefenderDeclaring = (otherSide === 'defender');
        State.ccSelectedIds = [];

        // Перерисовать CC-панель — мёртвых там уже не будет (State.units их удалил в apply).
        UIState.showCCPanel(Object.values(State.units).filter(u =>
            u.category === 'infantry' && isSameHex(u.hex, hex)
        ));
        console.log(`[Ambush] round 2: ${otherSide} declares`);
    } else {
        // Уже был раунд 2 → CC полностью разрешён.
        _finalizeCCHex();
    }
}

// Убирает currentCCHex из списка (или помечает Melee), гасит панель + кнопки.
function _finalizeCCHex() {
    const hex = State.currentCCHex;
    if (Rules.check_if_both_sides_still_in_hex(hex, State.units)) {
        for (const u of Object.values(State.units)) {
            if (u.category === 'infantry' && isSameHex(u.hex, hex)) {
                State.setUnit(u.id, 'inMelee', true);
            }
        }
        console.log(`[CC] hex (${hex.col},${hex.row}) → Melee`);
    } else {
        State.ccHexes = State.ccHexes.filter(h => !isSameHex(h, hex)); // удаляем гекс из СС гексов
        UIState.setCCHexes(State.ccHexes);
        console.log(`[CC] hex (${hex.col},${hex.row}) resolved`);
    }
    State.currentCCHex = null;
    State.ambushSide = null;
    State.ccAmbushRound = null;
    UIState.hideCCPanel();
    UIState.removeButton('ConfirmCCAttack');
    UIState.removeButton('StartDefenderCC');
    UIState.removeButton('ResolveCC');
    UIState.removeButton('RollAmbush');
}

function _confirmAttackFromPools(attackers, targets, list) {
    if (!attackers.length || !targets.length) return null;
    const confirmed = { attackers: [...attackers], targets: [...targets] };
    list.push(confirmed);
    attackers.length = 0;
    targets.length = 0;
    return confirmed;
}

// Помечает хекс как CC-hex если там есть enemy infantry (после Advance-хода).
function _markCCHexIfEnemyPresent(unit, targetHex) {
    const hasEnemyInfantry = Object.values(State.units).some(o =>
        o.side !== unit.side && o.category === 'infantry' && isSameHex(o.hex, targetHex)
    );
    if (!hasEnemyInfantry) return;

    State.ccHexes ??= [];
    if (State.ccHexes.some(h => isSameHex(h, targetHex))) return;

    State.ccHexes.push({ col: targetHex.col, row: targetHex.row });
    // Не рисуем сейчас — подсветка только в CCPh (см. NextPhase 'closeCombat' entry).
    console.log(`[APh→CC] ${unit.id} advanced into enemy hex — CC pending at (${targetHex.col},${targetHex.row})`);
}

// Определяет "shooter hex" (для weapons = hex possessor'а) и "disabled" (не может стрелять).
// Возвращает null если entity вообще не может быть interdictor'ом (weapon на земле).
function _getShooterInfo(u) {
    if (u.category === 'carried') {
        if (!u.possessorId) return null;
        const p = State.units[u.possessorId];
        return { hex: p.hex, disabled: p.broken || p.pinned || p.exhausted || u.broken };
    }
    return { hex: u.hex, disabled: u.broken || u.pinned || u.exhausted };
}

function _findInterdictor(unit) {
    for (const interdictor of Object.values(State.units)) {
        if (interdictor.side === unit.side) continue;
        const info = _getShooterInfo(interdictor);
        if (!info || info.disabled) continue;
        if (interdictor.type === 'leader') continue;                            // solo leader — skip (пока)
        if (!interdictor.firepower || interdictor.firepower <= 0) continue;
        if (hexDistance(info.hex, unit.hex) > interdictor.range) continue;      // normal range
        if (!Rules.checkLOS(info.hex, unit.hex, State.orchardInSeason)) continue;
        if (Rules.checkHindrance([info.hex], unit.hex) > 0) continue;           // unhindered LoS
        return interdictor;
    }
    return null;
}

// Прогоняет Interdiction NMC. Возвращает true если раут этого юнита закончен
// (eliminated или pinned — ждём EndRout от игрока для pin, авто-завершаем для elim).
async function _handleInterdiction(unit) {
    const interdictor = _findInterdictor(unit);
    if (!interdictor) return false;

    await sleep(300);   // ждём завершения Konva-tween'а мува (0.3s) — иначе юнит "рвётся" при elim

    const escort = Object.values(State.units).find(u => u.escortingRouter === unit.id);
    console.log(`[Interdiction] ${unit.id} by ${interdictor.id}${escort ? ` (escorted by ${escort.id})` : ''}`);
    const outcome = Rules.interdictionAttack(unit, escort);
    if (outcome === 'ok') return false;

    if (outcome === 'eliminated') {
        await _eliminateWithKIA(unit.id);
        if (escort) await _eliminateWithKIA(escort.id);   // leader разделяет судьбу — eliminated
        _finalizeRoutState();
        return true;
    }
    if (outcome === 'pinned') {
        State.setUnit(unit.id, 'pinned', true);
        _clearCorridor(unit);
        _clearRoutOverlay();
        console.log(`[Interdiction] ${unit.id} pinned → rout stops, click EndRout`);
        return true;
    }
    if (outcome === 'reduced') _replace_unit(unit.id, unit.halfSquad, unit.id);   // squad → HS, раут продолжается
    if (outcome === 'wounded') State.setUnit(unit.id, 'wounded', true);           // leader wound (мутации уже в _woundLeader)
    return false;
}

// Легален ли клик как rout-move: adjacent + KEU-правило + (если коридор) в коридоре.
function isLegalRoutStep(unit, targetHex) {
    if (!isAdjacent(unit.hex, targetHex)) return false;
    const keuUnits = unit.keuIDsList.map(id => State.units[id]);
    if (!Rules.check_KEU_range_and_adjacency(unit.hex, targetHex, keuUnits)) return false;
    if (unit.routPathHexes && !unit.routPathHexes.has(`${targetHex.col},${targetHex.row}`)) return false;
    return true;
}

// State mutations. MF-check уже пройден в handler'е. path не обновляем — в RtPh не используется.
// Ветвление обычный rout / LowCrawl: LC тратит весь MF, ставит usedLowCrawl (skip interdiction).
function _applyRoutMove(unit, targetHex, isWoodsRoad) {
    if (State.pendingLowCrawl) {
        State.setUnit(unit.id, 'mf', 0);
        State.setUnit(unit.id, 'usedLowCrawl', true);
        console.log(`[LowCrawl] ${unit.id} → (${targetHex.col},${targetHex.row}), MF exhausted`);
    } else {
        const cost = Rules.checkCost(targetHex, unit.hex, isWoodsRoad ? 'forest' : null);
        const newMF = unit.mf - cost;
        State.setUnit(unit.id, 'mf', newMF);
        UIState.removeButton('LowCrawl');   // после обычного хода LC больше недоступен
        console.log(`[RtPh] ${unit.id} → (${targetHex.col},${targetHex.row}), MF=${newMF}`);
    }
    State.setUnit(unit.id, 'hex', targetHex);
    if (isWoodsRoad) State.setUnit(unit.id, 'usedWoodsRoad', true);
    State.setUnit(unit.id, 'mustRout', false);   // обязанность двинуться выполнена

    // Escort leader (если есть) — движется вместе с router'ом.
    const escort = Object.values(State.units).find(u => u.escortingRouter === unit.id);
    if (escort) {
        State.setUnit(escort.id, 'hex', targetHex);
        console.log(`[RtPh] escort ${escort.id} → (${targetHex.col},${targetHex.row})`);
    }
}

// Обновляет KEU-список (новые observers). Мутирует юнит если изменилось.
function _updateRoutKEU(unit) {
    const oldKEUIDs = unit.keuIDsList;
    const newKEUIDs = _updateKEUList(unit, oldKEUIDs);
    if (newKEUIDs.length === oldKEUIDs.length) return;
    State.setUnit(unit.id, 'keuIDsList', newKEUIDs);
    console.log(`[RtPh] ${unit.id} new KEU: [${newKEUIDs.filter(id => !oldKEUIDs.includes(id)).join(',')}]`);
}

// Если дошли до chosenShelter — safe finalize (не adjacent) или сброс destination.
// Возвращает true если раут завершён (ранний return из handler'а).
function _checkReachedShelter(unit, targetHex) {
    if (!unit.chosenShelter || !isSameHex(unit.chosenShelter, targetHex)) return false;
    if (!_adjacentUnbrokenEnemy(unit)) { _finalizeRout(unit); return true; }
    _clearCorridor(unit);
    console.log(`[RtPh] ${unit.id} at shelter but adjacent to enemy → find new destination`);
    return false;
}

// Пересчитывает коридор от текущей позиции с текущим MF.
// Держит старый chosenShelter если ещё достижим, иначе показывает новые nearest.
function _recomputeCorridor(unit) {
    const keuUnits = unit.keuIDsList.map(id => State.units[id]);
    const newCosts = Rules.calc_hex_to_every_hex_dist_map(unit.hex, keuUnits, unit.mf);
    State.setUnit(unit.id, 'hexToHexesCostsMap', newCosts);

    if (unit.chosenShelter && newCosts.has(`${unit.chosenShelter.col},${unit.chosenShelter.row}`)) {
        _buildCorridor(unit, unit.chosenShelter, keuUnits, unit.mf, newCosts);
    } else {
        let newShelters = Rules.pickNearestShelters(newCosts, unit.id, State.units);   // обычный nearest — как было
        const nearestKEUDist = Math.min(...keuUnits.map(k => hexDistance(unit.hex, k.hex)));   // расстояние до ближайшего KEU (в гексах)
        if (newShelters.length && !newShelters.some(s => hexDistance(unit.hex, s) > nearestKEUDist)) {   // если ни один nearest не дальше чем KEU
            const further = Rules.pickNearestShelters(newCosts, unit.id, State.units, unit.hex, nearestKEUDist);   // ищем следующий MF-tier строго дальше KEU
            newShelters = [...newShelters, ...further];   // добавляем к nearest
        }
        State.setUnit(unit.id, 'shelterHexes', newShelters);
        _clearCorridor(unit);
        console.log(`[RtPh] ${unit.id} destination lost → ${newShelters.length ? `pick new (${newShelters.length})` : 'free-rout'}`);
    }
}

// Гасит все rout overlays (shelters/corridor/legal-adjacent).
function _clearRoutOverlay() {
    UIState.setRoutShelters([]);
    UIState.setRoutPathHexes([]);
    UIState.setRoutLegalHexes([]);
}

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
    if (unit.mf === 0) {   // ничего двинуть нельзя — гасим все hex-подсветки
        _clearRoutOverlay();
        return;
    }
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
        if (costFromUnit === 0) return;   // сам хекс юнита — не destination
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

// Возвращает первого смежного unbroken enemy (или null).
function _adjacentUnbrokenEnemy(unit) {
    return Object.values(State.units).find(other =>
        other.side !== unit.side &&
        other.category !== 'carried' &&
        !other.broken &&
        isAdjacent(unit.hex, other.hex)
    ) || null;
}

// Показывает KIA-визуал на юните, ждёт немного, затем удаляет.
async function _eliminateWithKIA(id) {
    State.setUnit(id, 'kia', true);
    await sleep(700);
    _remove_unit(id);
}

// Финализация раута для одного юнита (safe): очистка полей + overlay + кнопки.
function _finalizeRout(unit) {
    State.setUnit(unit.id, 'inRouting', false);
    State.setUnit(unit.id, 'mustRout', false);
    State.setUnit(unit.id, 'hexToHexesCostsMap', null);
    _clearCorridor(unit);
    State.setUnit(unit.id, 'routComputed', false);
    // Сбросить escort у любого leader'а, который сопровождал этого router'а.
    const escort = Object.values(State.units).find(u => u.escortingRouter === unit.id);
    if (escort) State.setUnit(escort.id, 'escortingRouter', null);
    _finalizeRoutState();
}

// Общая очистка глобального rout-state + overlay + кнопки.
function _finalizeRoutState() {
    _clearRoutOverlay();
    UIState.removeButton('EndRout');
    UIState.removeButton('LowCrawl');
    State.pendingLowCrawl = false;
    State.routingUnit = null;
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
        broken:                 old.broken,
        desperationMorale:      old.desperationMorale,
        pinned:                 old.pinned,
        exhausted:              old.exhausted,
        mf:                     old.mf,
        // RtPh state — HS продолжает раут без потери контекста.
        mustRout:               old.mustRout,
        inRouting:              old.inRouting,
        keuIDsList:             old.keuIDsList,
        shelterHexes:           old.shelterHexes,
        chosenShelter:          old.chosenShelter,
        hexToHexesCostsMap:     old.hexToHexesCostsMap,
        routPathHexes:          old.routPathHexes,
        routMinCostToShelter:   old.routMinCostToShelter,
        routComputed:           old.routComputed,
        usedLowCrawl:           old.usedLowCrawl,
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
            State.setUnit(newId, key, val);
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
        // eliminated — юнит уничтожается физически (KIA-визуал + пауза + remove)
        if (state === 'eliminated') {
            await _eliminateWithKIA(id);
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