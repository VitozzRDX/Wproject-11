import { hexDistance, hexLabel, hexToPixel, pixelToHex } from './hexUtils.js';
import { hexMap } from './hexmap.js';

// ===========================================================================
// IFT (Infantry Fire Table)
// ===========================================================================
const IFT = {
    1:  [[1,'KIA'],[1,'K/'],[1,'MC'],[1,'MC'],[0,'MC'],[0,'PTC']],
    2:  [[2,'KIA'],[1,'KIA'],[1,'K/'],[1,'MC'],[1,'MC'],[0,'MC'],[0,'PTC']],
    4:  [[2,'KIA'],[1,'KIA'],[2,'K/'],[2,'MC'],[1,'MC'],[1,'MC'],[0,'MC'],[0,'PTC']],
    6:  [[3,'KIA'],[2,'KIA'],[1,'KIA'],[2,'K/'],[2,'MC'],[1,'MC'],[1,'MC'],[0,'MC'],[0,'PTC']],
    8:  [[3,'KIA'],[2,'KIA'],[1,'KIA'],[2,'K/'],[2,'MC'],[2,'MC'],[1,'MC'],[1,'MC'],[0,'MC'],[0,'PTC']],
    12: [[3,'KIA'],[2,'KIA'],[1,'KIA'],[3,'K/'],[3,'MC'],[2,'MC'],[2,'MC'],[1,'MC'],[1,'MC'],[0,'MC'],[0,'PTC']],
    16: [[4,'KIA'],[3,'KIA'],[2,'KIA'],[1,'KIA'],[3,'K/'],[3,'MC'],[2,'MC'],[2,'MC'],[1,'MC'],[1,'MC'],[0,'MC'],[0,'PTC']],
    20: [[4,'KIA'],[3,'KIA'],[2,'KIA'],[1,'KIA'],[4,'K/'],[4,'MC'],[3,'MC'],[2,'MC'],[2,'MC'],[1,'MC'],[1,'MC'],[0,'MC'],[0,'PTC']],
    24: [[5,'KIA'],[4,'KIA'],[3,'KIA'],[2,'KIA'],[1,'KIA'],[4,'K/'],[4,'MC'],[3,'MC'],[2,'MC'],[2,'MC'],[1,'MC'],[1,'MC'],[0,'MC'],[0,'PTC']],
    30: [[6,'KIA'],[5,'KIA'],[4,'KIA'],[3,'KIA'],[2,'KIA'],[1,'KIA'],[4,'K/'],[4,'MC'],[3,'MC'],[2,'MC'],[2,'MC'],[1,'MC'],[1,'MC'],[0,'MC'],[0,'PTC']],
    36: [[7,'KIA'],[6,'KIA'],[5,'KIA'],[4,'KIA'],[3,'KIA'],[2,'KIA'],[1,'KIA'],[4,'K/'],[4,'MC'],[3,'MC'],[2,'MC'],[2,'MC'],[1,'MC'],[1,'MC'],[0,'MC'],[0,'PTC']],
};
const IFT_COLUMNS = [1, 2, 4, 6, 8, 12, 16, 20, 24, 30, 36];

function getIFTColumn(fp) {
    let col = 1;
    for (const c of IFT_COLUMNS) {
        if (c <= fp) col = c;
        else break;
    }
    return col;
}

let rollQueue = null;
export function setRollQueue(arr) { rollQueue = arr ? [...arr] : null; }

function roll2d6() {
    if (rollQueue) {
        const a = rollQueue.shift();
        const b = rollQueue.shift();
        return a + b;
    }
    return (Math.floor(Math.random()*6)+1) + (Math.floor(Math.random()*6)+1);
}
function rollD6() {
    if (rollQueue) return rollQueue.shift();
    return Math.floor(Math.random()*6) + 1;
}

// ===========================================================================
// TEM (Terrain Effects Modifier)
// ===========================================================================
const TEM = {
    forest:         1,
    woodenBuilding: 2,
    stoneBuilding:  3,
    brush:          0,
    orchard:        0,
    hill:           0,
    dirtRoad:       0,
    pavedRoad:      0,
};

function calcTEM(hex) {
    const terrain = hexMap[hexLabel(hex.col, hex.row)] || [];
    if (terrain.length === 0) return 0;
    return Math.max(0, ...terrain.map(t => TEM[t] ?? 0));
}

// ===========================================================================
// Firepower
// ===========================================================================
function calcFirepower(unit, targetHex) {
    if (unit.type === 'leader') return 0;   // лидер сам по себе не стреляет
    const dist = hexDistance(unit.hex, targetHex);
    const fp   = unit.pinned ? unit.firepower / 2 : unit.firepower;
    const rng  = unit.range;
    if (dist > rng * 2) return 0;
    if (dist === 1)     return fp * 2;   // Point Blank Fire
    if (dist <= rng)    return fp;
    return fp / 2;                        // long range
}

function calcTotalFirepower(units, targetHex) {
    return units.reduce((s, u) => s + calcFirepower(u, targetHex), 0);
}

// ===========================================================================
// Elevation + Height Advantage
// ===========================================================================
function calcElevation(hex) {
    const terrain = hexMap[hexLabel(hex.col, hex.row)] || [];
    return (terrain.includes('hill') || terrain.includes('crestLine')) ? 1 : 0;
}

function calcHeightAdvantage(shooters, targetHex) {
    if (shooters.length === 0) return 0;
    const targetElev = calcElevation(targetHex);
    const minShooterElev = Math.min(...shooters.map(u => calcElevation(u.hex)));
    if (minShooterElev >= targetElev) return 0;
    if (calcTEM(targetHex) > 0)       return 0;
    return 1;
}

// ===========================================================================
// Hindrance + LOS
// ===========================================================================
const HINDRANCE_TERRAINS = ['orchard', 'grain', 'brush'];

function getHexToHexArray(fromHex, toHex) {
    const start = hexToPixel(fromHex.col, fromHex.row);
    const end   = hexToPixel(toHex.col, toHex.row);
    const steps = 50;
    const hexSet = new Set();
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = start.x + (end.x - start.x) * t;
        const y = start.y + (end.y - start.y) * t;
        const epsilon = 0.5;
        [
            pixelToHex(x, y),
            pixelToHex(x, y + epsilon),
            pixelToHex(x, y - epsilon),
        ].forEach(h => hexSet.add(`${h.col}-${h.row}`));
    }
    hexSet.delete(`${fromHex.col}-${fromHex.row}`);
    hexSet.delete(`${toHex.col}-${toHex.row}`);
    return [...hexSet].map(key => {
        const [col, row] = key.split('-').map(Number);
        return { col, row };
    });
}

function isTreeLinedRoad(fromHex, toHex, intermediate) {
    const hasRoad = h => {
        const terrain = hexMap[hexLabel(h.col, h.row)] || [];
        return terrain.includes('dirtRoad') || terrain.includes('pavedRoad');
    };
    return [fromHex, toHex, ...intermediate].every(hasRoad);
}

function checkHindrance(shooters, targetHex) {
    if (shooters.length === 0) return 0;
    return Math.max(...shooters.map(shooter => {
        const intermediate = getHexToHexArray(shooter.hex, targetHex);
        if (isTreeLinedRoad(shooter.hex, targetHex, intermediate)) return 0;
        let total = 0;
        for (const h of intermediate) {
            const terrain = hexMap[hexLabel(h.col, h.row)] || [];
            for (const t of terrain) {
                if (HINDRANCE_TERRAINS.includes(t)) total += 1;
            }
        }
        return total;
    }));
}

function checkLOS(shooters, targetHex) {
    return checkHindrance(shooters, targetHex) < 6;
}

// ===========================================================================
// FFNAM / FFMO
// ===========================================================================
function calcFFNAM(unit) {
    if (!unit.hasStartedMoving) return 0;
    if (unit.broken)            return -1;
    if (unit.pinned)            return 0;
    if (unit.assaultMovement)   return 0;
    return -1;
}

function calcFFMO(unit, targetHex) {
    if (!unit.hasStartedMoving) return 0;
    if (unit.pinned)            return 0;
    if (calcTEM(targetHex) > 0) return 0;
    // orchard не Open Ground — тоже отменяет FFMO
    const terrain = hexMap[hexLabel(targetHex.col, targetHex.row)] || [];
    if (terrain.includes('orchard')) return 0;
    return -1;
}

// ===========================================================================
// Leadership DRM (3.2.2)
// ===========================================================================
function calcLeadershipDRM(firegroupUnits) {
    const leaders = firegroupUnits.filter(u => u.type === 'leader' && !u.pinned);
    if (leaders.length === 0) return 0;

    const fgHexes     = new Set(firegroupUnits.map(u => hexLabel(u.hex.col, u.hex.row)));
    const leaderHexes = new Set(leaders.map(l => hexLabel(l.hex.col, l.hex.row)));

    // Case 1: single-hex FG → максимальный бонус (самый негативный)
    if (fgHexes.size === 1) {
        return Math.min(...leaders.map(l => l.leadershipModifier ?? 0));
    }

    // Case 2: multi-hex — нужен лидер в каждом гексе
    const allHexesHaveLeader = [...fgHexes].every(h => leaderHexes.has(h));
    if (!allHexesHaveLeader) return 0;

    // наименьший бонус (ближайший к 0)
    return Math.max(...leaders.map(l => l.leadershipModifier ?? 0));
}

// ===========================================================================
// Fire Effect + apply
// ===========================================================================
function calcFireEffect(units, targetHex, drm = 0) {
    const fp  = calcTotalFirepower(units, targetHex);
    const col = getIFTColumn(fp);
    const arr = IFT[col];
    const dr  = roll2d6();
    // rawIdx = бросок + модификатор. Может уйти ниже 0 при большом отрицательном DRM
    // (много бонусов, например FFNAM+FFMO+leadership). По ASL это лучший результат
    // на колонке — клампим к arr[0].
    const rawIdx = dr + drm;
    const idx = Math.max(0, rawIdx);
    console.log(`[calcFireEffect] FP=${fp}, col=${col}, DR=${dr}, DRM=${drm}, idx=${idx}`);
    // idx >= длины массива → промах (слишком высокий финальный бросок)
    if (idx >= arr.length) {
        console.log(`[calcFireEffect] промах (idx ${idx} >= length ${arr.length})`);
        return false;
    }
    console.log(`[calcFireEffect] результат:`, arr[idx]);
    return arr[idx];
}

// Обработка MC для группы целей.
// Лидеры проверяются первыми (лучший по морали → худший), каждый использует
// накопленный лидер-DRM от прошедших unharmed. Non-leaders — с полным DRM.
function _processMC(targets, k, result) {
    // Сортировка лидеров по эффективной морали (broken → brokenMorale)
    const effMorale = u => u.broken ? u.brokenMorale : u.morale;
    const leaders    = targets.filter(u => u.type === 'leader').sort((a,b) => effMorale(b) - effMorale(a));
    const nonLeaders = targets.filter(u => u.type !== 'leader');

    let leaderDRM = 0;   // накопленный лидер-DRM для последующих юнитов

    const rollMC = (u, drm) => {
        // юнит уже устранён этим огнём — не роллит
        const inProgress = result[u.id];
        if (inProgress === 'eliminated') return null;
        const morale  = effMorale(u);
        const baseDr  = roll2d6();
        const finalDr = baseDr + k + drm;

        // Broken юниты тоже проходят MC. Провал → Casualty Reduction:
        //   leader → wound severity (_woundLeader)
        //   halfSquad/crew → eliminated
        //   squad → reduced (→ HS)
        if (u.broken) {
            console.log(`[MC broken] ${u.id}: DR=${baseDr}, k=${k}, leaderDRM=${drm}, итог=${finalDr}, brokenMorale=${morale}`);
            if (finalDr > morale) {
                if (u.type === 'leader')                          return _woundLeader(u);
                if (u.size === 'halfSquad' || u.size === 'crew')  return 'eliminated';
                return 'reduced';
            }
            return 'ok';
        }

        console.log(`[MC] ${u.id}: DR=${baseDr}, k=${k}, leaderDRM=${drm}, итог=${finalDr}, morale=${morale} → ${
            finalDr > morale ? 'broken' :
            finalDr === morale ? 'pinned' : 'ok'
        }`);
        if (finalDr > morale)                     return 'broken';
        if (finalDr === morale && !u.pinned)      return 'pinned';
        return 'ok';
    };

    leaders.forEach(u => {
        const outcome = rollMC(u, leaderDRM);
        if (outcome === null) return;
        if (outcome !== 'ok') result[u.id] = outcome;
        // прошёл unharmed И не broken → его leadership DRM в пул для остальных.
        // (broken лидер не помогает; wound уже был применён мутацией u.leadershipModifier)
        if (outcome === 'ok' && !u.pinned && !u.broken) {
            leaderDRM = Math.min(leaderDRM, u.leadershipModifier ?? 0);
        }
    });

    nonLeaders.forEach(u => {
        const outcome = rollMC(u, leaderDRM);
        if (outcome === null) return;
        if (outcome !== 'ok') result[u.id] = outcome;
    });
}

// Ранение лидера (SMC casualty reduction).
// Wound severity dr: 1-4 = light wound (мораль-1, DRM+1, флаг wounded),
//                    5-6 = eliminated. Уже раненный получает +1 к severity dr.
// МУТИРУЕТ юнита: u.wounded, u.morale, u.leadershipModifier — статус wound перманентен.
function _woundLeader(u) {
    const dr = rollD6() + (u.wounded ? 1 : 0);
    console.log(`[wound severity] ${u.id}: dr=${dr}${u.wounded ? ' (+1 already wounded)' : ''}`);
    if (dr > 4) return 'eliminated';
    u.wounded = true;
    u.morale -= 1;
    u.leadershipModifier = (u.leadershipModifier ?? 0) + 1;
    console.log(`[wound light] ${u.id}: morale→${u.morale}, DRM→${u.leadershipModifier}`);
    return 'wounded';
}

// Каскадная обработка потерь лидеров (LLTC/LLMC).
// Каждый лидер триггерит свой check только один раз (Set triggered).
// Порядок: сначала LLMC (elim), потом LLTC (broken) — LLMC может создать
// новых сломанных лидеров, которые в следующей итерации попадают в LLTC.
function _checkLeaderLoss(targets, result) {
    const triggered = new Set();
    while (true) {
        const newElim   = targets.filter(u => u.type === 'leader' && result[u.id] === 'eliminated' && !triggered.has(u.id));
        const newBroken = targets.filter(u => u.type === 'leader' && result[u.id] === 'broken'     && !triggered.has(u.id));
        if (newElim.length === 0 && newBroken.length === 0) break;

        for (const leader of newElim)   { triggered.add(leader.id); _llmc(leader, targets, result); }
        for (const leader of newBroken) { triggered.add(leader.id); _lltc(leader, targets, result); }
    }
}

// Leader Loss Task Check — negative leadership DRM применяется как штраф.
// affected: юниты с эффективной моралью меньше эффективной морали сломанного лидера.
// Уже устранённых/сломанных/пиннутых этим огнём исключаем (по result[u.id]).
function _lltc(leader, targets, result) {
    const effMorale = u => u.broken ? u.brokenMorale : u.morale;
    const penalty  = -(leader.leadershipModifier ?? 0);
    const affected = targets.filter(u => {
        const s = result[u.id];
        if (s === 'eliminated' || s === 'broken' || s === 'pinned') return false;
        return effMorale(u) < effMorale(leader);
    });
    console.log(`[LLTC] leader ${leader.id} broken → PTC penalty=${penalty}, affected: ${affected.map(u=>u.id).join(',')}`);
    _processPTC(affected, penalty, result);
}

// Leader Loss Morale Check — то же самое, только NMC вместо PTC.
function _llmc(leader, targets, result) {
    const effMorale = u => u.broken ? u.brokenMorale : u.morale;
    const penalty  = -(leader.leadershipModifier ?? 0);
    const affected = targets.filter(u => {
        const s = result[u.id];
        if (s === 'eliminated' || s === 'broken' || s === 'pinned') return false;
        return effMorale(u) < effMorale(leader);
    });
    console.log(`[LLMC] leader ${leader.id} eliminated → NMC penalty=${penalty}, affected: ${affected.map(u=>u.id).join(',')}`);
    _processMC(affected, penalty, result);
}

// PTC для группы целей: лидеры первыми (лучший по морали),
// накопленный leadership DRM применяется к последующим (себе не помогает).
function _processPTC(targets, drm, result) {
    // Broken/pinned не роллят PTC (правило "Units cannot be pinned more than once per Player Turn").
    // Сортировка лидеров по эффективной морали.
    const effMorale = u => u.broken ? u.brokenMorale : u.morale;
    const leaders    = targets.filter(u => u.type === 'leader').sort((a,b) => effMorale(b) - effMorale(a));
    const nonLeaders = targets.filter(u => u.type !== 'leader');

    let leaderDRM = 0;

    const rollPTC = (u, leaderDrmForThis) => {
        if (u.broken || u.pinned) return null;
        // если результат уже установлен на этом юните в текущем applyFireEffect — не роллим повторно
        const inProgress = result[u.id];
        if (inProgress === 'broken' || inProgress === 'pinned' || inProgress === 'eliminated') return null;
        const morale = effMorale(u);
        const baseDr = roll2d6();
        const finalDr = baseDr + drm + leaderDrmForThis;
        console.log(`[PTC] ${u.id}: DR=${baseDr}, drm=${drm}, leaderDRM=${leaderDrmForThis}, итог=${finalDr}, morale=${morale} → ${finalDr > morale ? 'pinned' : 'ok'}`);
        return finalDr > morale ? 'pinned' : 'ok';
    };

    leaders.forEach(u => {
        const outcome = rollPTC(u, leaderDRM);
        if (outcome === null) return;
        if (outcome === 'pinned') result[u.id] = 'pinned';
        // прошёл unharmed → его leadership DRM в пул
        if (outcome === 'ok') {
            leaderDRM = Math.min(leaderDRM, u.leadershipModifier ?? 0);
        }
    });

    nonLeaders.forEach(u => {
        const outcome = rollPTC(u, leaderDRM);
        if (outcome === null) return;
        if (outcome === 'pinned') result[u.id] = 'pinned';
    });
}

function applyFireEffect(effect, targets) {
    const result = {};
    if (effect === false) return result;
    const [k, type] = effect;

    switch (type) {
        case 'MC': {
            _processMC(targets, k, result);
            break;
        }
        case 'PTC': {
            _processPTC(targets, 0, result);
            break;
        }
        case 'KIA': {
            const shuffled = [...targets].sort(() => Math.random() - 0.5);
            shuffled.slice(0, k).forEach(u => {
                console.log(`[KIA] ${u.id} → eliminated`);
                result[u.id] = 'eliminated';
            });
            shuffled.slice(k).forEach(u => {
                console.log(`[KIA] ${u.id} → broken (выжил)`);
                result[u.id] = 'broken';
            });
            break;
        }
        case 'K/': {
            const idx    = Math.floor(Math.random() * targets.length);
            const victim = targets[idx];
            const others = targets.filter((_, i) => i !== idx);

            if (victim.type === 'leader') {
                // единая логика ранения (в K/ и в broken-MC-fail)
                result[victim.id] = _woundLeader(victim);
            } else if (victim.size === 'halfSquad' || victim.size === 'crew') {
                console.log(`[K/ casualty] ${victim.id} → eliminated`);
                result[victim.id] = 'eliminated';
            } else {
                console.log(`[K/ casualty] ${victim.id} → reduced`);
                result[victim.id] = 'reduced';
            }
            _processMC(others, k, result);
            break;
        }
    }
    _checkLeaderLoss(targets, result);
    return result;
}

function defensiveFF(firegroupUnits, targetHex, hexUnits) {
    const los = checkLOS(firegroupUnits, targetHex);
    console.log(`[defensiveFF] LOS=${los}`);
    if (!los) {
        console.log('[defensiveFF] нет LOS — огонь невозможен');
        return { changes: {} };
    }

    const baseTem       = calcTEM(targetHex);
    const ha            = calcHeightAdvantage(firegroupUnits, targetHex);
    const tem           = baseTem > 0 ? baseTem : ha;
    const hindrance     = checkHindrance(firegroupUnits, targetHex);
    const ffnam         = hexUnits.length > 0 ? calcFFNAM(hexUnits[0]) : 0;
    const ffmoRaw       = hexUnits.length > 0 ? calcFFMO(hexUnits[0], targetHex) : 0;
    const ffmo          = (ha > 0 || hindrance > 0) ? 0 : ffmoRaw;
    const leadershipDRM = calcLeadershipDRM(firegroupUnits);
    const totalDRM      = tem + hindrance + ffnam + ffmo + leadershipDRM;

    console.log(`[defensiveFF] TEM=${tem}, HINDRANCE=${hindrance}, FFNAM=${ffnam}, FFMO=${ffmo}, LEADER=${leadershipDRM}, totalDRM=${totalDRM}`);

    const effect  = calcFireEffect(firegroupUnits, targetHex, totalDRM);
    const changes = applyFireEffect(effect, hexUnits);
    return { changes };
}

// Стоимость входа в гекс по типу террейна (MF)
const TERRAIN_COST = {
    forest:         2,
    woodenBuilding: 2,
    stoneBuilding:  2,
    brush:          2,
    orchard:        1,
    hill:           1,
    dirtRoad:       1,
    pavedRoad:      1,
};

function isAdjacent(fromHex, targetHex) {
    return hexDistance(fromHex, targetHex) === 1;
}

function checkOverstack(targetHex, movementGroup, units) {
    let squadCount  = 0;
    let leaderCount = 0;

    const countUnit = (u) => {
        if (u.type === 'leader') {
            leaderCount += 1;
        } else if (u.type === 'squad') {
            const half = u.size === 'halfSquad' || u.size === 'crew';
            squadCount += half ? 0.5 : 1;
        }
    };

    Object.values(units).forEach(u => {
        if (movementGroup.includes(u.id)) return;
        const inTargetHex = u.hex?.col === targetHex.col && u.hex?.row === targetHex.row;
        if (!inTargetHex) return;
        countUnit(u);
    });

    movementGroup.forEach(id => countUnit(units[id]));

    if (squadCount  > 3) return false;
    if (leaderCount > 4) return false;
    return true;
}

// принимает overrideTerrain (UseWoods='forest' / UseRoad='dirtRoad' / null=обычный)
export function _isRoadHex(hex, overrideTerrain = null) {
    if (overrideTerrain) {
        return overrideTerrain === 'dirtRoad' || overrideTerrain === 'pavedRoad';
    }
    const label = hexLabel(hex.col, hex.row);
    const terrain = hexMap[label] || [];
    return terrain.includes('dirtRoad') || terrain.includes('pavedRoad');
}

// гекс содержит Woods-Road — надо спросить игрока (UseWoods / UseRoad)
export function _hasWoodsRoad(targetHex) {
    const label = hexLabel(targetHex.col, targetHex.row);
    return (hexMap[label] || []).includes('Woods-Road');
}

function _all_path_is_road(path) {
    return path.every(p => p.isRoad);
}

function hasLeader(mg, units) {
    return mg.some(id => units[id].type === 'leader');
}

// linker — соседний non-leader юнит в FG
function _check_link_for_firing_group(unit, fg, units) {
    return fg.some(id => {
        const u = units[id];
        if (u.type === 'leader') return false;
        return hexDistance(u.hex, unit.hex) === 1;
    });
}

// тот же гекс, что у любого FG-юнита
function _check_if_unit_is_in_same_hex_as_fg(unit, fg, units) {
    return fg.some(id => {
        const u = units[id];
        return u.hex.col === unit.hex.col && u.hex.row === unit.hex.row;
    });
}

function road_bonus_is_possible(targetHex, u, overrideTerrain = null) {
    return _isRoadHex(targetHex, overrideTerrain) && _all_path_is_road(u.path) && u.roadBonus === 1;
}

function lead_bonus_is_possible(u, mg, units) {
    return u.leaderBonus > 0 && hasLeader(mg, units);
}

// Стоимость входа в targetHex с учётом откуда приходим (нужно для crestLine)
// overrideTerrain — игрок явно выбрал тип (UseWoods/UseRoad) для Woods-Road гекса
function checkCost(targetHex, fromHex, overrideTerrain = null) {
    const targetLabel   = hexLabel(targetHex.col, targetHex.row);
    let targetTerrain = hexMap[targetLabel] || [];

    if (overrideTerrain) targetTerrain = [overrideTerrain];

    // crestLine — особый случай: цена зависит от того, поднимаемся ли мы или спускаемся
    if (targetTerrain.includes('crestLine')) {
        // другие террейны в гексе (без самого crestLine) — задают базовую цену
        const others = targetTerrain.filter(t => t !== 'crestLine');
        // others.map(...) — превращаем массив имён террейнов в массив их стоимостей
        //   t => TERRAIN_COST[t] ?? 1   — подставляем 1 если террейна нет в TERRAIN_COST
        // Math.max(...arr) — берём наибольшее (если в гексе несколько террейнов,
        //   двигаемся по самому дорогому: forest+hill → 2, а не 1)
        // если other пуст (чистый crestLine) — открытое поле, стоимость 1
        const baseCost = others.length === 0
            ? 1
            : Math.max(...others.map(t => TERRAIN_COST[t] ?? 1));

        // если приходим сверху (с hill или другого crestLine) — обычная цена,
        // иначе подъём по crestLine стоит вдвое
        const fromLabel   = hexLabel(fromHex.col, fromHex.row);
        const fromTerrain = hexMap[fromLabel] || [];
        const fromAbove   = fromTerrain.includes('hill') || fromTerrain.includes('crestLine');

        return fromAbove ? baseCost : baseCost * 2;
    }

    // обычный гекс: максимум по террейнам (open hex = 1)
    if (targetTerrain.length === 0) return 1;
    return Math.max(...targetTerrain.map(t => TERRAIN_COST[t] ?? 1));
}

function mf_after_move(unit, targetHex, overrideTerrain = null) {
    return unit.mf - checkCost(targetHex, unit.hex, overrideTerrain);
}

// Новый mf после хода (с учётом реактивно потраченных бонусов).
// null => "нет реакции" — двигаться нельзя.
function calc_mf(u, targetHex, mg, units, overrideTerrain = null) {
    const m = mf_after_move(u, targetHex, overrideTerrain);

    if (m >= 0) return m;

    if (m === -1 && lead_bonus_is_possible(u, mg, units))                                                return 0;
    if (m === -1 && !lead_bonus_is_possible(u, mg, units) && road_bonus_is_possible(targetHex, u, overrideTerrain) && u.leaderBonus ==1 )       return null;
    if (m === -1 && !lead_bonus_is_possible(u, mg, units) && road_bonus_is_possible(targetHex, u, overrideTerrain))       return 0;
    if (m === -1)                                                                                       return null;

    if (m === -2 && lead_bonus_is_possible(u, mg, units) && u.leaderBonus === 2)                         return 0;
    if (m === -2 && lead_bonus_is_possible(u, mg, units) && u.leaderBonus === 1 && road_bonus_is_possible(targetHex, u, overrideTerrain)) return 0;
    if (m === -2)                                                                                       return null;

    if (m === -3 && lead_bonus_is_possible(u, mg, units) && u.leaderBonus === 2 && road_bonus_is_possible(targetHex, u, overrideTerrain)) return 0;
    if (m === -3)                                                                                       return null;

    return null;
}

// Остаток leaderBonus после хода
function calc_leader_bonus(u, targetHex, mg, units, overrideTerrain = null) {
    const m = mf_after_move(u, targetHex, overrideTerrain);

    if (!hasLeader(mg, units))                  return u.leaderBonus;
    if (!lead_bonus_is_possible(u, mg, units))  return u.leaderBonus;

    if (m === -3 && road_bonus_is_possible(targetHex, u, overrideTerrain) && u.leaderBonus === 2) return 0;
    if (m === -2 && road_bonus_is_possible(targetHex, u, overrideTerrain) && u.leaderBonus === 1) return 0;

    if (m >= 0) return u.leaderBonus;

    return u.leaderBonus + m;   // включает m == -2 и -1
}

// Остаток roadBonus после хода
function calc_road_bonus(u, targetHex, mg, units, overrideTerrain = null) {
    const m = mf_after_move(u, targetHex, overrideTerrain);

    if (m === -1 && road_bonus_is_possible(targetHex, u, overrideTerrain) && !hasLeader(mg, units))     return 0;
    if (m === -1 && road_bonus_is_possible(targetHex, u, overrideTerrain) && u.leaderBonus === 0)       return 0;
    if (m === -2 && road_bonus_is_possible(targetHex, u, overrideTerrain) && u.leaderBonus === 1)       return 0;
    if (m === -3 && road_bonus_is_possible(targetHex, u, overrideTerrain) && u.leaderBonus === 2)       return 0;

    return u.roadBonus;
}

function calc_mf_per_unit(mg, units, targetHex, result, overrideTerrain = null) {
    let no_reaction = false;
    mg.forEach(id => {
        const mf = calc_mf(units[id], targetHex, mg, units, overrideTerrain);
        if (mf === null) no_reaction = true;
        result[id] = { mf };
    });
    if (no_reaction) return null;
    return result;
}

function calc_leader_bonus_per_unit(mg, units, result, targetHex, overrideTerrain = null) {
    mg.forEach(id => {
        result[id].leaderBonus = calc_leader_bonus(units[id], targetHex, mg, units, overrideTerrain);
    });
    return result;
}

function calc_road_bonus_per_unit(mg, units, result, targetHex, overrideTerrain = null) {
    mg.forEach(id => {
        result[id].roadBonus = calc_road_bonus(units[id], targetHex, mg, units, overrideTerrain);
    });
    return result;
}

export const Rules = {
    checkIfAddingToMovementGroupIsValid(unit, movementStackHex, activeSide, mg, units) {
        if (unit.pinned) return false;

        const isInSameHex = unit.hex.col === movementStackHex.col &&
                            unit.hex.row === movementStackHex.row;
        const isActiveSide = unit.nation === activeSide;
        if (!(isInSameHex && isActiveSide)) return false;

        // не смешиваем двинувшихся с не-двинувшимися
        if (mg && mg.length > 0) {
            const mgMoved = mg.some(id => units[id].hasStartedMoving);
            if (mgMoved !== unit.hasStartedMoving) return false;
        }
        return true;
    },

    checkIfAddingToFireGroupIsValid(unit, defSide, fg, units) {
        if (unit.nation !== defSide) return false;
        if (!fg || fg.length === 0) return true;
        if (_check_if_unit_is_in_same_hex_as_fg(unit, fg, units)) return true;
        if (_check_link_for_firing_group(unit, fg, units)) return true;
        return false;
    },

    checkDoubleTimeCapability(id, units) {
        const u = units[id];
        if (u.type !== 'squad' && u.type !== 'leader') return false;
        if (u.broken || u.pinned || u.wounded || u.exhausted) return false;
        if (u.hasStartedMoving) return false;
        if (u.assaultMovement) return false;
        return true;
    },

    checkIfDoubleTimeForMovementGroupIsValid(mg, units) {
        if (mg.length === 0) return false;
        return mg.every(id => this.checkDoubleTimeCapability(id, units));
    },

    checkAssaultMovementCapability(id, units) {
        const u = units[id];
        if (u.type !== 'squad' && u.type !== 'leader') return false;
        if (u.broken || u.pinned || u.wounded || u.exhausted) return false;
        if (u.hasStartedMoving) return false;
        if (u.doubleTime) return false;
        return true;
    },

    checkIfAssaultMovementForMovementGroupIsValid(mg, units) {
        if (mg.length === 0) return false;
        return mg.every(id => this.checkAssaultMovementCapability(id, units));
    },

    checkPlaceSmokeCapability(id, units) {
        const u = units[id];
        if (u.type !== 'squad') return false;
        if (u.broken || u.pinned || u.wounded || u.exhausted) return false;
        if (u.mf < 1) return false;
        return true;
    },

    checkIfPlaceSmokeForMovementGroupIsValid(mg, units) {
        if (mg.length === 0) return false;
        return mg.every(id => this.checkPlaceSmokeCapability(id, units));
    },

    _isRoadHex,
    _hasWoodsRoad,
    checkCost,

    // огонь
    defensiveFF,

    arrangeMovement(ctx) {
        if (ctx.movementGroup.length === 0) return null;

        const fromHex = ctx.units[ctx.movementGroup[0]].hex;
        if (!isAdjacent(fromHex, ctx.targetHex)) return null;
        if (!checkOverstack(ctx.targetHex, ctx.movementGroup, ctx.units)) return null;

        const overrideTerrain = ctx.overrideTerrain || null;

        // AM-ограничения: только 1 шаг, и нельзя съесть весь MF
        for (const id of ctx.movementGroup) {
            const u = ctx.units[id];
            if (!u.assaultMovement) continue;
            if (u.hasStartedMoving) return null;
            if (u.mf - checkCost(ctx.targetHex, u.hex, overrideTerrain) <= 0) return null;
        }

        let result = {};
        result = calc_mf_per_unit(ctx.movementGroup, ctx.units, ctx.targetHex, result, overrideTerrain);
        if (result === null) return null;

        result = calc_leader_bonus_per_unit(ctx.movementGroup, ctx.units, result, ctx.targetHex, overrideTerrain);
        result = calc_road_bonus_per_unit (ctx.movementGroup, ctx.units, result, ctx.targetHex, overrideTerrain);

        // финализация
        for (const id in result) {
            result[id].hasStartedMoving = true;
        }
        for (const id in result) {
            const u = ctx.units[id];
            const newPath = [...u.path, { hex: ctx.targetHex, isRoad: _isRoadHex(ctx.targetHex, overrideTerrain) }];

            result[id].movementCompleted = false;

            if (result[id].mf === 0 &&
                !hasLeader(ctx.movementGroup, ctx.units) &&
                !_all_path_is_road(newPath)) {
                result[id].movementCompleted = true;
            }

            if (result[id].mf === 0 &&
                !hasLeader(ctx.movementGroup, ctx.units) &&
                _all_path_is_road(newPath) &&
                result[id].roadBonus === 0) {
                result[id].movementCompleted = true;
            }

            if (result[id].mf === 0 &&
                hasLeader(ctx.movementGroup, ctx.units) &&
                result[id].leaderBonus === 0 &&
                !_all_path_is_road(newPath)) {
                result[id].movementCompleted = true;
            }

            if (result[id].mf === 0 &&
                hasLeader(ctx.movementGroup, ctx.units) &&
                result[id].leaderBonus === 0 &&
                _all_path_is_road(newPath) &&
                result[id].roadBonus === 0) {
                result[id].movementCompleted = true;
            }

            if (u.assaultMovement) {
                result[id].movementCompleted = true;
            }
        }

        return { unitChanges: result };
    }
}
