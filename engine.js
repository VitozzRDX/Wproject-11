import { State } from './state.js';
import { Rules } from './rules.js';
import { PhaseManager } from './phase_manager.js';
import { pixelToHex, hexToPixel, hexLabel, hexDistance, isSameHex, isAdjacent, calcNearestHexes, bfsHexes, dijkstraHexes, reconstructPath, COL_COUNT, ROW_COUNT } from './hexUtils.js';
import { terrainAt } from './cards.js';
import { UIState } from './uiState.js';
import { spawn_unit, TEMPLATES, UNIT_IMAGE_SIZE } from './unitloading.js';
import { getLastHit } from './terrainLOS.js';
import { flipReplaceUnit, raiseToTop, shakeNode } from './renderer.js';
import { recalculateHex, recalculateHexInstant } from './positioning.js';
import { save, load } from './saveLoad.js';
import { initSetupSide, applyDiceRoll, placeFromPool, returnToPool, instantUnitMoveFromHexToHex, refreshSetupPanel } from './setupPhase.js';

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

    // Hover по hex'у в огневой фазе — пересчитать и показать FP всей FG по этой цели.
    HoverFireTarget: (ctx) => {
        const hex   = ctx.hex;
        const phase = PhaseManager.getPhase();
        const firePhases = ['prepFire', 'advancingFire', 'defensiveFire', 'movement'];
        if (!firePhases.includes(phase) || !State.fireGroup.length) {
            UIState.clearHoverFP();
            return;
        }
        let targets = [];
        if (phase === 'movement')                                   targets = _movedTargetsInHex(hex);
        else if (phase === 'prepFire' || phase === 'advancingFire') targets = _defenderInfantryInHex(hex);
        else if (phase === 'defensiveFire')                         targets = _attackerInfantryInHex(hex);
        if (!targets.length) { UIState.clearHoverFP(); return; }
        const units = State.fireGroup.map(id => State.units[id]);
        const fp = units.reduce((s, u) => s + Rules.calcFirepower(u, hex), 0);
        UIState.setHoverFP(hex, fp);
    },

    // Dbl-клик по инфантри в MPh — добавляем всех инфантри своей стороны этого гекса в MG.
    // Оружие не трогаем — оно переедет вместе с possessor'ом.
    dblClickAddingToMovingGroup: (unit) => {
        if (unit.side !== 'attacker') return;   // MPh — только attacker
        for (const u of _ownUnitsInHex(unit.hex, 'attacker', ['infantry'])) {
            _addToMovementGroup(u.id);
        }
    },

    // Dbl-клик в фазу огня — добавляем всех юнитов своей стороны (инфантри + оружие) в FG.
    dblClickAddingToFireGroup: (unit) => {
        const phase = PhaseManager.getPhase();
        const firingSide = (phase === 'prepFire' || phase === 'advancingFire') ? 'attacker' : 'defender';
        if (unit.side !== firingSide) return;
        for (const u of _ownUnitsInHex(unit.hex, firingSide, ['infantry', 'carried'])) {
            _addToFireGroup(u.id);
        }
    },

    Save: () => save(),
    Load: async () => { await load(); },

    RollDice: () => {
        // MVP: простой d6.
        const roll = Math.floor(Math.random() * 6) + 1;
        console.log(`[Setup] ${State.setupSide} dice=${roll}`);
        applyDiceRoll(roll);
    },

    // Setup: клик по own-юниту (в пуле или на карте) — одиночный выбор.
    SetupToggleSelect: (ctx) => {
        const newId = ctx.unitId;
        if (State.setupSelectedUnits.includes(newId)) return;   // тот же — ничего
        _clearSetupSelection();
        State.setupSelectedUnits = [newId];
        State.setUnit(newId, 'selectedForSetup', true);
        refreshSetupBoundsHighlight();
    },

    // Setup: dblclick в пуле — выбрать до 3 юнитов того же templateId. На карте не работает.
    // Оружие (carried) пропускаем — оно по одному, батч не нужен.
    dblClickSetupSelect: (unit) => {
        if (!unit.inSetupPool) return;
        if (unit.category === 'carried') return;
        const tpl = unit.templateId;
        const picks = State.idsInSetupPool
            .filter(id => State.units[id].templateId === tpl)
            .slice(0, 3);
        _clearSetupSelection();
        State.setupSelectedUnits = picks;
        for (const id of picks) State.setUnit(id, 'selectedForSetup', true);
        refreshSetupBoundsHighlight();
        console.log(`[Setup] dbl-select ${picks.length} × ${tpl}`);
    },

    // Setup: клик по гексу при выбранных юнитах. Пул → поставить всех; карта (1 юнит) → перенести.
    // Проверяем занят ли гекс противником и влезет ли по правилам стакинга (макс 3 отряда).
    SetupPlaceOrMoveOnHex: (ctx) => {
        const hex = pixelToHex(ctx.pos.x, ctx.pos.y);
        const uids = State.setupSelectedUnits;
        if (!_canPlaceAtHex(uids, hex)) return;   // отказ — выделение сохраняется
        for (const uid of uids) {
            const u = State.units[uid];
            if (u.inSetupPool) placeFromPool(uid, hex);
            else               instantUnitMoveFromHexToHex(uid, hex);
        }
        console.log(`[Setup] placed/moved ${uids.length} unit(s) → (${hex.col},${hex.row})`);
        _clearSetupSelection();
    },

    // Setup: прикрепить выбранное оружие к инфантри (работает только для одного выбранного).
    SetupAttachWeapon: (ctx) => {
        if (State.setupSelectedUnits.length !== 1) return;
        const weaponId = State.setupSelectedUnits[0];
        const infantryId = ctx.unitId;
        const weapon = State.units[weaponId];
        const infantry = State.units[infantryId];
        weapon.possessorId = infantryId;
        _clearSetupSelection();
        if (weapon.inSetupPool) {
            placeFromPool(weaponId, infantry.hex);
        } else if (!isSameHex(weapon.hex, infantry.hex)) {
            instantUnitMoveFromHexToHex(weaponId, infantry.hex);
        }
        console.log(`[Setup] attached ${weaponId} to ${infantryId}`);
    },

    // Setup: клик по фону панели + выбранный юнит на карте → вернуть в пул.
    // Dblclick в карту не работает, поэтому выбор на карте всегда 1 юнит.
    SetupReturnToPool: () => {
        const uid = State.setupSelectedUnits[0];
        _clearSetupSelection();
        returnToPool(uid);
        console.log(`[Setup] returned ${uid} to pool`);
    },

    EndSetupSide: () => {
        const first = State.currentScenario.setup.whoSetsUpFirst;
        const current = State.setupSide;
        UIState.removeButton('EndSetupSide');
        if (State.setupSelectedUnits.length > 0) _clearSetupSelection();
        if (current === first) {
            // Текущая сторона — та, что ходила первой. Переключаемся на вторую.
            const nextSide = first === 'defender' ? 'attacker' : 'defender';
            initSetupSide(nextSide);
        } else {
            // Отработали обе стороны — выходим в rally.
            State.setupSide = null;
            State.idsInSetupPool = [];
            UIState.hideSetupPanel();
            UIState.addButton('NextPhase', { x: 10, y: 10, label: 'NextPhase' });
            UIState.setTurnText(`TURN 1 / ${Math.ceil(State.currentScenario.gameLength / 2)}`);
            PhaseManager.setPhase('rally');
            console.log('[Setup] done → rally');
        }
    },

    MOVE: (ctx) => {

        const targetHex = pixelToHex(ctx.pos.x, ctx.pos.y);

            // Ждём выбор UseWoods/UseRoad — любой клик по карте игнорируем до нажатия кнопки.
    if (State.pendingMove) return;
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
        // Активная панель целей — Esc в первую очередь гасит её.
        if (State.lastGroupInteracted === 'targets') {
            State.lastGroupInteracted = null;
            UIState.hideTargetPanel();
            return;
        }
        if (State.fireGroup.length > 0) {
            for (const unitId of State.fireGroup) {
                State.setUnit(unitId, 'inFireGroup', false);
            }
            State.fireGroup = [];
            State.fireGroupHexesArray = [];
            _refreshGroupPanel();   // FG очищена — панель покажет MG (если есть) или скроется
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
            _refreshGroupPanel();   // MG очищена — панель скроется (или покажет FG, если успела появиться)
            return;
        }
        // APh: сбросить выбранного для advance.
        if (State.advanceSelected) {
            State.setUnit(State.advanceSelected, 'selectedForAdvance', false);
            State.advanceSelected = null;
            return;
        }
        // Setup: сбросить выбранных (из пула или с карты).
        if (State.setupSelectedUnits.length > 0) {
            _clearSetupSelection();
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
            await _killUnit(unit.id, { cause: 'rout', hex: unit.hex });
            _finalizeRoutState();
            return;
        }
        // Eliminate: обязан был раутиться, но не двинулся ни разу.
        if (unit.mustRout) {
            console.log(`[RtPh] ${unit.id} eliminated: failed to rout (never moved)`);
            await _killUnit(unit.id, { cause: 'rout', hex: unit.hex });
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

    EndAttackerRecovery: () => {
        // Attacker закончил → defender. Если defender'у нечего рекаверить — auto-skip через _enterRecoveryForCurrentSide.
        State.rallySide = 'defender';
        _clearRecoveryState();
        UIState.fadeButton('EndAttackerRecovery');
        _enterRecoveryForCurrentSide();
    },

    EndDefenderRecovery: () => {
        // Обе стороны прошли Recovery → переход в Repair-подфазу, снова с attacker'а.
        _clearAllRecoveryHighlights();
        _clearRecoveryState();
        State.rallySubPhase = 'repair';
        State.rallySide = 'attacker';
        UIState.fadeButton('EndDefenderRecovery');
        _enterRepairForCurrentSide();
    },

    EndAttackerRepair: () => {
        // Attacker закончил → defender. Если нечего ремонтировать — auto-skip через _enterRepairForCurrentSide.
        State.rallySide = 'defender';
        _clearRepairState();
        _clearAllRecoveryHighlights();   // снять подсветку старых eligible-weapons attacker'а
        UIState.fadeButton('EndAttackerRepair');
        _enterRepairForCurrentSide();
    },

    EndDefenderRepair: () => {
        // Обе стороны прошли Repair → переход в Transfer-подфазу.
        _clearAllRecoveryHighlights();
        _clearRepairState();
        State.rallySubPhase = 'transfer';
        State.rallySide = 'attacker';
        UIState.fadeButton('EndDefenderRepair');
        UIState.addButton('EndAttackerTransfer', { x: 10, y: 200, label: 'EndAttackerTransfer' });
        console.log('[RPh] attacker transfer starts');
    },

    SelectRepairHex: (ctx) => {
        // Клик валиден только если в hex есть подсвеченное (eligible) broken оружие.
        const hex = pixelToHex(ctx.pos.x, ctx.pos.y);
        const hasEligible = Object.values(State.units).some(weapon =>
            weapon.category === 'carried' && weapon.recoveryHighlight && isSameHex(weapon.hex, hex)
        );
        if (!hasEligible) return;
        State.repairHex = hex;
        UIState.addButton('RepairAttempt', { x: 310, y: 150, label: 'RepairAttempt' });
        console.log(`[Repair] hex (${hex.col},${hex.row}) selected`);
    },

    RepairAttempt: async () => {
        // Ищем сломанные орудия в выбранном гексе — кандидаты на попытку ремонта.
        const brokenWeapons = Object.values(State.units).filter(weapon =>
            weapon.category === 'carried' && weapon.broken && isSameHex(weapon.hex, State.repairHex)
        );
        for (const weapon of brokenWeapons) {
            const possessor = State.units[weapon.possessorId];
            // Possessor своей стороны, Good Order, не израсходовал action, нация совпадает.
            if (possessor.side !== State.rallySide) continue;
            if (possessor.broken || possessor.pinned) continue;
            if (possessor.repairAttempted) continue;
            if (weapon.nation !== possessor.nation) continue;

            State.setUnit(possessor.id, 'repairAttempted', true);
            const { result, dr } = Rules.rollRepairAttempt(weapon);
            if (result === 'repaired') {
                State.setUnit(weapon.id, 'broken', false);
                console.log(`[Repair] ${possessor.id} repaired ${weapon.id} (dr=${dr})`);
            } else if (result === 'eliminated') {
                console.log(`[Repair] ${weapon.id} permanently eliminated (dr=6)`);
                await _killUnit(weapon.id, { cause: 'repair', hex: weapon.hex });
            } else {
                console.log(`[Repair] ${possessor.id} failed to repair ${weapon.id} (dr=${dr})`);
            }
        }
        _clearRepairState();
        _refreshRepairHighlights();
        _autoEndRepairIfNoneLeft();
    },

    SelectRecoveryHex: (ctx) => {
        // Клик валиден только если в гексе есть хотя бы одно подсвеченное оружие.
        const hex = pixelToHex(ctx.pos.x, ctx.pos.y);
        const hasEligible = Object.values(State.units).some(w =>
            w.category === 'carried' && w.recoveryHighlight && isSameHex(w.hex, hex)
        );
        if (!hasEligible) return;
        State.recoveryHex = hex;
        UIState.addButton('RecoveryAttempt', { x: 310, y: 100, label: 'RecoveryAttempt' });
        console.log(`[Recovery] hex (${hex.col},${hex.row}) selected`);
    },

    RecoveryAttempt: () => {
        // Целевое оружие — первое unpossessed carried в выбранном гексе.
        const weapon = Object.values(State.units).find(w =>
            w.category === 'carried' && !w.possessorId && isSameHex(w.hex, State.recoveryHex)
        );
        if (!weapon) { _clearRecoveryState(); return; }

        // Перебор всех eligible пехотинцев в гексе. Каждый расходует свой RPh-action; первый успех останавливает.
        const candidates = Object.values(State.units).filter(u =>
            u.category === 'infantry' &&
            u.side === State.rallySide &&
            !u.broken && !u.pinned &&
            !u.recoveryAttempted &&
            isSameHex(u.hex, State.recoveryHex)
        );
        let recovered = false;
        for (const u of candidates) {
            State.setUnit(u.id, 'recoveryAttempted', true);
            const { success } = Rules.rollRecoverAttempt(u);
            if (success) {
                State.setUnit(weapon.id, 'possessorId', u.id);
                recalculateHex(weapon.hex);
                console.log(`[Recovery] ${u.id} recovered ${weapon.id}`);
                recovered = true;
                break;
            }
        }
        if (!recovered) console.log(`[Recovery] all units failed in hex (${State.recoveryHex.col},${State.recoveryHex.row})`);
        _clearRecoveryState();
        _refreshRecoveryHighlights();
        _autoEndRecoveryIfNoneLeft();
    },

    EndAttackerTransfer: () => {
        // Attacker закончил Transfer → defender.
        State.rallySide = 'defender';
        State.transferHex = null;
        _clearTransferSelection();
        UIState.hideTransferPanel();
        UIState.fadeButton('EndAttackerTransfer');
        UIState.addButton('EndDefenderTransfer', { x: 160, y: 200, label: 'EndDefenderTransfer' });
        console.log('[RPh] defender transfer starts');
    },

    EndDefenderTransfer: () => {
        // Обе стороны прошли Transfer → переход в Self-Rally подфазу.
        State.transferHex = null;
        _clearTransferSelection();
        UIState.hideTransferPanel();
        State.rallySubPhase = 'selfRally';
        State.rallySide = 'attacker';
        UIState.fadeButton('EndDefenderTransfer');
        _enterSelfRallyForCurrentSide();
    },

    EndAttackerSelfRally: () => {
        // Attacker закончил → defender. Если defender'у некого раллить — auto-skip.
        State.rallySide = 'defender';
        _clearSelfRallyState();
        _clearAllSelfRallyHighlights();
        UIState.fadeButton('EndAttackerSelfRally');
        _enterSelfRallyForCurrentSide();
    },

    EndDefenderSelfRally: () => {
        // Обе стороны прошли Self-Rally → переход в Unit-Rally подфазу.
        _clearAllSelfRallyHighlights();
        _clearSelfRallyState();
        UIState.fadeButton('EndDefenderSelfRally');
        State.rallySubPhase = 'unitRally';
        State.rallySide = 'attacker';
        _enterUnitRallyForCurrentSide();
    },

    SelectSelfRallyUnit: (ctx) => {
        // Снимаем прежний выбор (если был), помечаем новый.
        if (State.selfRallyUnit) State.setUnit(State.selfRallyUnit, 'selfRallySelected', false);
        State.selfRallyUnit = ctx.unitId;
        State.setUnit(ctx.unitId, 'selfRallySelected', true);
        UIState.addButton('SelfRallyAttempt', { x: 310, y: 250, label: 'SelfRallyAttempt' });
    },

    EndAttackerUnitRally: () => {
        State.rallySide = 'defender';
        _clearUnitRallyState();
        _clearAllUnitRallyHighlights();
        UIState.fadeButton('EndAttackerUnitRally');
        _enterUnitRallyForCurrentSide();
    },

    EndDefenderUnitRally: () => {
        // Обе стороны прошли Unit-Rally → переход в DM-removal подфазу (step h правил).
        _clearAllUnitRallyHighlights();
        _clearUnitRallyState();
        UIState.fadeButton('EndDefenderUnitRally');
        _enterDMRemoval();
    },

    ToggleKeepDM: (ctx) => {
        // Клик по подсвеченному DM-юниту: снимаем подсветку и помечаем "оставить DM".
        State.setUnit(ctx.unitId, 'dmRemovalHighlight', false);
        State.setUnit(ctx.unitId, 'DMkept', true);
        console.log(`[RPh DM] ${ctx.unitId} opt-keep DM`);
    },

    SelectUnitRallyUnit: (ctx) => {
        if (State.unitRallyUnit) State.setUnit(State.unitRallyUnit, 'unitRallySelected', false);
        State.unitRallyUnit = ctx.unitId;
        State.setUnit(ctx.unitId, 'unitRallySelected', true);
        UIState.addButton('UnitRallyAttempt', { x: 310, y: 300, label: 'UnitRallyAttempt' });
    },

    UnitRallyAttempt: async () => {
        const u = State.units[State.unitRallyUnit];
        // Good Order лидеры в том же hex (эквивалент single-hex FG для calcLeadershipDRM).
        const leadersInHex = Object.values(State.units).filter(l =>
            l.type === 'leader' && l.side === u.side &&
            !l.broken && !l.pinned && isSameHex(l.hex, u.hex)
        );
        const leaderDRM = Rules.calcLeadershipDRM([u, ...leadersInHex]);
        const { pass, originalTwelve } = Rules.rollRallyAttempt(u, { leaderDRM, kind: 'UnitRally' });
        State.setUnit(u.id, 'unitRallyAttempted', true);

        if (pass) {
            State.setUnit(u.id, 'broken', false);
            if (u.desperationMorale) State.setUnit(u.id, 'desperationMorale', false);
        } else if (originalTwelve) {
            console.log(`[UnitRally] ${u.id} original 12 → CR`);
            if (u.halfSquad) _replace_unit(u.id, u.halfSquad, u.id);
            else             await _killUnit(u.id, { cause: 'rally-cr', hex: u.hex });
        }
        _clearUnitRallyState();
        _refreshUnitRallyHighlights();
    },

    SelfRallyAttempt: async () => {
        const u = State.units[State.selfRallyUnit];
        const { pass, originalTwelve } = Rules.rollRallyAttempt(u, { selfPenalty: 1, kind: 'SelfRally' });
        State.setUnit(u.id, 'selfRallyAttempted', true);
        // Если это attacker's extra MMC (не selfRally) — пометить use бонусного слота.
        if (!u.selfRally && State.rallySide === 'attacker') State.attackerExtraMMCUsed = true;

        if (pass) {
            State.setUnit(u.id, 'broken', false);
            if (u.desperationMorale) State.setUnit(u.id, 'desperationMorale', false);
        } else if (originalTwelve) {
            // Casualty Reduction: squad → HS, HS/leader → eliminated.
            console.log(`[SelfRally] ${u.id} original 12 → CR`);
            if (u.halfSquad) _replace_unit(u.id, u.halfSquad, u.id);
            else             await _killUnit(u.id, { cause: 'rally-cr', hex: u.hex });
        }
        _clearSelfRallyState();
        _refreshSelfRallyHighlights();
        _autoEndSelfRallyIfNoneLeft();
    },

    SelectTransferHex: (ctx) => {
        const hex = pixelToHex(ctx.pos.x, ctx.pos.y);
        const unitsInClickedHex = Object.values(State.units).filter(u => isSameHex(u.hex, hex));
        if (!unitsInClickedHex.some(u => u.category === 'infantry' && u.side === State.rallySide)) return;
        _clearTransferSelection();
        State.transferHex = hex;
        UIState.showTransferPanel(unitsInClickedHex);
        console.log(`[RPh] transfer panel opened at (${hex.col},${hex.row}), items=${unitsInClickedHex.length}`);
    },

    TransferPanelClick: (ctx) => {
        const u = State.units[ctx.unitId];
        if (u.category === 'carried') {
            if (State.idTransferSelectedUnit) State.setUnit(State.idTransferSelectedUnit, 'transferSelected', false);
            State.idTransferSelectedUnit = u.id;
            State.setUnit(u.id, 'transferSelected', true);
        } else if (u.category === 'infantry') {
            if (u.side !== State.rallySide) return;
            if (u.broken || u.pinned) return;
            if (State.idUnitToGetWeapon) State.setUnit(State.idUnitToGetWeapon, 'transferSelected', false);
            State.idUnitToGetWeapon = u.id;
            State.setUnit(u.id, 'transferSelected', true);
        }
        UIState.setTransferPanelSelect([State.idTransferSelectedUnit, State.idUnitToGetWeapon].filter(Boolean));
        _applyTransferIfReady();
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

        if (!Rules.checkOverstack(targetHex, [uid], State.units)) {
            console.log(`[APh] ${uid}: overstack в (${targetHex.col},${targetHex.row}) — отказ`);
            return;
        }

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
        _updateHexControl(targetHex);
        _eliminateIfOutOfBounds(uid);
    },

    NextPhase: () => {
        const prevPhase = PhaseManager.getPhase();
        const p = PhaseManager.next();
        UIState.rotateImage('turnphase', -45);   // 1/8 оборота против часовой (одна грань)
        console.log(`[phase] → ${p}`);

        // Начало MPh (A8.2): CX снимается с attacker-юнитов, но переносим его в флаг-память,
        // чтобы в этой MPh заблокировать DT тем, кто был CX в прошлой MPh.
        if (p === 'movement') _applyMPhStartCXCleanup();

        // Конец RPh: полный cleanup — recovery + transfer state, все кнопки RPh, action-флаги юнитов.
        if (prevPhase === 'rally') {
            // DM-Removal финализация (step h): убираем DM у всех, кроме adjacent-врагу и явно оставленных игроком.
            for (const u of Object.values(State.units)) {
                if (!u.desperationMorale) continue;
                const adjacentEnemy = Object.values(State.units).some(e =>
                    e.category === 'infantry' && e.side !== u.side && isAdjacent(u.hex, e.hex)
                );
                if (adjacentEnemy) continue;
                if (u.DMkept) continue;
                State.setUnit(u.id, 'desperationMorale', false);
                console.log(`[RPh DM] ${u.id} DM removed`);
            }
            for (const u of Object.values(State.units)) {
                if (u.dmRemovalHighlight) State.setUnit(u.id, 'dmRemovalHighlight', false);
                if (u.DMkept)             State.setUnit(u.id, 'DMkept', false);
            }

            State.rallySide = null;
            State.rallySubPhase = null;
            State.transferHex = null;
            _clearTransferSelection();
            _clearAllRecoveryHighlights();
            _clearRecoveryState();
            // Сбросить action-per-RPh флаги у всех юнитов, чтобы в следующей RPh можно было снова пытаться.
            for (const u of Object.values(State.units)) {
                if (u.recoveryAttempted) State.setUnit(u.id, 'recoveryAttempted', false);
                if (u.repairAttempted)   State.setUnit(u.id, 'repairAttempted', false);
            }
            _clearRepairState();
            UIState.removeButton('EndAttackerTransfer');
            UIState.removeButton('EndDefenderTransfer');
            UIState.removeButton('EndAttackerRecovery');
            UIState.removeButton('EndDefenderRecovery');
            UIState.removeButton('EndAttackerRepair');
            UIState.removeButton('EndDefenderRepair');
            UIState.removeButton('EndAttackerSelfRally');
            UIState.removeButton('EndDefenderSelfRally');
            UIState.removeButton('SelfRallyAttempt');
            UIState.hideTransferPanel();
            // SelfRally cleanup
            for (const u of Object.values(State.units)) {
                if (u.selfRallyAttempted) State.setUnit(u.id, 'selfRallyAttempted', false);
                if (u.selfRallyHighlight) State.setUnit(u.id, 'selfRallyHighlight', false);
                if (u.selfRallySelected)  State.setUnit(u.id, 'selfRallySelected', false);
            }
            State.attackerExtraMMCUsed = false;
            State.selfRallyUnit = null;
            // UnitRally cleanup
            for (const u of Object.values(State.units)) {
                if (u.unitRallyAttempted) State.setUnit(u.id, 'unitRallyAttempted', false);
                if (u.unitRallyHighlight) State.setUnit(u.id, 'unitRallyHighlight', false);
                if (u.unitRallySelected)  State.setUnit(u.id, 'unitRallySelected', false);
            }
            State.unitRallyUnit = null;
            UIState.removeButton('EndAttackerUnitRally');
            UIState.removeButton('EndDefenderUnitRally');
            UIState.removeButton('UnitRallyAttempt');
        }

        // ВАЖНО: rally entry перенесён вниз (после CCPh side-swap) — иначе refresh считает по старым сторонам.

        // Конец MPh: сбросить hasStartedMoving, movementCompleted и wasExhaustedLastTurn (все скоуп-MPh).
        if (prevPhase === 'movement') {
            for (const u of Object.values(State.units)) {
                if (u.hasStartedMoving)      State.setUnit(u.id, 'hasStartedMoving', false);
                if (u.movementCompleted)     State.setUnit(u.id, 'movementCompleted', false);
                if (u.wasExhaustedLastTurn)  State.setUnit(u.id, 'wasExhaustedLastTurn', false);
                if (u.doubleTime)            State.setUnit(u.id, 'doubleTime', false);
            }
        }

        // Конец MPh: убрать все Residual FP counters с карты.
        if (prevPhase === 'movement') {
            for (const key of Object.keys(State.residualFP)) {
                const [col, row] = key.split(',').map(Number);
                UIState.setResidualFP({ col, row }, 0);
            }
            State.residualFP = {};
            console.log('[MPh end] cleared Residual FP counters');

            // Очистить movementGroup / movementStackHex — иначе правило MOVE (у него нет phase-check)
            // срабатывает в следующих фазах при любом клике по гексу/кнопке.
            for (const id of State.movementGroup) _setInMovementGroup(id, false);
            State.movementGroup = [];
            State.movementStackHex = null;
            State.moved_movement_group = null;
            State.original_group = [];
            State.splitted_group = [];
            State.mfspent = false;
            _refreshGroupPanel();   // MG очищена при смене фазы — панель должна скрыться
            UIState.hideTargetPanel();   // target-панель (если осталась от огня в MPh) — скрыть
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
        // Плюс сбросить movedThisMPh у оружий (нужен был для AFPh MMG/HMG-check).
        if (prevPhase === 'advancingFire') {
            for (const u of Object.values(State.units)) {
                if (u.prepFired) State.setUnit(u.id, 'prepFired', false);
                if (u.advFired)  State.setUnit(u.id, 'advFired', false);
                if (u.category === 'carried' && u.movedThisMPh) State.setUnit(u.id, 'movedThisMPh', false);
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
            // 3.9 Turn Record: attacker ↔ defender.
            for (const u of Object.values(State.units)) {
                State.setUnit(u.id, 'side', u.side === 'attacker' ? 'defender' : 'attacker');
            }
            console.log('[Turn] sides swapped: attacker ↔ defender');
            // Переключить значок стороны по нации нового attacker'а.
            const AXIS = new Set(['german', 'italian', 'japanese']);
            const attackerUnit = Object.values(State.units).find(u => u.side === 'attacker' && u.category === 'infantry');
            UIState.changeBadge(AXIS.has(attackerUnit?.nation));
            // 3.9 Turn Record: +1 player-turn, обновить UI, проверить END.
            State.playerTurn++;
            const fullTurn = Math.ceil(State.playerTurn / 2);
            const totalFullTurns = Math.ceil(State.currentScenario.gameLength / 2);
            UIState.setTurnText(`TURN ${fullTurn} / ${totalFullTurns}`);
            _checkWinConditions();
            if (State.playerTurn > State.currentScenario.gameLength) {
                console.log('[Scenario] game over');
            }
        }

        // Вход в RPh: старт Recovery-подфазы у attacker'а. Подсветить eligible weapons на карте.
        // Должен идти ПОСЛЕ CCPh side-swap, иначе refresh посчитает по старым сторонам.
        if (p === 'rally') {
            State.rallySide = 'attacker';
            State.rallySubPhase = 'recovery';
            _enterRecoveryForCurrentSide();
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

                        // Пополнить лидер-бонус и дорожный бонус из шаблона — новый ход = свежий budget.
                const tpl = TEMPLATES[u.templateId];
                if (tpl) {
                    State.setUnit(u.id, 'leaderBonus', tpl.leaderBonus || 0);
                    State.setUnit(u.id, 'roadBonus',   tpl.roadBonus   || 0);
                }
                if (u.usedWoodsRoad) State.setUnit(u.id, 'usedWoodsRoad', false);

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
                if (u.assaultMovement)    State.setUnit(u.id, 'assaultMovement', false);
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
        _refreshGroupPanel();   // mf вырос на +2 — обновить число в панели
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
// Setup: проверка возможности поставить/перенести группу юнитов в hex.
// Запрет — пехота противника в гексе, выход за setup-зону, или переполнение стопки.
function _canPlaceAtHex(uids, hex) {
    const hasEnemyInfantry = Object.values(State.units).some(u =>
        u.hex && isSameHex(u.hex, hex) && u.category === 'infantry' && u.side !== State.setupSide
    );
    if (hasEnemyInfantry) {
        console.log(`[Setup] нельзя — в (${hex.col},${hex.row}) юниты противника`);
        return false;
    }
    // Setup-зона: каждый из выбранных должен быть легальным в целевом hex по bounds.
    for (const uid of uids) {
        const u = State.units[uid];
        if (!_isHexInSetupZone(u.nation, hex)) {
            console.log(`[Setup] (${hex.col},${hex.row}) вне зоны расстановки для ${u.id} (${u.nation})`);
            return false;
        }
    }
    // checkOverstack сам правильно считает: mg-члены едут в target как 1 отряд каждый,
    // non-mg засчитываются только если уже стоят в target.
    if (!Rules.checkOverstack(hex, uids, State.units)) {
        console.log(`[Setup] overstack в (${hex.col},${hex.row}) — макс 3 отряда / 4 лидера`);
        return false;
    }
    return true;
}

// Разрешён ли hex для юнита данной нации по bounds-правилам сцены.
// bounds формат (в сценарии):
//   { all: { col:[minCol,maxCol], row:[minRow,maxRow] } }   — одна зона для всей стороны
//   { byNation: { nation: { col, row } } }                  — разные зоны по нации юнита
// col и row — опциональные; отсутствие поля = нет ограничения по этой оси.
function _isHexInSetupZone(nation, hex) {
    const sideCfg = State.currentScenario.setup.sides[State.setupSide];
    if (!sideCfg.bounds) return true;
    let zone;
    if (sideCfg.bounds.byNation) zone = sideCfg.bounds.byNation[nation];
    else                         zone = sideCfg.bounds.all;
    if (!zone) return false;
    if (zone.col) {
        const [minCol, maxCol] = zone.col;
        if (hex.col < minCol || hex.col > maxCol) return false;
    }
    if (zone.row) {
        const [minRow, maxRow] = zone.row;
        if (hex.row < minRow || hex.row > maxRow) return false;
    }
    return true;
}

// Все hex'ы карты, легальные для юнита данной нации — для подсветки зоны.
function _hexesInSetupZoneForNation(nation) {
    const hexes = [];
    for (let col = 0; col < 2 * COL_COUNT - 1; col++) {
        for (let row = 1; row <= ROW_COUNT + 1; row++) {
            if (_isHexInSetupZone(nation, { col, row })) hexes.push({ col, row });
        }
    }
    return hexes;
}

// Пересчитать подсветку setup-зоны по текущему выделению. Caller гарантирует непустой setupSelectedUnits.
export function refreshSetupBoundsHighlight() {
    const unit = State.units[State.setupSelectedUnits[0]];
    UIState.setSetupBounds(_hexesInSetupZoneForNation(unit.nation));
}

// Снять выделение setup со всех выбранных юнитов + вернуть их на законные позиции.
// Юниты во время выделения «липли» к курсору — после снятия выделения надо вернуть
// пул-юнитов в их места на панели, а карта-юнитов — в их стеки.
function _clearSetupSelection() {
    // Собираем hex'ы на карте для пересчёта стеков + флаг «пересобрать панель».
    const hexesToRestore = new Set();
    let poolTouched = false;
    for (const id of State.setupSelectedUnits) {
        const u = State.units[id];
        if (u.inSetupPool) poolTouched = true;
        else if (u.hex) hexesToRestore.add(`${u.hex.col},${u.hex.row}`);
        State.setUnit(id, 'selectedForSetup', false);   // снять красную рамку
    }

    // Обнуляем состояние выделения.
    State.setupSelectedUnits = [];
    UIState.setSetupBounds([]);   // погасить подсветку setup-зоны

    // Один вызов refreshSetupPanel ставит ВСЕ пул-юниты на их места.
    if (poolTouched) refreshSetupPanel();
    // Для каждого затронутого hex на карте — пересчёт стека без tween.
    for (const key of hexesToRestore) {
        const [col, row] = key.split(',').map(Number);
        recalculateHexInstant({ col, row });
    }
}

const AXIS_NATIONS = new Set(['german', 'italian', 'japanese']);

// Какая сторона у юнита (определяется нацией).
function _unitSide(u) {
    return AXIS_NATIONS.has(u.nation) ? 'axis' : 'allied';
}

// Чистая проверка: hex за границами игровой зоны сценария.
function _isOutOfBounds(hex) {
    const area = State.currentScenario && State.currentScenario.playArea;
    if (!area) return false;
    return hex.col < area.col[0] || hex.col > area.col[1]
        || hex.row < area.row[0] || hex.row > area.row[1];
}

// Ценность юнита в VP. Без привязки к стороне — просто «сколько стоит».
function _calcUnitVP(u) {
    if (u.type === 'squad')  return u.size === 'halfSquad' ? 1 : 2;
    if (u.type === 'leader') {
        const lm = u.leadershipModifier;
        if (lm <= -1)              return 2;
        if (lm === 0 || lm === 1)  return 1;
    }
    return 0;
}

// Начислить очки стороне. В State пишем всегда.
// UI обновляем только если у этой стороны задана цель — её ставит сценарий.
function _grantVP(side, amount) {
    if (!amount) return;
    if (side === 'allied') {
        State.alliedVP = State.alliedVP + amount;
        if (State.alliedVpTarget === null) return;
        UIState.setAlliedVPText(`VP: ${State.alliedVP} / ${State.alliedVpTarget}`);
    } else {
        State.axisVP = State.axisVP + amount;
        if (State.axisVpTarget === null) return;
        UIState.setAxisVPText(`VP: ${State.axisVP} / ${State.axisVpTarget}`);
    }
}

// Правило VP при эллиминации. Сначала спрашиваем сценарий.
// Если сценарий не задал своё правило — работает дефолт: другая сторона получает ценность убитого.
function _vpOnElimination(unit, context) {
    const scen = State.currentScenario;
    const fullTurn = Math.ceil(State.playerTurn / 2);
    if (scen && typeof scen.vpOnElimination === 'function') {
        return scen.vpOnElimination(unit, context, fullTurn, _calcUnitVP);
    }
    const killedSide = _unitSide(unit);
    const vp = _calcUnitVP(unit);
    if (killedSide === 'axis') return { allied: vp, axis: 0 };
    return { allied: 0, axis: vp };
}

// Если юнит оказался в hex за пределами игровой зоны — элиминировать его (с VP по сценарию).
async function _eliminateIfOutOfBounds(unitId) {
    const u = State.units[unitId];
    if (!u || !u.hex) return;
    if (!_isOutOfBounds(u.hex)) return;
    console.log(`[OOB] ${unitId} (${u.hex.col},${u.hex.row}) — eliminated`);
    await _killUnit(unitId, { cause: 'oob', hex: u.hex });
}

// A26 Control: Good Order Infantry MMC в hex'е без enemy → её faction получает контроль.
// Контроль не теряется при уходе — только перехватывается другой стороной тем же путём.
function _updateHexControl(hex) {
    if (!hex) return;
    const inHex = Object.values(State.units).filter(u =>
        u.hex && isSameHex(u.hex, hex) && u.category === 'infantry'
    );
    const factionOf = (u) => AXIS_NATIONS.has(u.nation) ? 'axis' : 'allied';
    const factions = new Set(inHex.map(factionOf));
    if (factions.size > 1) return;   // смешанный hex — контроль не меняется
    const firstGoodOrderSquad = inHex.find(u =>
        u.type === 'squad' && !u.broken && !u.pinned && !u.wounded
    );
    if (!firstGoodOrderSquad) return;
    if (!State.hexControl) State.hexControl = {};   // старые сейвы могут не иметь поля — восстанавливаем
    State.hexControl[`${hex.col}-${hex.row}`] = factionOf(firstGoodOrderSquad);
    _refreshHexControlCounter();
}

// Пересчёт UI-счётчика контроля (hex'ы нужного террейна по сторонам).
function _refreshHexControlCounter() {
    const terrains = State.currentScenario?.winConditions?.autoAtTurn4?.terrain;
    if (!terrains) return;
    let ax = 0, al = 0;
    for (const [key, side] of Object.entries(State.hexControl ?? {})) {
        const [col, row] = key.split('-').map(Number);
        const hexT = terrainAt(col, row);
        if (!terrains.some(t => hexT.includes(t))) continue;
        if (side === 'axis') ax++;
        else if (side === 'allied') al++;
    }
    UIState.setHillControlText(`Hill: Ax ${ax} / Al ${al}`);
}

// Проверка автопобеды Allied в конце TURN 4 за контроль hill/crest.
function _checkWinConditions() {
    const wc = State.currentScenario?.winConditions;
    if (!wc?.autoAtTurn4) return;
    // playerTurn уже увеличен; закончившийся full turn = ceil((playerTurn-1)/2).
    const fullTurnJustEnded = Math.ceil((State.playerTurn - 1) / 2);
    if (fullTurnJustEnded < 4) return;
    const check = wc.autoAtTurn4;
    if (check.type !== 'hexControl') return;
    const terrains = check.terrain;
    let count = 0;
    for (const [key, side] of Object.entries(State.hexControl ?? {})) {
        if (side !== wc.side) continue;
        const [col, row] = key.split('-').map(Number);
        const hexT = terrainAt(col, row);
        if (terrains.some(t => hexT.includes(t))) count++;
    }
    if (count >= check.minCount) {
        console.log(`[Scenario] ${wc.side} WIN — control ${count}/${check.minCount} target hexes`);
    }
}

// Все юниты своей стороны в hex'е нужных категорий (для dblclick-групп).
function _ownUnitsInHex(hex, side, categories) {
    return Object.values(State.units).filter(u =>
        u.hex && isSameHex(u.hex, hex) && u.side === side && categories.includes(u.category)
    );
}

// Начало MPh (A8.2): CX снимается, но юнит, который был CX, не сможет DT в этой MPh —
// запоминаем через флаг wasExhaustedLastTurn. Применяется только к стороне-атакующему
// (это сторона, у которой наступает MPh).
function _applyMPhStartCXCleanup() {
    for (const u of Object.values(State.units)) {
        if (u.side !== 'attacker') continue;
        if (u.exhausted) {
            State.setUnit(u.id, 'wasExhaustedLastTurn', true);
            State.setUnit(u.id, 'exhausted', false);
        }
    }
}

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
            const u = State.units[uid];
            await _killUnit(uid, { cause: 'cc', hex: u && u.hex });
        } else if (eff === 'reduce') {
            const u = State.units[uid];
            if (u && u.halfSquad) _replace_unit(uid, u.halfSquad, uid);
            else                  await _killUnit(uid, { cause: 'cc', hex: u && u.hex });
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

// Снимает transferSelected с обоих слотов и обнуляет их.
function _clearTransferSelection() {
    if (State.idTransferSelectedUnit) State.setUnit(State.idTransferSelectedUnit, 'transferSelected', false);
    if (State.idUnitToGetWeapon)      State.setUnit(State.idUnitToGetWeapon, 'transferSelected', false);
    State.idTransferSelectedUnit = null;
    State.idUnitToGetWeapon = null;
}

// Перерисовать transfer-панель для текущего transferHex.
function _refreshTransferPanel() {
    const units = Object.values(State.units).filter(u => isSameHex(u.hex, State.transferHex));
    UIState.showTransferPanel(units);
}

// Если оба слота заполнены — выполнить transfer и очистить.
function _applyTransferIfReady() {
    if (!State.idTransferSelectedUnit || !State.idUnitToGetWeapon) return;
    const w = State.units[State.idTransferSelectedUnit];
    State.setUnit(State.idTransferSelectedUnit, 'possessorId', State.idUnitToGetWeapon);
    recalculateHex(w.hex);   // пересобрать стек (weapon теперь под новым possessor'ом)
    console.log(`[RPh] weapon ${State.idTransferSelectedUnit} → ${State.idUnitToGetWeapon}`);
    _clearTransferSelection();
    _refreshTransferPanel();
}

// Пробегает по всем weapons: подсвечивает те, что unpossessed AND лежат в гексе со своим Good Order
// юнитом (rallySide), который ещё не пытался recovery в этом RPh. Остальные — снимает подсветку.
function _refreshRecoveryHighlights() {
    for (const w of Object.values(State.units)) {
        if (w.category !== 'carried') continue;
        const eligible = !w.possessorId && Object.values(State.units).some(u =>
            u.category === 'infantry' &&
            u.side === State.rallySide &&
            !u.broken && !u.pinned &&
            !u.recoveryAttempted &&
            isSameHex(u.hex, w.hex)
        );
        if (w.recoveryHighlight !== eligible) State.setUnit(w.id, 'recoveryHighlight', eligible);
    }
}

// Если после попытки Recovery не осталось подсвеченных weapon'ов — auto-end подфазы стороны.
function _autoEndRecoveryIfNoneLeft() {
    const hasAny = Object.values(State.units).some(w => w.category === 'carried' && w.recoveryHighlight);
    if (hasAny) return;
    if (State.rallySide === 'attacker') handlers.EndAttackerRecovery();
    else                                 handlers.EndDefenderRecovery();
}

// Вход в Recovery подфазу для текущей стороны: highlight + auto-skip если нечего рекаверить.
function _enterRecoveryForCurrentSide() {
    _refreshRecoveryHighlights();
    // Кнопку рисуем всегда — чтобы при auto-skip она тоже отобразилась (сразу faded).
    const btn = State.rallySide === 'attacker' ? 'EndAttackerRecovery' : 'EndDefenderRecovery';
    const x = State.rallySide === 'attacker' ? 10 : 160;   // attacker под NextPhase, defender под Save
    UIState.addButton(btn, { x, y: 100, label: btn });
    const hasAny = Object.values(State.units).some(w => w.category === 'carried' && w.recoveryHighlight);
    if (!hasAny) {
        console.log(`[RPh] ${State.rallySide} recovery: nothing to recover, auto-skip`);
        if (State.rallySide === 'attacker') handlers.EndAttackerRecovery();
        else                                 handlers.EndDefenderRecovery();
        return;
    }
    console.log(`[RPh] ${State.rallySide} recovery starts`);
}

// Полная очистка recoveryHighlight у всех weapons — при переходе из recovery-подфазы наружу.
function _clearAllRecoveryHighlights() {
    for (const w of Object.values(State.units)) {
        if (w.category === 'carried' && w.recoveryHighlight) State.setUnit(w.id, 'recoveryHighlight', false);
    }
}

// Сброс выбранного recoveryHex и кнопки RecoveryAttempt — промежуточное состояние между попытками.
function _clearRecoveryState() {
    State.recoveryHex = null;
    UIState.removeButton('RecoveryAttempt');
}

// Подсвечиваем broken-оружие, чей possessor Good Order своей стороны, не израсходовал repair-action
// и совпадает по нации. Переиспользуем recoveryHighlight (подфазы Recovery/Repair взаимоисключающие).
function _refreshRepairHighlights() {
    for (const weapon of Object.values(State.units)) {
        if (weapon.category !== 'carried') continue;
        let eligible = false;
        if (weapon.broken && weapon.possessorId) {
            const possessor = State.units[weapon.possessorId];
            eligible = !!possessor
                && possessor.side === State.rallySide
                && !possessor.broken && !possessor.pinned
                && !possessor.repairAttempted
                && weapon.nation === possessor.nation;
        }
        if (weapon.recoveryHighlight !== eligible) State.setUnit(weapon.id, 'recoveryHighlight', eligible);
    }
}

// Сброс выбранного repairHex и кнопки RepairAttempt.
function _clearRepairState() {
    State.repairHex = null;
    UIState.removeButton('RepairAttempt');
}

// Юнит eligible для self-rally: broken, свой, не израсходовал action, selfRally=true
// ИЛИ один non-selfRally squad для attacker (бонусная попытка).
function _isSelfRallyEligible(u) {
    if (u.category !== 'infantry') return false;
    if (!u.broken) return false;
    if (u.side !== State.rallySide) return false;
    if (u.selfRallyAttempted) return false;
    if (u.selfRally) return true;
    if (State.rallySide !== 'attacker') return false;
    if (State.attackerExtraMMCUsed) return false;
    return u.type === 'squad';
}

function _refreshSelfRallyHighlights() {
    for (const u of Object.values(State.units)) {
        if (u.category !== 'infantry') continue;
        const eligible = _isSelfRallyEligible(u);
        if (u.selfRallyHighlight !== eligible) State.setUnit(u.id, 'selfRallyHighlight', eligible);
    }
}

function _clearAllSelfRallyHighlights() {
    for (const u of Object.values(State.units)) {
        if (u.selfRallyHighlight) State.setUnit(u.id, 'selfRallyHighlight', false);
    }
}

function _clearSelfRallyState() {
    // Юнит мог быть удалён через CR (original 12) — проверяем перед setUnit.
    if (State.selfRallyUnit && State.units[State.selfRallyUnit]) {
        State.setUnit(State.selfRallyUnit, 'selfRallySelected', false);
    }
    State.selfRallyUnit = null;
    UIState.removeButton('SelfRallyAttempt');
}

// Юнит eligible для opt-keep DM: имеет DM, не рядом с врагом, не в cover.
function _isDMRemovalCandidate(u) {
    if (!u.desperationMorale) return false;
    if (u.category !== 'infantry') return false;
    const adjacentEnemy = Object.values(State.units).some(e =>
        e.category === 'infantry' && e.side !== u.side && isAdjacent(u.hex, e.hex)
    );
    if (adjacentEnemy) return false;   // adjacent врага → DM остаётся всегда
    const terrain = terrainAt(u.hex.col, u.hex.row);
    if (terrain.includes('forest') || terrain.includes('woodenBuilding') || terrain.includes('stoneBuilding')) return false;
    return true;
}

// Вход в DM-removal подфазу: помечаем всех eligible юнитов, игрок кликами opt-keep'ает, NextPhase финализирует.
function _enterDMRemoval() {
    State.rallySubPhase = 'dmRemoval';
    const candidates = Object.values(State.units).filter(_isDMRemovalCandidate);
    for (const u of candidates) State.setUnit(u.id, 'dmRemovalHighlight', true);
    console.log(`[RPh DM] ${candidates.length} units highlighted — click to keep DM, NextPhase removes rest`);
}

// Если после попытки SelfRally никого не осталось в highlight — автоматом завершаем подфазу стороны.
function _autoEndSelfRallyIfNoneLeft() {
    const hasAny = Object.values(State.units).some(x => x.category === 'infantry' && x.selfRallyHighlight);
    if (hasAny) return;
    if (State.rallySide === 'attacker') handlers.EndAttackerSelfRally();
    else                                 handlers.EndDefenderSelfRally();
}

// Вход в Self-Rally подфазу: highlight + auto-skip если некого раллить.
function _enterSelfRallyForCurrentSide() {
    _refreshSelfRallyHighlights();
    // Кнопку рисуем всегда — чтобы при auto-skip она тоже отобразилась (сразу faded).
    const btn = State.rallySide === 'attacker' ? 'EndAttackerSelfRally' : 'EndDefenderSelfRally';
    const x = State.rallySide === 'attacker' ? 10 : 160;
    UIState.addButton(btn, { x, y: 250, label: btn });
    const hasAny = Object.values(State.units).some(u => u.category === 'infantry' && u.selfRallyHighlight);
    if (!hasAny) {
        console.log(`[RPh] ${State.rallySide} self-rally: nothing to rally, auto-skip`);
        if (State.rallySide === 'attacker') handlers.EndAttackerSelfRally();
        else                                 handlers.EndDefenderSelfRally();
        return;
    }
    console.log(`[RPh] ${State.rallySide} self-rally starts`);
}

// Юнит eligible для unit-rally: broken, свой, не израсходовал action, не-лидер,
// и в его hex есть Good Order лидер той же стороны (кто-то его раллит).
function _isUnitRallyEligible(u) {
    if (u.category !== 'infantry') return false;
    if (!u.broken) return false;
    if (u.side !== State.rallySide) return false;
    if (u.unitRallyAttempted) return false;
    if (u.type === 'leader') return false;
    return Object.values(State.units).some(l =>
        l.type === 'leader' && l.side === State.rallySide &&
        !l.broken && !l.pinned &&
        isSameHex(l.hex, u.hex)
    );
}

function _refreshUnitRallyHighlights() {
    for (const u of Object.values(State.units)) {
        if (u.category !== 'infantry') continue;
        const eligible = _isUnitRallyEligible(u);
        if (u.unitRallyHighlight !== eligible) State.setUnit(u.id, 'unitRallyHighlight', eligible);
    }
}

function _clearAllUnitRallyHighlights() {
    for (const u of Object.values(State.units)) {
        if (u.unitRallyHighlight) State.setUnit(u.id, 'unitRallyHighlight', false);
    }
}

function _clearUnitRallyState() {
    if (State.unitRallyUnit && State.units[State.unitRallyUnit]) {
        State.setUnit(State.unitRallyUnit, 'unitRallySelected', false);
    }
    State.unitRallyUnit = null;
    UIState.removeButton('UnitRallyAttempt');
}

// Вход в Unit-Rally подфазу: highlight + auto-skip если некого раллить.
function _enterUnitRallyForCurrentSide() {
    _refreshUnitRallyHighlights();
    // Кнопку рисуем всегда — чтобы при auto-skip она тоже отобразилась (сразу faded).
    const btn = State.rallySide === 'attacker' ? 'EndAttackerUnitRally' : 'EndDefenderUnitRally';
    const x = State.rallySide === 'attacker' ? 10 : 160;
    UIState.addButton(btn, { x, y: 300, label: btn });
    const hasAny = Object.values(State.units).some(u => u.category === 'infantry' && u.unitRallyHighlight);
    if (!hasAny) {
        console.log(`[RPh] ${State.rallySide} unit-rally: nothing to rally, auto-skip`);
        if (State.rallySide === 'attacker') handlers.EndAttackerUnitRally();
        else                                 handlers.EndDefenderUnitRally();
        return;
    }
    console.log(`[RPh] ${State.rallySide} unit-rally starts`);
}

// Если после попытки Repair не осталось подсвеченных weapon'ов — auto-end подфазы стороны.
function _autoEndRepairIfNoneLeft() {
    const hasAny = Object.values(State.units).some(w => w.category === 'carried' && w.recoveryHighlight);
    if (hasAny) return;
    if (State.rallySide === 'attacker') handlers.EndAttackerRepair();
    else                                 handlers.EndDefenderRepair();
}

// Вход в Repair-подфазу для текущей rallySide: подсвечиваем eligible-weapons.
// Если нечего ремонтировать — автопереход в следующую подфазу через соответствующий End-handler,
// чтобы игрок не нажимал бесполезную кнопку.
function _enterRepairForCurrentSide() {
    _refreshRepairHighlights();
    // Кнопку рисуем всегда — чтобы при auto-skip она тоже отобразилась (сразу faded).
    const btn = State.rallySide === 'attacker' ? 'EndAttackerRepair' : 'EndDefenderRepair';
    const x = State.rallySide === 'attacker' ? 10 : 160;   // attacker под EndAttackerRecovery, defender под EndDefenderRecovery
    UIState.addButton(btn, { x, y: 150, label: btn });
    const hasAnyEligible = Object.values(State.units).some(w =>
        w.category === 'carried' && w.recoveryHighlight
    );
    if (!hasAnyEligible) {
        console.log(`[RPh] ${State.rallySide} repair: nothing to repair, auto-skip`);
        if (State.rallySide === 'attacker') handlers.EndAttackerRepair();
        else                                 handlers.EndDefenderRepair();
        return;
    }
    console.log(`[RPh] ${State.rallySide} repair starts`);
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
        await _killUnit(unit.id, { cause: 'interdiction', hex: unit.hex });
        if (escort) await _killUnit(escort.id, { cause: 'interdiction', hex: escort.hex });   // leader разделяет судьбу
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
    // Out-of-bounds — за границы карты (пример: раут в off-map hex): элиминация.
    if (_isOutOfBounds(targetHex)) {
        _eliminateIfOutOfBounds(unit.id);
        if (escort) _eliminateIfOutOfBounds(escort.id);
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

// Визуальная эллиминация: ставит kia, ждёт анимацию, удаляет из State. VP не трогает.
async function _eliminateWithKIA(id) {
    State.setUnit(id, 'kia', true);
    await sleep(700);
    _remove_unit(id);
}

// Полная эллиминация: сначала VP по сценарному правилу, потом визуал.
// Используется всеми местами, где юнит умирает (fire, rout, CC, OOB, repair-fail и т.д.).
async function _killUnit(id, context) {
    const u = State.units[id];
    if (u) {
        const vp = _vpOnElimination(u, context);
        _grantVP('allied', vp.allied);
        _grantVP('axis',   vp.axis);
    }
    await _eliminateWithKIA(id);
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

    console.log(`[Fire attempt] ${phase} → target (${targetHex.col},${targetHex.row}), fg=[${State.fireGroup.join(',')}]`);

    // FG объекты + accumulator для weapon RoF (заполняется в loop, читается в _set_firing_Status).
    const firegroupUnits    = State.fireGroup.map(id => State.units[id]);
    const weaponsKeepingRoF = new Set();

    // Цели ДО огня — для target-панели (одна строка на цель: before | after).
    const getPhaseTargets = () => {
        if (phase === 'movement')                              return _movedTargetsInHex(targetHex);
        if (phase === 'prepFire' || phase === 'advancingFire') return _defenderInfantryInHex(targetHex);
        if (phase === 'defensiveFire')                         return _attackerInfantryInHex(targetHex);
        return [];
    };
    const initialTargetUids = getPhaseTargets().map(u => u.id);
    const beforeSnap        = _snapshotTargetsBeforeFireEffect(initialTargetUids);

    // Отсеиваем стрелков без LoS/hindrance≥6 → validHexes. Затем bins по adjacency → subFGsArray.
    const validHexes  = Rules.filter_hexes_with_Los(State.fireGroupHexesArray, targetHex, State.orchardInSeason);

    if (validHexes.length === 0) { console.log('No los from any fg unit . Firing still is pending');  }
    const subFGsArray = _form_sub_Fire_Groups(firegroupUnits, validHexes);

    // Визуал LoS-линий и точки блока (даже если атака abort'нется дальше).
    console.log(`Из ${State.fireGroupHexesArray.length} гексовой фг ${validHexes.length} гексов имеют Лос`);

    _drawLOS(State.fireGroupHexesArray, targetHex, validHexes);
    const hit = getLastHit();   // возвращает пиксельные координаты + тип препятствия, где последний checkLOS упёрся в блокер
    UIState.flashHitPoints(hit ? [hit] : []);

    switch (phase) {
        // ============================================================
        // MPh — DFF: defender стреляет по двинувшимся attacker'ам.
        // ============================================================
        case 'movement': {
            
            // Свежий список целей — двинувшиеся в hex этой MPh (движущиеся моменту).
            // Функция, а не массив: между sub-FG некоторые цели могут быть eliminated.
            const getTargets = () => _movedTargetsInHex(targetHex);
            if (getTargets().length === 0) {
                console.log(`[Fire] В (${targetHex.col},${targetHex.row}) нет свежедвинувшихся целей — юниты закончили движение ранее, DFF невозможен.`);
                return;
            }

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
                if (result.coloredDie !== undefined) UIState.showDice(result.coloredDie, result.whiteDie);
                for (const u of subFG) if (u.category === 'carried' && u.mgClass) shakeNode(u.node);

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
                if (result.coloredDie !== undefined) UIState.showDice(result.coloredDie, result.whiteDie);
                for (const u of subFG) if (u.category === 'carried' && u.mgClass) shakeNode(u.node);

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
                if (result.coloredDie !== undefined) UIState.showDice(result.coloredDie, result.whiteDie);
                for (const u of subFG) if (u.category === 'carried' && u.mgClass) shakeNode(u.node);

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
                if (result.coloredDie !== undefined) UIState.showDice(result.coloredDie, result.whiteDie);
                for (const u of subFG) if (u.category === 'carried' && u.mgClass) shakeNode(u.node);

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

    // Собрать target-панель: before (снятый в начале) + after (сейчас) → показать.
    const afterSnap = _snapshotTargetsAfterFireEffect(initialTargetUids, beforeSnap);
    const panel     = _createTargetPanel(beforeSnap, afterSnap);
    if (panel.length) {
        State.lastGroupInteracted = 'targets';
        UIState.showTargetPanel(panel);
    }
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
        // PFPh (ASL 3.2.5): после резолва атаки — пометить юнит prepFired + снять CX counter.
        // Правило: "remove CX counter [if any] from firing unit".
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
// Ключ dynamicTerrain должен быть в формате "col-row" (с тире) — так же как в hexMap, иначе terrainAt не найдёт.
function _place_Smoke_if_possible(hex) {
    const hexKey = `${hex.col}-${hex.row}`;
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
    _refreshGroupPanel();   // убитый мог быть в группе — обновить панель
}

// заменить юнит на новый (по templateId) в том же гексе — с флип-анимацией.
// Перед удалением капим статусы старого; после спавна применяем их к новому
// (broken/DM/pinned/exhausted survivor должен сохраниться).
function _replace_unit(oldId, newTemplateId, newId) {
    const old = State.units[oldId];
    if (!old) return;

    // VP: CR squad → halfSquad даёт 1 VP (как за уничтожение halfSquad по правилу).
    const newTpl = TEMPLATES[newTemplateId];
    if (AXIS_NATIONS.has(old.nation)
        && old.type === 'squad' && old.size !== 'halfSquad'
        && newTpl && newTpl.size === 'halfSquad') {
        _grantVP('allied', 1);
    }

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
            // 'broken' применяем напрямую, без setUnit — иначе flipRendering стартует
            // конкурирующий tween со stale x0 и утаскивает юнит в центр гекса.
            if (key === 'broken') continue;
            State.setUnit(newId, key, val);
        }
        if (inherit.broken) {
            newUnit.broken = true;
            if (newUnit.brokenImage) newUnit.node.findOne('Image').image(newUnit.brokenImage);
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
            const u = State.units[id];
            await _killUnit(id, { cause: 'fire', hex: u && u.hex });
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
        if (u && u.broken && state !== 'broken') State.setUnit(id, 'broken', true);   // broken уже взведён правилом (например, wounded original-12), а state=='wounded' сам broken не трогает
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
                State.setUnit(w.id, 'movedThisMPh', true);   // оружие сменило гекс
            }
        });
    });
    _updateHexControl(targetHex);   // A26: Good Order MMC в hex'е без enemy → контроль нашей стороне
    _refreshGroupPanel();           // mf юнитов изменился, hex тоже → пересчитать число над панелью
    // Out-of-bounds: если targetHex вне scen.playArea — все вошедшие юниты элиминируются.
    if (_isOutOfBounds(targetHex)) {
        for (const unitId of Object.keys(result.unitChanges)) {
            await _eliminateIfOutOfBounds(unitId);
        }
    }

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

    // Если MG пустая — msh семантически неактуален, переустанавливаем на hex текущего клика.
    // Защита от "сироты" msh после путей, где MG опустошается без сброса msh.
    if (!State.movementStackHex || State.movementGroup.length === 0) {
        State.movementStackHex = unit.hex;
    }

    // В MPh движется attacker (interpreter уже отфильтровал phase — сюда доходит только в MPh).
    if (!Rules.checkIfAddingToMovementGroupIsValid(unit, State.movementStackHex, 'attacker', State.movementGroup, State.units)) {
        return;
    }
    if (!State.movementGroup.includes(unitId)) {
        State.movementGroup.push(unitId);              // добавить в массив группы
        _setInMovementGroup(unitId, true);             // поставить флаг на юнита + его possessed weapons
        _refreshMGButtons();                           // пересчитать кнопки MG (DoubleTime/Assault/Smoke/Drop/Recover)
        State.lastGroupInteracted = 'mg';              // пометить что последний клик был по MG
        _refreshGroupPanel();                          // перерисовать правую панель с новым составом
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
        State.fireGroup.push(unitId);                               // добавить в массив группы
        State.setUnit(unitId, 'inFireGroup', true);                 // поднять флаг (рендерер нарисует рамку на юните)
        const key = `${unit.hex.col},${unit.hex.row}`;              // ключ hex'а для списка «гексов стрелков»
        if (!State.fireGroupHexesArray.some(h => `${h.col},${h.row}` === key)) {
            State.fireGroupHexesArray.push({ col: unit.hex.col, row: unit.hex.row });   // новый hex в списке стрелков
        }
        State.lastGroupInteracted = 'fg';                           // пометить что последний клик был по FG
        _refreshGroupPanel();                                       // перерисовать правую панель
    }
}

// --- Панель групп (MG/FG) ----------------------------------------------------

// Какую группу показывать (или null если обе пусты).
// Приоритет у последней активной группы; если она пуста — показываем ту, где есть юниты.
function _pickGroupToShow() {
    const mg = State.movementGroup;
    const fg = State.fireGroup;
    if (State.lastGroupInteracted === 'fg' && fg.length) return fg;
    if (State.lastGroupInteracted === 'mg' && mg.length) return mg;
    if (mg.length) return mg;
    if (fg.length) return fg;
    return null;
}

// Собрать layout панели групп из списка id юнитов.
// Возвращает {x, y, w, h, items} — где x/y/w/h это рамка панели на экране,
// а items — [{id, x, y, image}] с абсолютными экранными координатами и ссылкой на картинку.
function _computeGroupPanelLayout(unitIds) {
    // Константы раскладки — локальные, нужны только тут.
    const PANEL_Y            = 250;   // фиксированная вертикаль под кубиками и VP-счётчиками
    const PANEL_RIGHT_MARGIN = 51;    // отступ от правого края экрана
    const PAD_X              = 24;    // внутренний горизонтальный паддинг панели
    const PAD_Y              = 8;     // внутренний вертикальный паддинг панели
    const GAP                = 4;     // зазор между иконками по вертикали

    // Размеры панели: одна иконка по ширине, по высоте — сумма всех иконок с зазорами + паддинги.
    const w = UNIT_IMAGE_SIZE + PAD_X * 2;
    const h = unitIds.length * UNIT_IMAGE_SIZE
            + (unitIds.length - 1) * GAP
            + PAD_Y * 2;

    // Положение самой панели на экране: right-anchored (упираем в правый край с отступом),
    // Y фиксированный.
    const stage = State.uiLayer.getStage();
    const panelX = stage.width() - w - PANEL_RIGHT_MARGIN;
    const panelY = PANEL_Y;

    // Иконки — одна колонка, сразу в абсолютных экранных координатах.
    // Картинку выбираем в зависимости от broken-флага юнита.
    const items = unitIds.map((id, idx) => {
        const u = State.units[id];
        return {
            id,
            x: panelX + PAD_X,
            y: panelY + PAD_Y + idx * (UNIT_IMAGE_SIZE + GAP),
            image: u && u.broken ? u.brokenImage : (u && u.image),
        };
    });

    return { x: panelX, y: panelY, w, h, items };
}

// MF, которое будет показано в панели — гипотетически возможный остаток для стопки.
// Базовый u.mf + лидер-бонус (если в группе есть лидер) + road-бонус (если весь путь
// был по дороге И юнит не использовал Woods-Road опцию). Последний hex в path и есть текущий,
// так что отдельная проверка «на дороге» не нужна.
function _calc_mf_to_show_in_panel(u, mg, units) {
    const leader = Rules.hasLeader(mg, units) ? u.leaderBonus : 0;
    const road   = Rules._all_path_is_road(u.path) && !u.usedWoodsRoad ? u.roadBonus : 0;
    return u.mf + leader + road;
}

// Остаток MF группы = минимум по членам (стопка идёт в темпе самого медленного).
// null если группа пуста.
function _groupMF(mg) {
    if (!mg.length) return null;
    return Math.min(...mg.map(id => _calc_mf_to_show_in_panel(State.units[id], mg, State.units)));
}

// Эффективный вклад одного юнита в групповой FP (без дистанционных множителей).
// Учитывает broken, лидера (0), pinned, SFF/FPF, AFPh halving + Assault Fire.
function _unitFPForPanel(u) {
    if (u.broken) return 0;
    if (u.type === 'leader') return 0;
    let fp = u.pinned ? u.firepower / 2 : (u.firepower || 0);
    if (u.firingStatus === 'FirstFire') fp = fp / 2;
    if (u.firingStatus === 'FinalFire') fp = fp / 2;
    if (PhaseManager.getPhase() === 'advancingFire') {
        fp = fp / 2;
        if (u.underlinedFP && u.type === 'squad') {
            fp = Math.ceil(fp) + 1;
        } else {
            fp = Math.floor(fp);
        }
    }
    return fp;
}

// Групповой FP для панели — сумма эффективных вкладов членов FG.
// Дистанционные множители (PBF/TPBF/long/range cap) не учитываются — цель ещё не выбрана.
function _groupFP(fg) {
    if (!fg.length) return null;
    return fg.reduce((s, id) => s + _unitFPForPanel(State.units[id]), 0);
}

// Снимок иконок всех целей ДО применения эффекта огня. Массив [{id, image}].
function _snapshotTargetsBeforeFireEffect(uids) {
    return uids.map(uid => {
        const u = State.units[uid];
        return { id: uid, image: u.broken ? u.brokenImage : u.image };
    });
}

// Снимок иконок всех целей ПОСЛЕ эффекта. Массив [{id, image, kia, pinned, wounded}].
// Для KIA юнит уже удалён → берём картинку из beforeSnapshot и помечаем kia=true.
function _snapshotTargetsAfterFireEffect(uids, beforeSnapshot) {
    return uids.map(uid => {
        const u = State.units[uid];
        if (!u) {
            const before = beforeSnapshot.find(entry => entry.id === uid);
            return { id: uid, image: before ? before.image : null, kia: true, pinned: false, wounded: false };
        }
        return { id: uid, image: u.broken ? u.brokenImage : u.image, kia: false, pinned: !!u.pinned, wounded: !!u.wounded };
    });
}

// Склеивает два снимка в payload панели: [{id, beforeImage, after}].
function _createTargetPanel(beforeSnapshot, afterSnapshot) {
    return beforeSnapshot.map(targetBefore => {
        const targetAfter = afterSnapshot.find(candidate => candidate.id === targetBefore.id);
        return {
            id:          targetBefore.id,
            beforeImage: targetBefore.image,
            after:       targetAfter,
        };
    });
}

// Главная точка: решить что показать, собрать layout, добавить MF-число и уведомить UI.
function _refreshGroupPanel() {
    const unitIds = _pickGroupToShow();
    if (!unitIds) { UIState.hideGroupPanel(); return; }
    const layout = _computeGroupPanelLayout(unitIds);
    // MF — только для MG, FP — только для FG.
    if (unitIds === State.movementGroup) {
        layout.mf = _groupMF(unitIds);
    } else if (unitIds === State.fireGroup) {
        layout.fp = _groupFP(unitIds);
    }
    UIState.showGroupPanel(layout);
}


export const Engine = {

  handlers,   // прямой доступ к обработчикам (используется в interpretDblClickEvent)

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