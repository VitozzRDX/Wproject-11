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
                                    mf_spent_in_current_hex: 0 };
const Squad            = { ...Infantry, type: 'squad', mf: 4, leaderBonus: 2, firingStatus: ' ' };
const Leader           = { ...Infantry, type: 'leader', mf: 6, quality: 'Elite' };
const GermanSquad_1st  = { ...Squad,  nation: 'german', quality: '1stLine', selfRally: true  };
const SovietSquad_Elite= { ...Squad,  nation: 'soviet', quality: 'Elite',   selfRally: true  };
const GermanLeader     = { ...Leader, nation: 'german' };
const SovietLeader     = { ...Leader, nation: 'soviet' };

// --- Ветвь: переносимые предметы (SW, guns) — требуют possessor ---
const CarriedItem      = { ...Unit, category: 'carried',
                                    possessorId: null,
                                    broken: false };      // weapon-jam / malfunction (B# сработал)
const SW               = { ...CarriedItem, type: 'SW', firingStatus: ' ' };
const MG               = { ...SW, kind: 'MG' };

// ---------------------------------------------------------------------------
// Шаблоны — только уникальные цифры
// ---------------------------------------------------------------------------
const TEMPLATES = {
  'ge_467': { ...GermanSquad_1st, firepower: 4, range: 6, morale: 7, brokenMorale: 7, src: './graf/ge467S.gif', brokenSrc: './graf/geh7b.gif', halfSquad: 'ge_247' },
  'ge_247': { ...GermanSquad_1st, firepower: 2, range: 4, morale: 7, brokenMorale: 7, size: 'halfSquad', src: './graf/ge247H.gif', brokenSrc: './graf/geh6b.gif' },
  'so_628': { ...SovietSquad_Elite, firepower: 6, range: 2, morale: 8, brokenMorale: 8, src: './graf/ru628S.gif', brokenSrc: './graf/ruH8b.gif', halfSquad: 'so_328' },
  'so_328': { ...SovietSquad_Elite, firepower: 3, range: 2, morale: 8, brokenMorale: 8, size: 'halfSquad', src: './graf/ru328H.gif' },
  'ge_L91': { ...GermanLeader, morale: 9, brokenMorale: 9, leadershipModifier: -1, selfRally: true, src: './graf/geL91.gif', brokenSrc: './graf/geL91b.gif' },
  'ge_L81': { ...GermanLeader, morale: 8, brokenMorale: 8, leadershipModifier: -1, selfRally: true, src: './graf/geL81.gif', brokenSrc: './graf/geL81b.gif' },
  'so_L61': { ...SovietLeader, morale: 6, brokenMorale: 6, leadershipModifier: -1, selfRally: true, src: './graf/ruL61.gif', brokenSrc: './graf/ruL61b.gif' },

  // --- Оружие ---
  'ru_LMG': { ...MG, nation: 'soviet', firepower: 2, range: 6,
              breakdownNumber: 11, rof: 1, repairNumber: 2,
              src: './graf/ruLMG.gif', brokenSrc: './graf/ruLMGb.gif' },
  'ge_HMG': { ...MG, nation: 'german', firepower: 7, range: 16,
              breakdownNumber: 12, rof: 3, repairNumber: 3,
              src: './graf/geHMG.gif', brokenSrc: './graf/geHMGb.gif' },
};

// ---------------------------------------------------------------------------
// Сценарий
// ---------------------------------------------------------------------------
const scenario = [
  { templateId: 'ge_467', id: 'unit_01', hex: { col: 3, row: 2 } },
  { templateId: 'ge_467', id: 'unit_02', hex: { col: 5, row: 2 } },
  { templateId: 'ge_467', id: 'unit_03', hex: { col: 5, row: 2 } },
  { templateId: 'ge_467', id: 'unit_04', hex: { col: 5, row: 2 } },
  { templateId: 'ge_L81', id: 'unit_L81', hex: { col: 5, row: 2 } },
  { templateId: 'ge_L91', id: 'unit_L91', hex: { col: 5, row: 2 } },
  { templateId: 'ge_L91', id: 'unit_05', hex: { col: 6, row: 3 } },
  { templateId: 'ge_467', id: 'unit_06', hex: { col: 6, row: 3 } },
  { templateId: 'ge_467', id: 'unit_N6', hex: { col: 13, row: 6 } },
  { templateId: 'so_628', id: 'unit_11', hex: { col: 5, row: 6 } },
  { templateId: 'so_628', id: 'unit_12', hex: { col: 5, row: 5 } },

  // тест FG ряд 1: squad — leader — squad (соседние гексы)
  { templateId: 'so_628', id: 'fg_r1_a', hex: { col: 1, row: 7 } },
  { templateId: 'so_L61', id: 'fg_r1_b', hex: { col: 2, row: 7 } },
  { templateId: 'so_628', id: 'fg_r1_c', hex: { col: 3, row: 7 } },

  // тест FG ряд 2: (sq+sq+L) — (sq+L) — sq
  { templateId: 'so_628', id: 'fg_r2_a1', hex: { col: 5, row: 7 } },
  { templateId: 'so_628', id: 'fg_r2_a2', hex: { col: 5, row: 7 } },
  { templateId: 'so_L61', id: 'fg_r2_a3', hex: { col: 5, row: 7 } },

  { templateId: 'so_628', id: 'fg_r2_b1', hex: { col: 6, row: 7 } },
  { templateId: 'so_L61', id: 'fg_r2_b2', hex: { col: 6, row: 7 } },

  { templateId: 'so_628', id: 'fg_r2_c',  hex: { col: 7, row: 7 } },
  { templateId: 'so_628', id: 'unit_M11', hex: { col: 12, row: 11 } },
  { templateId: 'ge_467', id: 'unit_vN5', hex: { col: 13, row: 5 } },
  { templateId: 'so_628', id: 'unit_vI8', hex: { col: 8, row: 8 } },
  { templateId: 'so_628', id: 'unit_vG9', hex: { col: 6, row: 9 } },
  { templateId: 'so_628', id: 'unit_uAG5', hex: { col: -1, row: 5 } },
  { templateId: 'ge_467', id: 'unit_uAF7', hex: { col: -2, row: 7 } },
  { templateId: 'ge_467', id: 'unit_uAC3', hex: { col: -5, row: 3 } },
  { templateId: 'so_628', id: 'unit_vC5', hex: { col: 2, row: 5 } },
  { templateId: 'so_628', id: 'unit_vG5', hex: { col: 6, row: 5 } },

  // оружие
  { templateId: 'ge_HMG', id: 'geHMG_vG3', possessorId: 'unit_06' },
  { templateId: 'ru_LMG', id: 'ruLMG_vG5', possessorId: 'unit_vG5' },
  { templateId: 'ru_LMG', id: 'ruLMG_vF7', possessorId: 'fg_r2_a1' },
]

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

    group.add(image, movedRect, movedText, activeRect, activeText, selectRect, addToMovementGroupRect, addToFireGroupRect, cxText, pinBg, pinText, dmText, woundedRect, woundedCross, woundedText, ffRect, ffText, ffBigText);
    
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
export async function createAndLoadUnits(layer) {
    for (const record of scenario) {
        const tmpl = TEMPLATES[record.templateId];

        // Для carried с possessorId hex берётся от possessor'а
        const resolvedHex = record.possessorId
            ? State.units[record.possessorId]?.hex
            : record.hex;

        const template = {
            ...tmpl,
            id: record.id,
            hex: resolvedHex,
            path: [{ hex: resolvedHex, isRoad: Rules._isRoadHex(resolvedHex) }],
        };
        if (record.possessorId) template.possessorId = record.possessorId;

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
export async function spawn_unit(templateId, id, hex, layer) {
    const template = { ...TEMPLATES[templateId], id, hex,
                       path: [{ hex, isRoad: Rules._isRoadHex(hex) }] };
    const image    = await loadImage(template.src);
    const { x, y } = hexToPixel(hex.col, hex.row);
    const cx       = x - image.width / 2;
    const cy       = y - image.height / 2;
    return createUnit({ ...template, image, x: cx, y: cy }, layer);
}
