import { Engine } from './engine.js'
import { State } from './state.js'
import { PhaseManager } from './phase_manager.js'   


function createContext(e) {

    const unitId      = e.target.getAttr('unitId');                   // id юнита из события
    const buttonLabel = e.target.getParent()?.getAttr('buttonLabel'); // label кнопки UI (атрибут на группе)
    const button      = e.evt.button;                                 // кнопка мыши: 0=left, 2=right
    const shiftKey    = e.evt.shiftKey;                               // зажат ли шифт
    const pos         = e.target.getStage().getPointerPosition();     // координаты клика

    return { unitId, buttonLabel, button, shiftKey, pos };
}

// ---------------------------------------------------------------------------
// Проверка одной группы — все условия должны пройти (AND)
// ---------------------------------------------------------------------------
function checkGroup(group, ctx, cmd) {
  for (const [name, check] of Object.entries(group)) {
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
                noShift:               ctx => !ctx.shiftKey,
                leftClick:       ctx => ctx.button !== 2,
                hasUnit:   ctx => ctx.unitId !== undefined,
                clickedSideIsAttacker: ctx => State.units[ctx.unitId].nation === PhaseManager.getActiveSide(),
                movingGroupIsEmpty: () => State.movementGroup.length === 0,
                fireGroupIsEmpty:   () => State.fireGroup.length === 0,
            },
            {
                shift :       ctx => ctx.shiftKey,
                leftClick:       ctx => ctx.button !== 2,
                hasUnit:   ctx => ctx.unitId !== undefined,
                clickedSideIsAttacker: ctx => State.units[ctx.unitId].nation === PhaseManager.getActiveSide(),
                movingGroupIsNotEmpty: () => State.movementGroup.length > 0,
                fireGroupIsEmpty:      () => State.fireGroup.length === 0,
            }
        ],
        name:'addToMovingGroup'
    },
    {
        requiresAny: [
            {
                leftClick:       ctx => ctx.button !== 2,
                hasUnit:   ctx => ctx.unitId !== undefined,
                clickedSideIsDefender: ctx => State.units[ctx.unitId].nation === PhaseManager.getDefendingSide(),
                fireGroupIsEmpty: () => State.fireGroup.length === 0,
                mfspent: () => State.mfspent,
            },
            {
                shift :       ctx => ctx.shiftKey,
                leftClick:       ctx => ctx.button !== 2,
                hasUnit:   ctx => ctx.unitId !== undefined,
                clickedSideIsDefender: ctx => State.units[ctx.unitId].nation === PhaseManager.getDefendingSide(),
                fireGroupIsNotEmpty: () => State.fireGroup.length > 0,
            }
        ],
        name: 'addToFireGroup'
    },
    {
        requiresAny: [
            {
                noShift:               ctx => !ctx.shiftKey,
                leftClick:      ctx => ctx.button !== 2,
                noFireGroup: () => State.fireGroup.length === 0,
                // somethingSelected: () => State.selected !== null,
                // selectedUnitIsAttacker: () => State.units[State.selected].nation === PhaseManager.getActiveSide(),
                movingGroupIsnotEmpty: () => State.movementGroup.length > 0
            }
        ],
        name: 'MOVE'
    },
    {   requiresAny: [
            {
                noShift:               ctx => !ctx.shiftKey,
                leftClick:      ctx => ctx.button !== 2,
                fireGroupIsNotEmpty: () => State.fireGroup.length > 0,
                hasUnit:   ctx => ctx.unitId !== undefined,
                clickedSideIsAttacker: ctx => State.units[ctx.unitId].nation === PhaseManager.getActiveSide()
            }
        ],
        name: 'DefensiveFirstFire'
    },

]

// Правила для клавиатуры
const KEY_RULES = [
  { match: ({ key }) => key === 'Escape', name: 'DESELECT_ALL' },
];

export function interpretEvent(e) {

    const ctx = createContext(e);

    const rule = RULES.find(r => matchRule(r, ctx));  // первое подошедшее правило
    if (!rule) return;

    Engine.execute({ name: rule.name, ctx:ctx }); // → { name: 'SELECT_UNIT', unitId: ..., pos: ... }
}

export function interpretKeyEvent(e) {
    const ctx = { key: e.key };
    const rule = KEY_RULES.find(r => r.match(ctx));
    if (!rule) return;
    Engine.execute({ name: rule.name, ctx });
}