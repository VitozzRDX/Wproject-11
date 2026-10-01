import { Engine } from './engine.js'
import { State } from './state.js'
import { PhaseManager } from './phase_manager.js'
import { pixelToHex, isSameHex } from './hexUtils.js'


function createContext(e) {

    const unitId      = e.target.getAttr('unitId');                   // id юнита из события
    const buttonLabel = e.target.getParent()?.getAttr('buttonLabel'); // label кнопки UI (атрибут на группе)
    const button      = e.evt.button;                                 // кнопка мыши: 0=left, 2=right
    const shiftKey    = e.evt.shiftKey;                               // зажат ли шифт
    // ccPanel — клик по юниту в CC-панели (uiLayer), а не по юниту на поле.
    const ccPanel     = e.target.getParent()?.getAttr('ccPanel') === true;
    // transferPanel — клик по элементу transfer-панели (RPh, uiLayer).
    const transferPanel = e.target.getParent()?.getAttr('transferPanel') === true;
    // мировые координаты клика (учитываем сдвиг stage от скроллинга WASD)
    const stage       = e.target.getStage();
    const raw         = stage.getPointerPosition();
    const pos         = { x: raw.x - stage.x(), y: raw.y - stage.y() };

    return { unitId, buttonLabel, button, shiftKey, pos, ccPanel, transferPanel };
}

// ---------------------------------------------------------------------------
// Проверка одной группы — все условия должны пройти (AND)
// ---------------------------------------------------------------------------
function checkGroup(group, ctx, cmd) {
  for (const [name, check] of Object.entries(group)) { // Ключ: name, Значение: check
    if (!check(ctx)) {
      return false;
    }
  }
  return true;
}

// Правило срабатывает если выполнена хотя бы одна группа (OR)
export function matchRule(rule, ctx) {
  const ok = rule.requiresAny.some(g => checkGroup(g, ctx, rule.name));
  return ok;
}


const RULES = [

    {
        requiresAny: [
            { isButton: ctx => ctx.buttonLabel === 'NextPhase' }
        ],
        name: 'NextPhase'
    },
    {
        requiresAny: [{ leftClick: c => c.button !== 2, clickedBtn: c => c.buttonLabel === 'Save' }],
        name: 'Save'
    },
    {
        requiresAny: [{ leftClick: c => c.button !== 2, clickedBtn: c => c.buttonLabel === 'Load' }],
        name: 'Load'
    },
    {
        requiresAny: [
            { isButton: ctx => ctx.buttonLabel === 'DoubleTime' }
        ],
        name: 'DoubleTime'
    },
    {
        requiresAny: [
            { isButton: ctx => ctx.buttonLabel === 'AssaultMovement' }
        ],
        name: 'AssaultMovement'
    },
    {
        requiresAny: [
            { isButton: ctx => ctx.buttonLabel === 'PlaceSmoke' }
        ],
        name: 'PlaceSmoke'
    },
    {
        requiresAny: [
            { isButton: ctx => ctx.buttonLabel === 'Drop' }
        ],
        name: 'Drop'
    },
    {
        requiresAny: [
            { isButton: ctx => ctx.buttonLabel === 'Recover' }
        ],
        name: 'Recover'
    },
    {
        requiresAny: [
            { isButton: ctx => ctx.buttonLabel === 'Drop' }
        ],
        name: 'Drop'
    },
    {
        requiresAny: [
            { isButton: ctx => ctx.buttonLabel === 'UseWoods' }
        ],
        name: 'UseWoods'
    },
    {
        requiresAny: [
            { isButton: ctx => ctx.buttonLabel === 'UseRoad' }
        ],
        name: 'UseRoad'
    },

    {
        requiresAny: [
            {
                phaseIsMovement:       ()  => PhaseManager.getPhase() === 'movement',
                noShift:               ctx => !ctx.shiftKey,
                leftClick:             ctx => ctx.button !== 2,
                hasUnit:               ctx => ctx.unitId !== undefined,
                clickedSideIsAttacker: ctx => State.units[ctx.unitId].side === 'attacker',
                movingGroupIsEmpty:    ()  => State.movementGroup.length === 0,
                fireGroupIsEmpty:      ()  => State.fireGroup.length === 0,
            },
            {
                phaseIsMovement:       ()  => PhaseManager.getPhase() === 'movement',
                shift:                 ctx => ctx.shiftKey,
                leftClick:             ctx => ctx.button !== 2,
                hasUnit:               ctx => ctx.unitId !== undefined,
                clickedSideIsAttacker: ctx => State.units[ctx.unitId].side === 'attacker',
                movingGroupIsNotEmpty: ()  => State.movementGroup.length > 0,
                fireGroupIsEmpty:      ()  => State.fireGroup.length === 0,
            }
        ],
        name: 'addToMovingGroup'
    },
    {
        requiresAny: [
            // MPh: defender добавляется в FG для DFF
            {
                phaseIsMovement:       ()  => PhaseManager.getPhase() === 'movement',
                leftClick:             ctx => ctx.button !== 2,
                hasUnit:               ctx => ctx.unitId !== undefined,
                clickedSideIsDefender: ctx => State.units[ctx.unitId].side === 'defender',
                fireGroupIsEmpty:      ()  => State.fireGroup.length === 0,
                mfspent:               ()  => State.mfspent,
            },
            {
                phaseIsMovement:       ()  => PhaseManager.getPhase() === 'movement',
                shift:                 ctx => ctx.shiftKey,
                leftClick:             ctx => ctx.button !== 2,
                hasUnit:               ctx => ctx.unitId !== undefined,
                clickedSideIsDefender: ctx => State.units[ctx.unitId].side === 'defender',
                fireGroupIsNotEmpty:   ()  => State.fireGroup.length > 0,
            },
            // PFPh: attacker добавляется в FG для prep fire
            {
                phaseIsPrepFire:       ()  => PhaseManager.getPhase() === 'prepFire',
                leftClick:             ctx => ctx.button !== 2,
                hasUnit:               ctx => ctx.unitId !== undefined,
                clickedSideIsAttacker: ctx => State.units[ctx.unitId].side === 'attacker',
                fireGroupIsEmpty:      ()  => State.fireGroup.length === 0,
            },
            {
                phaseIsPrepFire:       ()  => PhaseManager.getPhase() === 'prepFire',
                shift:                 ctx => ctx.shiftKey,
                leftClick:             ctx => ctx.button !== 2,
                hasUnit:               ctx => ctx.unitId !== undefined,
                clickedSideIsAttacker: ctx => State.units[ctx.unitId].side === 'attacker',
                fireGroupIsNotEmpty:   ()  => State.fireGroup.length > 0,
            },
            // DFPh: defender добавляется в FG для Final Fire
            {
                phaseIsDefensiveFire:  ()  => PhaseManager.getPhase() === 'defensiveFire',
                leftClick:             ctx => ctx.button !== 2,
                hasUnit:               ctx => ctx.unitId !== undefined,
                clickedSideIsDefender: ctx => State.units[ctx.unitId].side === 'defender',
                fireGroupIsEmpty:      ()  => State.fireGroup.length === 0,
            },
            {
                phaseIsDefensiveFire:  ()  => PhaseManager.getPhase() === 'defensiveFire',
                shift:                 ctx => ctx.shiftKey,
                leftClick:             ctx => ctx.button !== 2,
                hasUnit:               ctx => ctx.unitId !== undefined,
                clickedSideIsDefender: ctx => State.units[ctx.unitId].side === 'defender',
                fireGroupIsNotEmpty:   ()  => State.fireGroup.length > 0,
            },
            // AFPh: attacker добавляется в FG для Advancing Fire
            {
                phaseIsAdvancingFire:  ()  => PhaseManager.getPhase() === 'advancingFire',
                leftClick:             ctx => ctx.button !== 2,
                hasUnit:               ctx => ctx.unitId !== undefined,
                clickedSideIsAttacker: ctx => State.units[ctx.unitId].side === 'attacker',
                fireGroupIsEmpty:      ()  => State.fireGroup.length === 0,
            },
            {
                phaseIsAdvancingFire:  ()  => PhaseManager.getPhase() === 'advancingFire',
                shift:                 ctx => ctx.shiftKey,
                leftClick:             ctx => ctx.button !== 2,
                hasUnit:               ctx => ctx.unitId !== undefined,
                clickedSideIsAttacker: ctx => State.units[ctx.unitId].side === 'attacker',
                fireGroupIsNotEmpty:   ()  => State.fireGroup.length > 0,
            }
        ],
        name: 'addToFireGroup'
    },
    {
        requiresAny: [{
            pendingSmoke: () => State.pendingSmoke,
            leftClick:    ctx => ctx.button !== 2,
        }],
        name: 'PlaceSmokeTarget'
    },
    {
        requiresAny: [
            {
                noShift:               ctx => !ctx.shiftKey,
                leftClick:      ctx => ctx.button !== 2,
                noFireGroup: () => State.fireGroup.length === 0,
                // somethingSelected: () => State.selected !== null,
                // selectedUnitIsAttacker: () => State.units[State.selected].side === PhaseManager.getActiveRole(),
                movingGroupIsnotEmpty: () => State.movementGroup.length > 0
            }
        ],
        name: 'MOVE'
    },
    {   requiresAny: [
            // MPh: target = attacker (DFF)
            {
                phaseIsMovement:       ()  => PhaseManager.getPhase() === 'movement',
                noShift:               ctx => !ctx.shiftKey,
                leftClick:             ctx => ctx.button !== 2,
                fireGroupIsNotEmpty:   ()  => State.fireGroup.length > 0,
                hasUnit:               ctx => ctx.unitId !== undefined,
                clickedSideIsAttacker: ctx => State.units[ctx.unitId].side === 'attacker',
            },
            // PFPh: target = defender (prep fire)
            {
                phaseIsPrepFire:       ()  => PhaseManager.getPhase() === 'prepFire',
                noShift:               ctx => !ctx.shiftKey,
                leftClick:             ctx => ctx.button !== 2,
                fireGroupIsNotEmpty:   ()  => State.fireGroup.length > 0,
                hasUnit:               ctx => ctx.unitId !== undefined,
                clickedSideIsDefender: ctx => State.units[ctx.unitId].side === 'defender',
            },
            // DFPh: target = attacker (Final Fire)
            {
                phaseIsDefensiveFire:  ()  => PhaseManager.getPhase() === 'defensiveFire',
                noShift:               ctx => !ctx.shiftKey,
                leftClick:             ctx => ctx.button !== 2,
                fireGroupIsNotEmpty:   ()  => State.fireGroup.length > 0,
                hasUnit:               ctx => ctx.unitId !== undefined,
                clickedSideIsAttacker: ctx => State.units[ctx.unitId].side === 'attacker',
            },
            // AFPh: target = defender (Advancing Fire)
            {
                phaseIsAdvancingFire:  ()  => PhaseManager.getPhase() === 'advancingFire',
                noShift:               ctx => !ctx.shiftKey,
                leftClick:             ctx => ctx.button !== 2,
                fireGroupIsNotEmpty:   ()  => State.fireGroup.length > 0,
                hasUnit:               ctx => ctx.unitId !== undefined,
                clickedSideIsDefender: ctx => State.units[ctx.unitId].side === 'defender',
            }
        ],
        name: 'Fire'
    },
    // RtPh: клик по must-rout юниту → выбор для раута
    {
        requiresAny: [{
            phaseIsRout:     ()  => PhaseManager.getPhase() === 'rout',
            leftClick:       ctx => ctx.button !== 2,
            hasUnit:         ctx => ctx.unitId !== undefined,
            clickedMustRout: ctx => State.units[ctx.unitId].mustRout === true,
            noActiveRouter:  ()  => State.routingUnit === null,   // нельзя переключаться пока текущий не EndRout
            attackerFirst:   ctx => {                             // ASL 3.6: attacker-mustRout юниты рутятся первыми
                if (State.units[ctx.unitId].side === 'attacker') return true;
                return !Object.values(State.units).some(u => u.side === 'attacker' && u.mustRout);
            },
        }],
        name: 'SelectRouter'
    },
    // RtPh: Shift+клик на unpinned leader'е в хексе router'а → toggle escort.
    {
        requiresAny: [{
            phaseIsRout:      ()  => PhaseManager.getPhase() === 'rout',
            leftClick:        ctx => ctx.button !== 2,
            shiftHeld:        ctx => ctx.shiftKey,
            hasUnit:          ctx => ctx.unitId !== undefined,
            activeRouter:     ()  => State.routingUnit !== null,
            clickedLeader:    ctx => State.units[ctx.unitId].type === 'leader',
            leaderUnpinned:   ctx => !State.units[ctx.unitId].pinned,
            leaderInRouterHex: ctx => {
                const l = State.units[ctx.unitId];
                const r = State.units[State.routingUnit];
                return r && isSameHex(l.hex, r.hex);
            },
        }],
        name: 'EscortWithLeader'
    },
    // RtPh: клик по одному из подсвеченных shelter-хексов → выбор destination.
    // ДОЛЖНО идти перед RoutMove — иначе клик по shelter'у будет обработан как мув.
    {
        requiresAny: [{
            phaseIsRout:    ()  => PhaseManager.getPhase() === 'rout',
            leftClick:      ctx => ctx.button !== 2,
            hasRoutingUnit: ()  => State.routingUnit !== null,
            noChosenShelter: () => !State.units[State.routingUnit]?.chosenShelter,
            clickedShelter: ctx => {
                const u = State.units[State.routingUnit];
                if (!u?.shelterHexes?.length) return false;
                const h = pixelToHex(ctx.pos.x, ctx.pos.y);
                return u.shelterHexes.some(s => isSameHex(s, h));
            },
        }],
        name: 'PickShelter'
    },
    // RtPh: клик по кнопке EndRout → финализация с elimination-check.
    {
        requiresAny: [{
            phaseIsRout:          ()  => PhaseManager.getPhase() === 'rout',
            leftClick:            ctx => ctx.button !== 2,
            clickedEndRoutButton: ctx => ctx.buttonLabel === 'EndRout',
        }],
        name: 'EndRout'
    },
    // RtPh: клик по кнопке LowCrawl → arm mode, следующий RoutMove работает по LC правилам.
    {
        requiresAny: [{
            phaseIsRout:           ()  => PhaseManager.getPhase() === 'rout',
            leftClick:             ctx => ctx.button !== 2,
            clickedLowCrawlButton: ctx => ctx.buttonLabel === 'LowCrawl',
        }],
        name: 'ArmLowCrawl'
    },
    // RtPh: клик по hex'у (когда есть активный router и выбран destination или free-rout).
    {
        requiresAny: [{
            phaseIsRout:   ()  => PhaseManager.getPhase() === 'rout',
            leftClick:     ctx => ctx.button !== 2,
            routingActive: ()  => State.routingUnit !== null,
            readyToMove:   ()  => {
                const u = State.units[State.routingUnit];
                return u?.chosenShelter || !u?.shelterHexes?.length;   // destination выбран ИЛИ free-rout mode
            },
        }],
        name: 'RoutMove'
    },
    // APh: клик по attacker юниту → выбрать для advance. Срабатывает только когда ничего не выбрано
    // (чтобы при уже выбранном юните клик по хексу/другому юниту шёл в Advance; переключение — через Escape).
    {
        requiresAny: [{
            phaseIsAdvance:   ()  => PhaseManager.getPhase() === 'advance',
            leftClick:        ctx => ctx.button !== 2,
            hasUnit:          ctx => ctx.unitId !== undefined,
            ownSide:          ctx => State.units[ctx.unitId].side === 'attacker',
            nothingSelected:  ()  => State.advanceSelected === null,
        }],
        name: 'SelectForAdvance'
    },
    // APh: клик по hex'у (когда есть selected) → advance туда.
    {
        requiresAny: [{
            phaseIsAdvance: ()  => PhaseManager.getPhase() === 'advance',
            leftClick:      ctx => ctx.button !== 2,
            hasSelected:    ()  => State.advanceSelected !== null,
        }],
        name: 'Advance'
    },
    // CCPh: клик на CC-хекс (красный) → выбрать его для разрешения.
    {
        requiresAny: [{
            phaseIsCC:    ()  => PhaseManager.getPhase() === 'closeCombat',
            leftClick:    ctx => ctx.button !== 2,
            notPanel:     ctx => !ctx.ccPanel,
            notUnit:      ctx => ctx.unitId === undefined,   // клик по пустому хексу, не по юниту
            notButton:    ctx => ctx.buttonLabel === undefined,
        }],
        name: 'SelectCCHex'
    },
    // CCPh: клик по юниту в CC-панели → toggle selection.
    {
        requiresAny: [{
            phaseIsCC:    ()  => PhaseManager.getPhase() === 'closeCombat',
            leftClick:    ctx => ctx.button !== 2,
            ccPanel:      ctx => ctx.ccPanel,
            hasUnit:      ctx => ctx.unitId !== undefined,
        }],
        name: 'CCToggleUnit'
    },
    // CCPh: кнопка ConfirmCCAttack → зафиксировать текущий выбор как одну атаку.
    {
        requiresAny: [{
            phaseIsCC:  ()  => PhaseManager.getPhase() === 'closeCombat',
            leftClick:  ctx => ctx.button !== 2,
            clickedBtn: ctx => ctx.buttonLabel === 'ConfirmCCAttack',
        }],
        name: 'ConfirmCCAttack'
    },
    // CCPh: кнопка StartDefenderCC → переключаем declare-фазу на defender.
    {
        requiresAny: [{
            phaseIsCC:  ()  => PhaseManager.getPhase() === 'closeCombat',
            leftClick:  ctx => ctx.button !== 2,
            clickedBtn: ctx => ctx.buttonLabel === 'StartDefenderCC',
        }],
        name: 'StartDefenderCC'
    },
    // CCPh: кнопка ResolveCC → расчёт всех атак + apply simultaneous.
    {
        requiresAny: [{
            phaseIsCC:  ()  => PhaseManager.getPhase() === 'closeCombat',
            leftClick:  ctx => ctx.button !== 2,
            clickedBtn: ctx => ctx.buttonLabel === 'ResolveCC',
        }],
        name: 'ResolveCC'
    },
    // CCPh: кнопка RollAmbush → проверка засады перед объявлением атак.
    {
        requiresAny: [{
            phaseIsCC:  ()  => PhaseManager.getPhase() === 'closeCombat',
            leftClick:  ctx => ctx.button !== 2,
            clickedBtn: ctx => ctx.buttonLabel === 'RollAmbush',
        }],
        name: 'RollAmbush'
    },
    // RPh Transfer: кнопка EndAttackerTransfer → переход в defender transfer.
    {
        requiresAny: [{
            phaseIsRally: () => PhaseManager.getPhase() === 'rally',
            leftClick:    ctx => ctx.button !== 2,
            clickedBtn:   ctx => ctx.buttonLabel === 'EndAttackerTransfer',
        }],
        name: 'EndAttackerTransfer'
    },
    // RPh Transfer: кнопка EndDefenderTransfer → переход в Self-Rally подфазу.
    {
        requiresAny: [{
            phaseIsRally: () => PhaseManager.getPhase() === 'rally',
            leftClick:    ctx => ctx.button !== 2,
            clickedBtn:   ctx => ctx.buttonLabel === 'EndDefenderTransfer',
        }],
        name: 'EndDefenderTransfer'
    },
    // RPh Transfer: клик по элементу transfer-панели (weapon или infantry).
    {
        requiresAny: [{
            phaseIsRally:       () => PhaseManager.getPhase() === 'rally',
            subPhaseIsTransfer: () => State.rallySubPhase === 'transfer',
            leftClick:          ctx => ctx.button !== 2,
            transferPanel:      ctx => ctx.transferPanel,
            hasUnit:            ctx => ctx.unitId !== undefined,
        }],
        name: 'TransferPanelClick'
    },
    // RPh Transfer: клик по гексу или юниту на карте — открыть transfer-панель для этого гекса.
    {
        requiresAny: [{
            phaseIsRally:       () => PhaseManager.getPhase() === 'rally',
            subPhaseIsTransfer: () => State.rallySubPhase === 'transfer',
            leftClick:          ctx => ctx.button !== 2,
            notPanel:           ctx => !ctx.transferPanel,
            notButton:          ctx => ctx.buttonLabel === undefined,
        }],
        name: 'SelectTransferHex'
    },

    // RPh Recovery: кнопка EndAttackerRecovery → переход в defender-полу-фазу recovery.
    {
        requiresAny: [{
            phaseIsRally: () => PhaseManager.getPhase() === 'rally',
            leftClick:    ctx => ctx.button !== 2,
            clickedBtn:   ctx => ctx.buttonLabel === 'EndAttackerRecovery',
        }],
        name: 'EndAttackerRecovery'
    },
    // RPh Recovery: кнопка EndDefenderRecovery → переход в Transfer-подфазу.
    {
        requiresAny: [{
            phaseIsRally: () => PhaseManager.getPhase() === 'rally',
            leftClick:    ctx => ctx.button !== 2,
            clickedBtn:   ctx => ctx.buttonLabel === 'EndDefenderRecovery',
        }],
        name: 'EndDefenderRecovery'
    },
    // RPh Recovery: кнопка RecoveryAttempt → перебор eligible юнитов в выбранном гексе.
    {
        requiresAny: [{
            phaseIsRally: () => PhaseManager.getPhase() === 'rally',
            leftClick:    ctx => ctx.button !== 2,
            clickedBtn:   ctx => ctx.buttonLabel === 'RecoveryAttempt',
        }],
        name: 'RecoveryAttempt'
    },
    // RPh Recovery: клик по гексу с eligible-оружием → выбрать этот гекс для попытки.
    {
        requiresAny: [{
            phaseIsRally:       () => PhaseManager.getPhase() === 'rally',
            subPhaseIsRecovery: () => State.rallySubPhase === 'recovery',
            leftClick:          ctx => ctx.button !== 2,
            notButton:          ctx => ctx.buttonLabel === undefined,
        }],
        name: 'SelectRecoveryHex'
    },

    // RPh Repair: кнопка EndAttackerRepair → переход в defender-полу-фазу repair.
    {
        requiresAny: [{
            phaseIsRally: () => PhaseManager.getPhase() === 'rally',
            leftClick:    ctx => ctx.button !== 2,
            clickedBtn:   ctx => ctx.buttonLabel === 'EndAttackerRepair',
        }],
        name: 'EndAttackerRepair'
    },
    // RPh Repair: кнопка EndDefenderRepair → переход в Transfer-подфазу.
    {
        requiresAny: [{
            phaseIsRally: () => PhaseManager.getPhase() === 'rally',
            leftClick:    ctx => ctx.button !== 2,
            clickedBtn:   ctx => ctx.buttonLabel === 'EndDefenderRepair',
        }],
        name: 'EndDefenderRepair'
    },
    // RPh Repair: кнопка RepairAttempt → попытка ремонта всех eligible-weapons в выбранном гексе.
    {
        requiresAny: [{
            phaseIsRally: () => PhaseManager.getPhase() === 'rally',
            leftClick:    ctx => ctx.button !== 2,
            clickedBtn:   ctx => ctx.buttonLabel === 'RepairAttempt',
        }],
        name: 'RepairAttempt'
    },
    // RPh Repair: клик по гексу с eligible-broken оружием → выбрать hex для попытки.
    {
        requiresAny: [{
            phaseIsRally:     () => PhaseManager.getPhase() === 'rally',
            subPhaseIsRepair: () => State.rallySubPhase === 'repair',
            leftClick:        ctx => ctx.button !== 2,
            notButton:        ctx => ctx.buttonLabel === undefined,
        }],
        name: 'SelectRepairHex'
    },

    // RPh SelfRally: кнопки под-фазы + attempt.
    { requiresAny: [{ phaseIsRally: ()=>PhaseManager.getPhase()==='rally', leftClick: c=>c.button!==2, clickedBtn: c=>c.buttonLabel==='EndAttackerSelfRally' }], name: 'EndAttackerSelfRally' },
    { requiresAny: [{ phaseIsRally: ()=>PhaseManager.getPhase()==='rally', leftClick: c=>c.button!==2, clickedBtn: c=>c.buttonLabel==='EndDefenderSelfRally' }], name: 'EndDefenderSelfRally' },
    { requiresAny: [{ phaseIsRally: ()=>PhaseManager.getPhase()==='rally', leftClick: c=>c.button!==2, clickedBtn: c=>c.buttonLabel==='SelfRallyAttempt' }], name: 'SelfRallyAttempt' },

    // RPh SelfRally: клик по highlighted юниту → выбрать его для попытки.
    {
        requiresAny: [{
            phaseIsRally:        () => PhaseManager.getPhase() === 'rally',
            subPhaseIsSelfRally: () => State.rallySubPhase === 'selfRally',
            leftClick:           ctx => ctx.button !== 2,
            hasUnit:             ctx => ctx.unitId !== undefined,
            isHighlighted:       ctx => State.units[ctx.unitId]?.selfRallyHighlight,
        }],
        name: 'SelectSelfRallyUnit'
    },

    // RPh UnitRally: кнопки под-фазы + attempt.
    { requiresAny: [{ phaseIsRally: ()=>PhaseManager.getPhase()==='rally', leftClick: c=>c.button!==2, clickedBtn: c=>c.buttonLabel==='EndAttackerUnitRally' }], name: 'EndAttackerUnitRally' },
    { requiresAny: [{ phaseIsRally: ()=>PhaseManager.getPhase()==='rally', leftClick: c=>c.button!==2, clickedBtn: c=>c.buttonLabel==='EndDefenderUnitRally' }], name: 'EndDefenderUnitRally' },
    { requiresAny: [{ phaseIsRally: ()=>PhaseManager.getPhase()==='rally', leftClick: c=>c.button!==2, clickedBtn: c=>c.buttonLabel==='UnitRallyAttempt' }], name: 'UnitRallyAttempt' },

    // RPh UnitRally: клик по highlighted юниту → выбрать его для попытки.
    {
        requiresAny: [{
            phaseIsRally:        () => PhaseManager.getPhase() === 'rally',
            subPhaseIsUnitRally: () => State.rallySubPhase === 'unitRally',
            leftClick:           ctx => ctx.button !== 2,
            hasUnit:             ctx => ctx.unitId !== undefined,
            isHighlighted:       ctx => State.units[ctx.unitId]?.unitRallyHighlight,
        }],
        name: 'SelectUnitRallyUnit'
    },

    // RPh DM-Removal: клик по подсвеченному DM-юниту → opt-keep (DM остаётся).
    {
        requiresAny: [{
            phaseIsRally:        () => PhaseManager.getPhase() === 'rally',
            subPhaseIsDmRemoval: () => State.rallySubPhase === 'dmRemoval',
            leftClick:           ctx => ctx.button !== 2,
            hasUnit:             ctx => ctx.unitId !== undefined,
            isHighlighted:       ctx => State.units[ctx.unitId]?.dmRemovalHighlight,
        }],
        name: 'ToggleKeepDM'
    },

]

// Правила для клавиатуры
const KEY_RULES = [
  { match: ({ key }) => key === 'Escape', name: 'DESELECT_ALL' },
];

export function interpretEvent(e) {

    const ctx = createContext(e);
    console.log('[click] ctx=', ctx);

    const rule = RULES.find(r => matchRule(r, ctx));  // первое подошедшее правило
    console.log('[click] matched rule:', rule?.name ?? 'NONE');
    if (!rule) return;

    Engine.execute({ name: rule.name, ctx:ctx }); // → { name: 'SELECT_UNIT', unitId: ..., pos: ... }
}

export function interpretKeyEvent(e) {
    const ctx = { key: e.key };
    const rule = KEY_RULES.find(r => r.match(ctx));
    if (!rule) return;
    Engine.execute({ name: rule.name, ctx });
}