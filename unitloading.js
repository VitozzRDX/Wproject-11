import { State } from './state.js';
import { hexToPixel } from './hexUtils.js';
import { Rules } from './rules.js';

// ---------------------------------------------------------------------------
// Цепочка наследования — единая для юнитов и оружия
// ---------------------------------------------------------------------------
const Unit             = { state: 'ready' };

// --- Ветвь: пехота (сама двигается, имеет morale) ---
const Infantry         = { ...Unit, category: 'infantry',
                                    broken: false,        // morale-broken (провалил MC, в rout)
                                    hasStartedMoving: false, movementCompleted: false,
                                    leaderBonus: 0, roadBonus: 1, usedWoodsRoad: false,
                                    pinned: false, wounded: false, exhausted: false,
                                    doubleTime: false, assaultMovement: false,
                                    desperationMorale: false,
                                    mf_spent_in_current_hex: 0,
                                    smokeAttempted: false,   // сбрасывается в начале MPh (TODO при phase transitions)
                                    prepFired: false };      // отстрелялся в PFPh → блок мува в MPh
const Squad            = { ...Infantry, type: 'squad', mf: 4, leaderBonus: 2, firingStatus: ' ', ipc: 3 };   // MMC
const Leader           = { ...Infantry, type: 'leader', mf: 6, quality: 'Elite', ipc: 1 };                    // SMC
const GermanSquad_1st   = { ...Squad,  nation: 'german',   quality: '1stLine', selfRally: true  };
const SovietSquad_Elite = { ...Squad,  nation: 'soviet',   quality: 'Elite',   selfRally: true  };
const AmericanSquad     = { ...Squad,  nation: 'american', quality: 'Elite',   selfRally: true  };
const GermanLeader      = { ...Leader, nation: 'german' };
const SovietLeader      = { ...Leader, nation: 'soviet' };
const AmericanLeader    = { ...Leader, nation: 'american' };

// --- Ветвь: переносимые предметы (SW, guns) — требуют possessor ---
const CarriedItem      = { ...Unit, category: 'carried',
                                    possessorId: null,
                                    movedThisMPh: false,   // подобран/дропнут/пронесён в текущей MPh
                                    broken: false };       // weapon-jam / malfunction (B# сработал)
const SW               = { ...CarriedItem, type: 'SW', firingStatus: ' ' };
const MG               = { ...SW, kind: 'MG' };

// ---------------------------------------------------------------------------
// Шаблоны — только уникальные цифры
// ---------------------------------------------------------------------------
const TEMPLATES = {
  // German squads (chain: 468 → 467 → 447 → 436; 548 → 447 → 436)
  'ge_468': { ...GermanSquad_1st, quality: 'Elite',     firepower: 4, range: 6, morale: 8, brokenMorale: 8, src: './graf/ge468S.gif', brokenSrc: './graf/ge468Saeb.gif', halfSquad: 'ge_248', lowerQuality: 'ge_467' },
  'ge_548': { ...GermanSquad_1st, quality: 'Elite',     firepower: 5, range: 4, morale: 8, brokenMorale: 8, src: './graf/ge548S.gif', brokenSrc: './graf/ge468Saeb.gif', halfSquad: 'ge_238', lowerQuality: 'ge_447' },
  'ge_467': { ...GermanSquad_1st, quality: '1stLine',   firepower: 4, range: 6, morale: 7, brokenMorale: 7, src: './graf/ge467S.gif', brokenSrc: './graf/geh7b.gif',     halfSquad: 'ge_247', lowerQuality: 'ge_447', smokeExponent: 4 },
  'ge_447': { ...GermanSquad_1st, quality: '2ndLine',   firepower: 4, range: 4, morale: 7, brokenMorale: 7, src: './graf/ge447S.gif', brokenSrc: './graf/geh7b.gif',     halfSquad: 'ge_237', lowerQuality: 'ge_436' },
  'ge_436': { ...GermanSquad_1st, quality: 'Conscript', firepower: 4, range: 3, morale: 6, brokenMorale: 6, src: './graf/ge436S.gif', brokenSrc: './graf/geh6b.gif',     halfSquad: 'ge_236' },

  // German half-squads (chain: 248 → 247 → 237 → 236; 238 → 237 → 236)
  'ge_248': { ...GermanSquad_1st, quality: 'Elite',     firepower: 2, range: 4, morale: 8, brokenMorale: 8, size: 'halfSquad', src: './graf/ge248H.gif', brokenSrc: './graf/ge248Haeb.gif', lowerQuality: 'ge_247' },
  'ge_238': { ...GermanSquad_1st, quality: 'Elite',     firepower: 2, range: 3, morale: 8, brokenMorale: 8, size: 'halfSquad', src: './graf/ge238H.gif', brokenSrc: './graf/ge248Haeb.gif', lowerQuality: 'ge_237' },
  'ge_247': { ...GermanSquad_1st, quality: '1stLine',   firepower: 2, range: 4, morale: 7, brokenMorale: 7, size: 'halfSquad', src: './graf/ge247H.gif', brokenSrc: './graf/geh7b.gif',     lowerQuality: 'ge_237' },
  'ge_237': { ...GermanSquad_1st, quality: '2ndLine',   firepower: 2, range: 3, morale: 7, brokenMorale: 7, size: 'halfSquad', src: './graf/ge237H.gif', brokenSrc: './graf/geh7b.gif',     lowerQuality: 'ge_236' },
  'ge_236': { ...GermanSquad_1st, quality: 'Conscript', firepower: 2, range: 3, morale: 6, brokenMorale: 6, size: 'halfSquad', src: './graf/ge236H.gif', brokenSrc: './graf/geh6b.gif' },

  // Soviet squads (chain: 458 → 447 → 426; 628 → 527 → 426)
  'so_458': { ...SovietSquad_Elite, quality: 'Elite',     firepower: 4, range: 5, morale: 8, brokenMorale: 8, src: './graf/ru458S.gif', brokenSrc: './graf/ruH8b.gif', halfSquad: 'so_248', lowerQuality: 'so_447' },
  'so_628': { ...SovietSquad_Elite, quality: 'Elite',     firepower: 6, range: 2, morale: 8, brokenMorale: 8, src: './graf/ru628S.gif', brokenSrc: './graf/ruH8b.gif', halfSquad: 'so_328', lowerQuality: 'so_527' },
  'so_447': { ...SovietSquad_Elite, quality: '1stLine',   firepower: 4, range: 4, morale: 7, brokenMorale: 7, src: './graf/ru447S.gif', brokenSrc: './graf/ruh7b.gif', halfSquad: 'so_237', lowerQuality: 'so_426' },
  'so_527': { ...SovietSquad_Elite, quality: '1stLine',   firepower: 5, range: 2, morale: 7, brokenMorale: 7, src: './graf/ru527S.gif', brokenSrc: './graf/ruh7b.gif', halfSquad: 'so_227', lowerQuality: 'so_426' },
  'so_426': { ...SovietSquad_Elite, quality: 'Conscript', firepower: 4, range: 2, morale: 6, brokenMorale: 6, src: './graf/ru426S.gif', brokenSrc: './graf/ruh6b.gif', halfSquad: 'so_226' },

  // Soviet half-squads (chain: 248 → 237 → 226; 328 → 227 → 226)
  'so_248': { ...SovietSquad_Elite, quality: 'Elite',     firepower: 2, range: 4, morale: 8, brokenMorale: 8, size: 'halfSquad', src: './graf/ru248H.gif', brokenSrc: './graf/ruH8b.gif', lowerQuality: 'so_237' },
  'so_328': { ...SovietSquad_Elite, quality: 'Elite',     firepower: 3, range: 2, morale: 8, brokenMorale: 8, size: 'halfSquad', src: './graf/ru328H.gif', brokenSrc: './graf/ruH8b.gif', lowerQuality: 'so_227' },
  'so_237': { ...SovietSquad_Elite, quality: '1stLine',   firepower: 2, range: 3, morale: 7, brokenMorale: 7, size: 'halfSquad', src: './graf/ru237H.gif', brokenSrc: './graf/ruh7b.gif', lowerQuality: 'so_226' },
  'so_227': { ...SovietSquad_Elite, quality: '1stLine',   firepower: 2, range: 2, morale: 7, brokenMorale: 7, size: 'halfSquad', src: './graf/ru227H.gif', brokenSrc: './graf/ruh7b.gif', lowerQuality: 'so_226' },
  'so_226': { ...SovietSquad_Elite, quality: 'Conscript', firepower: 2, range: 2, morale: 6, brokenMorale: 6, size: 'halfSquad', src: './graf/ru226H.gif', brokenSrc: './graf/ruh6b.gif' },

  'ge_L91': { ...GermanLeader, morale: 9, brokenMorale: 9, leadershipModifier: -1, selfRally: true, src: './graf/geL91.gif', brokenSrc: './graf/geL91b.gif' },
  'ge_L81': { ...GermanLeader, morale: 8, brokenMorale: 8, leadershipModifier: -1, selfRally: true, src: './graf/geL81.gif', brokenSrc: './graf/geL81b.gif' },
  'ge_L80': { ...GermanLeader, morale: 8, brokenMorale: 8, leadershipModifier:  0, selfRally: true, src: './graf/geL80.gif', brokenSrc: './graf/geL80b.gif' },
  'ge_L70': { ...GermanLeader, morale: 7, brokenMorale: 7, leadershipModifier:  0, selfRally: true, src: './graf/geL70.gif', brokenSrc: './graf/geL70b.gif' },
  'so_L61': { ...SovietLeader, morale: 6, brokenMorale: 6, leadershipModifier: -1, selfRally: true, src: './graf/ruL61.gif', brokenSrc: './graf/ruL61b.gif' },
  'so_L81': { ...SovietLeader, morale: 8, brokenMorale: 8, leadershipModifier: -1, selfRally: true, src: './graf/ruL81.gif', brokenSrc: './graf/ruL81b.gif' },

  // American squads / HS (elr=20 explicit — не подвержены quality reduce в этом сценарии)
  'am_667': { ...AmericanSquad, quality: 'Elite',   firepower: 6, range: 6, morale: 7, brokenMorale: 7, smokeExponent: 3, elr: 20, lowerQuality: null, halfSquad: 'am_347', src: './graf/am667S.gif', brokenSrc: './graf/amc7b.gif' },
  'am_347': { ...AmericanSquad, quality: 'Elite',   firepower: 3, range: 4, morale: 7, brokenMorale: 7, size: 'halfSquad', src: './graf/am347H.gif', brokenSrc: './graf/amc7b.gif' },
  'am_536': { ...AmericanSquad, quality: '2ndLine', firepower: 5, range: 3, morale: 6, brokenMorale: 6, elr: 20, lowerQuality: null, halfSquad: 'am_226', src: './graf/am536S.gif', brokenSrc: './graf/amh6b.gif' },
  'am_226': { ...AmericanSquad, quality: '2ndLine', firepower: 2, range: 2, morale: 6, brokenMorale: 6, size: 'halfSquad', src: './graf/am226H.gif', brokenSrc: './graf/amh6b.gif' },

  // American leaders
  'am_L92': { ...AmericanLeader, morale: 9, brokenMorale: 9, leadershipModifier: -2, selfRally: true, src: './graf/amL92.gif', brokenSrc: './graf/amL92b.gif' },
  'am_L81': { ...AmericanLeader, morale: 8, brokenMorale: 8, leadershipModifier: -1, selfRally: true, src: './graf/amL81.gif', brokenSrc: './graf/amL81b.gif' },

  // --- Оружие ---
  'ru_LMG': { ...MG, nation: 'soviet', firepower: 2, range: 6,
              breakdownNumber: 11, rof: 1, repairNumber: 2, portagePoints: 1,
              src: './graf/ruLMG.gif', brokenSrc: './graf/ruLMGb.gif' },
  'ge_HMG': { ...MG, nation: 'german', firepower: 7, range: 16,
              breakdownNumber: 12, rof: 3, repairNumber: 3, portagePoints: 4,
              src: './graf/geHMG.gif', brokenSrc: './graf/geHMGb.gif' },
  'ge_LMG': { ...MG, nation: 'german', firepower: 3, range: 8,
              breakdownNumber: 12, rof: 1, repairNumber: 1, portagePoints: 1,
              src: './graf/geLMG.gif', brokenSrc: './graf/geLMGb.gif' },
  'ge_MMG': { ...MG, nation: 'german', firepower: 5, range: 12,
              breakdownNumber: 12, rof: 2, repairNumber: 2, portagePoints: 3,
              src: './graf/geMMG.gif', brokenSrc: './graf/geMMGb.gif' },
  'am_MMG': { ...MG, nation: 'american', firepower: 5, range: 12,
              breakdownNumber: 12, rof: 2, repairNumber: 2, portagePoints: 3,
              src: './graf/amMMG.gif', brokenSrc: './graf/amMMGb.gif' },
};

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload  = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${src}`));
    img.src = src;
  });
}

// ---------------------------------------------------------------------------
// Создание одного юнита
// ---------------------------------------------------------------------------
function createUnit(data, layer) {

  const w = data.image.width;
  const h = data.image.height;

  // группа = картинка + индикатор moved
  const group = new Konva.Group({ x: data.x, y: data.y });
  const image = new Konva.Image({ image: data.image, x: 0, y: 0 });
  
  const movedRect = new Konva.Rect({
    x: 0, y: h - 8,
    width: w, height: 8,
    fill: 'red',
    visible: false,
    name: 'movedRect',
  });

  const movedText = new Konva.Text({
    x: 0, y: h - 8,
    width: w, height: 8,
    text: 'moved', fill: 'white', fontSize: 7,
    align: 'center', verticalAlign: 'middle',
    visible: false,
    name: 'movedText',
  });

  const activeRect = new Konva.Rect({
    x: 0, y: h - 8,
    width: w, height: 8,
    fill: 'goldenrod',
    visible: false,
    name: 'activeRect',
  });

  const activeText = new Konva.Text({
    x: 0, y: h - 8,
    width: w, height: 8,
    text: 'active', fill: 'white', fontSize: 7,
    align: 'center', verticalAlign: 'middle',
    visible: false,
    name: 'activeText',
  });

  const selectRect = new Konva.Rect({
  x: 0, y: 0,
  width: w, height: h,
  stroke: 'red',
  strokeWidth: 1,
  visible: false,
  name: 'selectRect',
  listening: false,
});

const addToMovementGroupRect = new Konva.Rect({
    x: 0, y: 0,
  width: w, height: h,
  stroke: 'red',
  strokeWidth: 1,
  visible: false,
  name: 'addToMovementGroupRect',
  listening: false,
});

const addToFireGroupRect = new Konva.Rect({
      x: 0, y: 0,
  width: w, height: h,
  stroke: 'red',
  strokeWidth: 1,
  visible: false,
  name: 'addToFireGroupRect',
  listening: false,
});

const cxText = new Konva.Text({
    x: w - 12, y: 1,
    text: 'CX', fill: 'red', fontSize: 8, fontStyle: 'bold',
    visible: false,
    name: 'cxText',
    listening: false,
});

const pinBg = new Konva.Rect({
    x: 0, y: 0,
    width: 18, height: 10,
    fill: 'white',
    visible: false,
    name: 'pinBg',
    listening: false,
});

const pinText = new Konva.Text({
    x: 1, y: 1,
    text: 'pin', fill: 'red', fontSize: 8, fontStyle: 'bold',
    visible: false,
    name: 'pinText',
    listening: false,
});

const dmText = new Konva.Text({
    x: (w - 34) / 2, y: (h - 12) / 2 + 2,
    width: 34, height: 8,
    text: 'DM+4', fill: 'red', fontSize: 9, fontStyle: 'bold',
    align: 'center', verticalAlign: 'middle',
    visible: false,
    name: 'dmText',
    listening: false,
});

const woundedRect = new Konva.Rect({
    x: 0, y: 0,
    width: w, height: 8,
    fill: 'white',
    visible: false,
    name: 'woundedRect',
    listening: false,
});
const woundedCross = new Konva.Text({
    x: 1, y: -2,
    text: '+', fill: 'red', fontSize: 12, fontStyle: 'bold',
    visible: false,
    name: 'woundedCross',
    listening: false,
});
const woundedText = new Konva.Text({
    x: 0, y: 0,
    width: w, height: 8,
    text: 'wound', fill: 'red', fontSize: 7, fontStyle: 'bold',
    align: 'center', verticalAlign: 'middle',
    visible: false,
    name: 'woundedText',
    listening: false,
});

const ffRect = new Konva.Rect({
    x: 0, y: h - 8,
    width: w, height: 8,
    fill: 'white',
    visible: false,
    name: 'ffRect',
    listening: false,
});
const ffText = new Konva.Text({
    x: 0, y: h - 8,
    width: w, height: 8,
    text: 'first fire', fill: 'red', fontSize: 7, fontStyle: 'bold',
    align: 'center', verticalAlign: 'middle',
    visible: false,
    name: 'ffText',
    listening: false,
});
const ffBigText = new Konva.Text({
    x: 0, y: 0,
    width: w, height: h,
    text: 'FF', fill: 'red', fontSize: Math.floor(w * 0.7), fontStyle: 'bold',
    align: 'center', verticalAlign: 'middle',
    visible: false,
    name: 'ffBigText',
    listening: false,
});

const pfText = new Konva.Text({
    x: 0, y: 0,
    width: w, height: h,
    text: 'PF', fill: 'orange', fontSize: Math.floor(w * 0.5), fontStyle: 'bold',
    align: 'center', verticalAlign: 'middle',
    visible: false,
    name: 'pfText',
    listening: false,
});

    group.add(image, movedRect, movedText, activeRect, activeText, selectRect, addToMovementGroupRect, addToFireGroupRect, cxText, pinBg, pinText, dmText, woundedRect, woundedCross, woundedText, ffRect, ffText, ffBigText, pfText);
    
    const unit = { ...data, node: group };

    group.setAttr('unitId', unit.id);
    image.setAttr('unitId', unit.id);   // клики попадают на image — нужен и тут
    movedRect.listening(false);          // декоративные — клики не ловят
    movedText.listening(false);
    activeRect.listening(false);
    activeText.listening(false);
    selectRect.listening(false);
      addToMovementGroupRect.listening(false);
      addToFireGroupRect.listening(false);


    State.addUnit(unit);
    layer.add(group);

    // предзагрузка broken-графики
    if (data.brokenSrc) {
        loadImage(data.brokenSrc).then(img => { unit.brokenImage = img; });
    }

    return unit;

}

// ---------------------------------------------------------------------------
// Создаём и загружаем все юниты сценария
// ---------------------------------------------------------------------------
export async function createAndLoadUnits(layer, scenarioUnits) {
    for (const record of scenarioUnits) {
        const tmpl = TEMPLATES[record.templateId];

        // Для carried с possessorId hex берётся от possessor'а
        const resolvedHex = record.possessorId
            ? State.units[record.possessorId]?.hex
            : record.hex;

        const template = {
            ...tmpl,
            id: record.id,
            side: record.side,   // 'attacker' | 'defender' — из сценария
            hex: resolvedHex,
            path: [{ hex: resolvedHex, isRoad: Rules._isRoadHex(resolvedHex) }],
        };
        if (record.possessorId) template.possessorId = record.possessorId;

        // ELR per-unit: юниты без lowerQuality (Conscript, leader) не подвержены quality reduce
        template.elr = tmpl.lowerQuality ? (State.elr[tmpl.nation] ?? 3) : 20;

        const image    = await loadImage(template.src);
        const { x, y } = hexToPixel(resolvedHex.col, resolvedHex.row);
        const cx       = x - image.width  / 2;
        const cy       = y - image.height / 2;
        createUnit({ ...template, image, x: cx, y: cy }, layer);

        // предзагрузка half-squad картинок (для мгновенной замены)
        const hsId = tmpl.halfSquad;
        if (hsId) {
            const hs = TEMPLATES[hsId];
            if (hs.src) loadImage(hs.src);
            if (hs.brokenSrc) loadImage(hs.brokenSrc);
        }
    }
}

// Создать юнит из шаблона в указанном гексе — для замены на HS и т.п.
export async function spawn_unit(templateId, id, hex, layer, side = null) {
    const template = { ...TEMPLATES[templateId], id, hex, side,
                       path: [{ hex, isRoad: Rules._isRoadHex(hex) }] };
    template.elr   = template.lowerQuality ? (State.elr[template.nation] ?? 3) : 20;
    const image    = await loadImage(template.src);
    const { x, y } = hexToPixel(hex.col, hex.row);
    const cx       = x - image.width / 2;
    const cy       = y - image.height / 2;
    return createUnit({ ...template, image, x: cx, y: cy }, layer);
}
