import { hexDistance, hexLabel } from './hexUtils.js';
import { hexMap } from './hexmap.js';

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

    _isRoadHex,
    _hasWoodsRoad,

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
