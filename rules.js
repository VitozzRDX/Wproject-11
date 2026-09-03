import { hexDistance, hexLabel, hexToPixel, pixelToHex, isSameHex, R } from './hexUtils.js';
import { terrainAt } from './cards.js';
import { bresenham, pixel_is_on_Obstacle_set, setLastHit } from './terrainLOS.js';
import { PhaseManager } from './phase_manager.js';

const OBSTACLES = ['woods', 'buildings', 'hills'];

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

function calcTEM(hex, hexUnits = []) {
    const terrain = terrainAt(hex.col, hex.row);
    if (terrain.length === 0) return 0;
    // Woods-Road: если юнит в hex'e выбрал UseWoods (usedWoodsRoad=true) → forest TEM.
    if (terrain.includes('Woods-Road') && hexUnits.some(u => u.usedWoodsRoad)) {
        return TEM.forest;
    }
    return Math.max(0, ...terrain.map(t => TEM[t] ?? 0));
}

// ===========================================================================
// Firepower
// ===========================================================================
function calcFirepower(unit, targetHex) {
    if (unit.broken) return 0;              // сломанный weapon или пехота не стреляет
    if (unit.type === 'leader') return 0;   // лидер сам по себе не стреляет
    const dist = hexDistance(unit.hex, targetHex);
    let fp   = unit.pinned ? unit.firepower / 2 : unit.firepower;
    const rng  = unit.range;

    // SFF (Subsequent First Fire): FirstFire counter → FP halved, только normal range
    if (unit.firingStatus === 'FirstFire') {
        if (dist > rng) return 0;
        fp = fp / 2;
    }

    // FPF (Final Protective Fire): FinalFire counter → тоже halved
    // (precondition dist ≤ 1 проверяется отдельно в _check_FPF_valid)
    if (unit.firingStatus === 'FinalFire') {
        fp = fp / 2;
    }

    if (dist > rng * 2) return 0;
    if (dist === 0)     return fp * 3;   // Triple Point Blank Fire (same hex)
    if (dist === 1)     return fp * 2;   // Point Blank Fire (adjacent)
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
    const terrain = terrainAt(hex.col, hex.row);
    return (terrain.includes('hill') || terrain.includes('crestLine')) ? 1 : 0;
}

function calcHeightAdvantage(shooterHexes, targetHex, hexUnits = []) {
    if (shooterHexes.length === 0) return 0;
    const targetElev     = calcElevation(targetHex);
    const minShooterElev = Math.min(...shooterHexes.map(h => calcElevation(h)));
    if (minShooterElev >= targetElev) return 0;
    if (calcTEM(targetHex, hexUnits) > 0) return 0;

    // Exception (ASL): unit не получает HA если, входя в target-хекс, пересекает crest line
    // через тот же hexside, что и firer's LoS входит в target-хекс.
    // HA снимается только если ВСЕ хексы стрелков совпадают (наихудший для стрелка = TEM 1).
    if (terrainAt(targetHex.col, targetHex.row).includes('crestLine')) {
        for (const u of hexUnits) {
            if (!u.hasStartedMoving) continue;
            if (!u.path || u.path.length < 2) continue;
            const prevHex = u.path[u.path.length - 2].hex;
            const allMatch = shooterHexes.every(sHex => {
                const hexPath  = _hexLine(sHex, targetHex);
                const losEntry = hexPath[hexPath.length - 2];
                return isSameHex(losEntry, prevHex);
            });
            if (allMatch) return 0;
        }
    }

    return 1;
}

// ===========================================================================
// Hindrance + LOS
// ===========================================================================
const HINDRANCE_TERRAINS = ['orchard', 'grain', 'brush'];

// DRM для дыма (fire through/into). Fire out of smoke — константа +1.
const SMOKE_DRM = {
    smoke: 2,
};

// Smoke DRM вдоль LoS: в хексах пути — +DRM (through/into), в shooter hex — +1 (out of)
function _calcSmokeDRM(sHex, targetHex, hexPath) {
    let d = 0;
    for (const h of hexPath) {
        const t = terrainAt(h.col, h.row);
        const drm = t.map(s => SMOKE_DRM[s]).find(v => v);   // первый найденный smoke в терпейне
        if (!drm) continue;
        if (isSameHex(h, sHex)) d += 1;   // fire out of smoke
        else d += drm;                                            // through / into
    }
    return d;
}

// Pixel-based hex line: пробегает пиксели Bresenham'ом от центра fromHex до
// центра toHex, конвертирует каждый в hex через pixelToHex (Voronoi-nearest).
// Затем: (1) отбрасывает "чирки" углов через фильтр perp_dist > R√3/2;
//        (2) для hexspine случаев (linia строго по границе) выбирает
//            hex с большим hindrance-вкладом (худший для стрелка).
const R_SHORT   = R * Math.sqrt(3) / 2;   // ≈ 32.33 — короткий радиус hex'а (центр→ребро)
const SPINE_TOL = 0.5;                    // px допуск для детекции hexspine

function _hexLine(fromHex, toHex) {
    const from = hexToPixel(fromHex.col, fromHex.row);
    const to   = hexToPixel(toHex.col, toHex.row);
    // 1. Bresenham + Voronoi pixelToHex + дедуп подряд идущих
    const raw  = [];
    let prevKey = null;
    for (const { x, y } of bresenham(from.x, from.y, to.x, to.y)) {
        const h   = pixelToHex(x, y);
        const key = `${h.col},${h.row}`;
        if (key === prevKey) continue;
        raw.push(h);
        prevKey = key;
    }
    // 2. Фильтр чирков + resolution hexspine
    const dx = to.x - from.x, dy = to.y - from.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const out = [];
    for (const h of raw) {
        if (isSameHex(h, fromHex) || isSameHex(h, toHex)) { out.push(h); continue; }
        const c = hexToPixel(h.col, h.row);
        const cross = (c.x - from.x) * dy - (c.y - from.y) * dx;
        const perpDist = Math.abs(cross) / len;
        if (perpDist > R_SHORT + SPINE_TOL) continue;                              // чирок угла — выкинуть
        if (perpDist >= R_SHORT - SPINE_TOL) {
            out.push(_worseHindrance(h, _mirrorHex(h, from, to)));                 // spine — худший из пары
        } else {
            out.push(h);                                                           // строго внутри hex
        }
    }
    return out;
}

// Отражает центр hex'а через линию from-to → возвращает hex по зеркальной точке.
function _mirrorHex(h, from, to) {
    const c = hexToPixel(h.col, h.row);
    const dx = to.x - from.x, dy = to.y - from.y;
    const t = ((c.x - from.x) * dx + (c.y - from.y) * dy) / (dx * dx + dy * dy);
    const mirrorX = 2 * (from.x + t * dx) - c.x;
    const mirrorY = 2 * (from.y + t * dy) - c.y;
    return pixelToHex(mirrorX, mirrorY);
}

function _hindranceCount(h) {
    return terrainAt(h.col, h.row).filter(t => HINDRANCE_TERRAINS.includes(t)).length;
}

function _worseHindrance(a, b) {
    return _hindranceCount(b) > _hindranceCount(a) ? b : a;
}

// hex h есть в списке list?
function _hexInList(h, list) {
    return list.some(x => isSameHex(x, h));
}

// Разбивает массив хексов на группы связанных соседей (hexDistance === 1) через BFS
function array_of_adjacent_Hexes_arrays(hexes) {
    const visited = new Set();
    const result  = [];
    for (const start of hexes) {
        const startKey = `${start.col},${start.row}`;
        if (visited.has(startKey)) continue;

        const adjacent_Hexes_array = [];
        const adjacent_Hexes       = [start];
        while (adjacent_Hexes.length) {
            const cur    = adjacent_Hexes.shift();
            const curKey = `${cur.col},${cur.row}`;
            if (visited.has(curKey)) continue;
            visited.add(curKey);
            adjacent_Hexes_array.push(cur);
            for (const other of hexes) {
                if (hexDistance(cur, other) === 1) adjacent_Hexes.push(other);
            }
        }
        result.push(adjacent_Hexes_array);
    }
    return result;
}

// Отсеивает хексы стрелков, у которых нет LoS до target или hindrance ≥ 6
function filter_hexes_with_Los(hexes, targetHex, orchardInSeason = false) {
    return hexes.filter(h =>
        checkLOS(h, targetHex, orchardInSeason) && checkHindrance([h], targetHex) < 6
    );
}

// Возвращает:
//   hexPath — упорядоченный список хексов от shooter к target (через cube-lerp)
//   shield  — true iff весь путь orchard-road И ни один пиксель луча не в roads-Set
// Правило Orchard-Road (ASL SK): выстрел вдоль tree-lined road не даёт hindrance
// и разрешает FFMO (-1 DRM), даже если target в orchard-хексе.
function _los_stays_on_road_in_Orchard(shooterHex, targetHex, hexPath) {
    const from = hexToPixel(shooterHex.col, shooterHex.row);
    const to   = hexToPixel(targetHex.col, targetHex.row);
    let anyRoadCrossing = false;
    let roadHitPx = null;
    for (const { x, y } of bresenham(from.x, from.y, to.x, to.y)) {
        // Пропускаем пиксели в shooter/target хексе — road-outline там не считается crossing
        const h = pixelToHex(x, y);
        if (isSameHex(h, shooterHex)) continue;
        if (isSameHex(h, targetHex))  continue;
        if (pixel_is_on_Obstacle_set('roads', x, y)) {
            anyRoadCrossing = true;
            roadHitPx = { x, y };
            break;
        }
    }
                                    // если  пиксель LoS пересёк road , то мы вернем false 
    let shield = !anyRoadCrossing;  // если  пиксель LoS не пересёк road, то прикрытие под Orchard-Road невозможно
    let failHex = null;
    if (shield) {                   // если  пиксель LoS не пересёк road
        for (const h of hexPath) {              // бежим по hexPath
            const t = terrainAt(h.col, h.row);  // получаем terrain-хекса
            if (!(t.includes('orchard') && (t.includes('dirtRoad') || t.includes('pavedRoad')))) {  // и если  hex не orchard-road
                shield = false;                 // то 
                failHex = { hex: h, terrain: t };
                break;
            }
        }
    }
    console.log(`[shield] shooter=(${shooterHex.col},${shooterHex.row}) target=(${targetHex.col},${targetHex.row}) hexPath=${hexPath.map(h => `(${h.col},${h.row})`).join('→')} anyRoad=${anyRoadCrossing}${roadHitPx ? ` roadHitPx=(${roadHitPx.x},${roadHitPx.y})` : ''} shield=${shield}${failHex ? ` failedAt=(${failHex.hex.col},${failHex.hex.row}) terrain=[${failHex.terrain}]` : ''}`);
    return shield;
}


function checkHindrance(shooterHexes, targetHex) {
    return Math.max(...shooterHexes.map(sHex => {
        const hexPath = _hexLine(sHex, targetHex);
        // Smoke DRM всегда, поверх остального (tree-lined road shield его не снимает)
        let total = _calcSmokeDRM(sHex, targetHex, hexPath);
        if (_los_stays_on_road_in_Orchard(sHex, targetHex, hexPath)) return total;
        for (const h of hexPath) {
            if (isSameHex(h, sHex))      continue;
            if (isSameHex(h, targetHex)) continue;
            const terrain = terrainAt(h.col, h.row);
            for (const t of terrain) {
                if (HINDRANCE_TERRAINS.includes(t)) total += 1;
            }
        }
        return total;
    }));
}

// Чистая геометрическая проверка LoS между двумя хексами (fromHex → toHex).
// Возвращает true, если LoS не заблокирован препятствиями.
// Hindrance-порог (>=6) вынесен наружу — здесь только геометрия.
function checkLOS(fromHex, toHex, orchardInSeason = false) {
    setLastHit(null);

    // Elevation концов: hill-хекс = level 1, иначе 0 (crestLine тоже level 1 по "hex center dot")
    const fTerrain = terrainAt(fromHex.col, fromHex.row);
    const fHill = fTerrain.includes('hill') || fTerrain.includes('crestLine');
    const tTerrain = terrainAt(toHex.col, toHex.row);
    const tHill = tTerrain.includes('hill') || tTerrain.includes('crestLine');
    // "хотя бы один на ground" — ключевой флаг для применения hill-правил
    const anyOnGround = !fHill || !tHill;

    // Пиксельные центры хексов — начало и конец луча
    const from = hexToPixel(fromHex.col, fromHex.row);
    const to   = hexToPixel(toHex.col, toHex.row);

    // Один проход Брезенхема по пикселям луча
    for (const { x, y } of bresenham(from.x, from.y, to.x, to.y)) {
        const h = pixelToHex(x, y);

        // Пиксели from-хекса не блокируют — стрелок стоит там, а не смотрит сквозь свой террейн
        if (isSameHex(h, fromHex)) continue;
        // Первый же пиксель в to-хексе — прерываем: все дальнейшие тоже там
        if (isSameHex(h, toHex))   break;

        // Пиксель LoS попал в hill-хекс? (crestLine тоже level 1)
        const pTerrain = terrainAt(h.col, h.row);
        const pixel_of_LoS_is_on_hex_with_Hill = pTerrain.includes('hill') || pTerrain.includes('crestLine');

        // Правило: in-season orchard блокирует LoS между стрелком и целью на разных elevation'ах.
        if (orchardInSeason && fHill !== tHill && pTerrain.includes('orchard')) {
            setLastHit({ x, y, type: 'orchard' });
            return false;
        }

        // Проверяем каждый тип препятствия
        for (const type of OBSTACLES) {
            if (!pixel_is_on_Obstacle_set(type, x, y)) continue;

            let los_is_blocked = false;
            if (type === 'hills') {
                // hills блокирует только если LoS involves ground-юнит
                los_is_blocked = anyOnGround;
            } else {
                // woods/buildings блокирует если пиксель LoS на hill-хексе, ИЛИ хотя бы один юнит на ground
                los_is_blocked = pixel_of_LoS_is_on_hex_with_Hill || anyOnGround;
            }

            if (los_is_blocked) {
                setLastHit({ x, y, type });
                return false;
            }
        }
    }

    // Геометрия чиста — LoS не заблокирован
    return true;
}

// ===========================================================================
// FFNAM / FFMO
// ===========================================================================
function calcFFNAM(unit) {
    if (PhaseManager.getPhase() === 'defensiveFire') return 0;   // Final Fire: FFNAM не применяется
    if (!unit.hasStartedMoving) return 0;
    if (unit.broken)            return -1;
    if (unit.pinned)            return 0;
    if (unit.assaultMovement)   return 0;
    return -1;
}

function calcFFMO(unit, targetHex, treeLinedShield = false) {
    if (PhaseManager.getPhase() === 'defensiveFire') return 0;   // Final Fire: FFMO не применяется
    if (!unit.hasStartedMoving) return 0;
    if (unit.pinned)            return 0;
    if (calcTEM(targetHex, [unit]) > 0) return 0;
    // orchard не Open Ground — отменяет FFMO,
    // ЗА ИСКЛЮЧЕНИЕМ tree-lined road shield (правило Orchard-Road)
    const terrain = terrainAt(targetHex.col, targetHex.row);
    if (terrain.includes('orchard') && !treeLinedShield) return 0;
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
// Cowering: doubles на не-leader-directed атаке → сдвиг колонки IFT влево.
// Inexperienced юнит в FG → сдвиг на 2 колонки вместо 1.
// Возвращает новую колонку либо null если ушли ниже минимальной (промах).
function _applyCowering(units, col, red, white) {
    if (units.some(u => u.type === 'leader')) return col;   // leader-directed → cowering negated
    const inexperienced = units.some(u => u.quality === 'Inexperienced');
    const shift = inexperienced ? 2 : 1;
    const currentIdx = IFT_COLUMNS.indexOf(col);
    const newIdx = currentIdx - shift;
    console.log(`[cowering] doubles ${red}+${white} → shift ${shift} col left (${col} → ${IFT_COLUMNS[newIdx] ?? 'below'})`);
    if (newIdx < 0) {
        console.log(`[cowering] ниже минимальной колонки → без эффекта`);
        return null;
    }
    return IFT_COLUMNS[newIdx];
}

function _rollD6_() {
    if (rollQueue) return rollQueue.shift();
    return Math.floor(Math.random()*6) + 1;
}

// Возвращает Set id weapons, у которых сработал B# (malfunction).
// Effective B# = weapon.breakdownNumber - 2 если weapon уже был FirstFire/FinalFire до этой атаки.
function _calc_malfunction(weaponsInFG, baseDr) {
    const broken = new Set();
    weaponsInFG.forEach(u => {
        const bReduce    = (u.firingStatus === 'FirstFire' || u.firingStatus === 'FinalFire') ? 2 : 0;
        const effectiveB = u.breakdownNumber - bReduce;
        if (baseDr >= effectiveB) {
            console.log(`[weapon ${u.id}] B# hit: DR=${baseDr} >= ${effectiveB} → malfunctioned`);
            broken.add(u.id);
        }
    });
    return broken;
}

// Возвращает массив id weapons, сохранивших RoF (не бампаем их firingStatus). Сломанные пропускаются.
function _calc_weapons_kept_RoF(weaponsInFG, coloredDie, brokenWeapons) {
    const kept = [];
    weaponsInFG.forEach(u => {
        if (brokenWeapons.has(u.id)) return;
        if (coloredDie <= u.rof) {
            console.log(`[weapon ${u.id}] RoF preserved: coloredDie=${coloredDie} <= rof=${u.rof}`);
            kept.push(u.id);
        }
    });
    return kept;
}

// Residual FP оставленный defensive fire атакой в target-хексе (правило 3.3.5).
// FP исключает malfunctioned/keptRoF weapons — их вклад в атаке не даёт residual.
// Column shift за каждый positive external DRM source:
//   1) leader в FG с положительным leadershipModifier (плохой лидер)
//   2) CX (exhausted) shooter в FG
//   3) hindrance > 0 (сам факт наличия)
// HA и негативный leader-DRM не влияют. Cowering не влияет.
function _calc_residual_FP(firegroupUnits, targetHex, hindrance, brokenWeapons, weaponsKeepingRoF) {
    // weapons сломавшиеся или сохранившие RoF — не вносят FP в residual
    const excludeIds = new Set([...brokenWeapons, ...weaponsKeepingRoF]);

    // Суммируем FP оставшихся членов FG (calcFirepower уже учитывает range/pinned/SFF halving)
    const adjustedFP = firegroupUnits
        .filter(u => !excludeIds.has(u.id))
        .reduce((s, u) => s + calcFirepower(u, targetHex), 0);
    if (adjustedFP <= 0) return 0;

    // Original IFT-колонка (до cowering) по оставшемуся FP
    const adjustedCol = getIFTColumn(adjustedFP);

    // Считаем сдвиги колонок влево за external DRM sources
    let shifts = 0;
    if (firegroupUnits.some(u => u.type === 'leader' && (u.leadershipModifier ?? 0) > 0)) shifts++;
    if (firegroupUnits.some(u => u.exhausted)) shifts++;
    if (hindrance > 0) shifts++;

    // Применяем сдвиги, не ниже 0-го индекса
    const colIdx      = IFT_COLUMNS.indexOf(adjustedCol);
    const residualIdx = Math.max(0, colIdx - shifts);
    const residualCol = IFT_COLUMNS[residualIdx];

    // Residual FP = residualCol / 2 (round down, max 12)
    const residualFP  = Math.min(12, Math.floor(residualCol / 2));

    console.log(`[residual] adjustedFP=${adjustedFP} col=${adjustedCol}, shifts=${shifts}, residualCol=${residualCol}, residualFP=${residualFP}`);
    return residualFP;
}

function calcFireEffect(units, targetHex, drm = 0) {
    const fp    = calcTotalFirepower(units, targetHex);
    let col     = getIFTColumn(fp);
    const red   = _rollD6_();
    const white = _rollD6_();
    const dr    = red + white;

    if (red === white) {
        const newCol = _applyCowering(units, col, red, white);
        if (newCol === null) return { effect: false, baseDr: dr, coloredDie: red };
        col = newCol;
    }

    const arr = IFT[col];
    // rawIdx может уйти ниже 0 при большом отрицательном DRM — клампим к arr[0].
    const rawIdx = dr + drm;
    const idx = Math.max(0, rawIdx);
    console.log(`[calcFireEffect] FP=${fp}, col=${col}, DR=${dr} (${red}+${white}), DRM=${drm}, idx=${idx}`);
    if (idx >= arr.length) {
        console.log(`[calcFireEffect] промах (idx ${idx} >= length ${arr.length})`);
        return { effect: false, baseDr: dr, coloredDie: red };
    }
    console.log(`[calcFireEffect] результат:`, arr[idx]);
    return { effect: arr[idx], baseDr: dr, coloredDie: red };
}

// Обработка MC для группы целей.
// Лидеры проверяются первыми (лучший по морали → худший), каждый использует
// накопленный лидер-DRM от прошедших unharmed. Non-leaders — с полным DRM.
function _processMC(targets, k, result, fixedDr = null) {
    targets = targets.filter(u => u.category !== 'carried');   // weapons без morale — не проходят MC
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
        // fixedDr — если задан, используется вместо ролла (например для FPF NMC)
        const baseDr  = fixedDr ?? roll2d6();
        const finalDr = baseDr + k + drm;

        // Broken юниты тоже проходят MC. Провал → Casualty Reduction:
        //   leader → wound severity (_woundLeader)
        //   halfSquad/crew → eliminated
        //   squad → reduced (→ HS)
        if (u.broken) {
            if (baseDr === 12) {
                console.log(`[MC broken original 12] ${u.id} → eliminated`);
                return 'eliminated';
            }
            console.log(`[MC broken] ${u.id}: DR=${baseDr}, k=${k}, leaderDRM=${drm}, итог=${finalDr}, brokenMorale=${morale} → ${finalDr > morale ? 'CR' : 'ok'}`);
            if (finalDr > morale) return _casualtyReduction(u);
            return 'ok';
        }

        console.log(`[MC] ${u.id}: DR=${baseDr}, k=${k}, leaderDRM=${drm}, итог=${finalDr}, morale=${morale} → ${
            finalDr > morale ? 'broken' :
            finalDr === morale ? 'pinned' : 'ok'
        }`);
        if (finalDr > morale) {
            // NMC-fail: broken + DM, снимаем Pin и CX
            _placeDM(u);
            u.pinned = false;
            u.exhausted = false;
            if (baseDr === 12) {
                console.log(`[MC original 12] ${u.id} → CR + possible quality reduce`);
                u.broken = true;   // мутация чтобы _replace_unit унаследовал broken на HS
                const crResult = _casualtyReduction(u);
                // CR + ELR fail → engine делает CR, потом quality reduce на новом юните
                if (crResult === 'reduced' && finalDr - morale > u.elr) return 'reduce_then_quality';
                return crResult;
            }
            // ELR check (5.1): fail превышает ELR → quality reduce вместо простого broken
            if (finalDr - morale > u.elr) {
                console.log(`[ELR] ${u.id}: failedBy=${finalDr - morale} > ELR=${u.elr} → quality reduce to ${u.lowerQuality}`);
                u.broken = true;   // мутация чтобы _replace_unit унаследовал broken
                return 'quality_reduce';
            }
            return 'broken';
        }
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

// Desperation Morale — маркер на юните. Ставится при КИА-survive без broken.
// Мутирует u.desperationMorale = true.
function _placeDM(u) {
    u.desperationMorale = true;
    console.log(`[DM] ${u.id} → desperation morale placed`);
}

// Casualty Reduction — единая точка для K/, broken-MC-fail, KIA-survivor-broken.
//   leader → wound severity (_woundLeader)
//   halfSquad/crew → eliminated (уже уменьшенный дальше не редуцируется)
//   squad → reduced (→ HS)
function _casualtyReduction(u) {
    if (u.type === 'leader') return _woundLeader(u);
    if (u.size === 'halfSquad' || u.size === 'crew') {
        console.log(`[casualty reduction] ${u.id} → eliminated`);
        return 'eliminated';
    }
    console.log(`[casualty reduction] ${u.id} → reduced`);
    return 'reduced';
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
    u.mf = Math.min(u.mf, 3);   // wounded SMC has 3 MF
    console.log(`[wound light] ${u.id}: morale→${u.morale}, DRM→${u.leadershipModifier}, mf→${u.mf}`);
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
    if (affected.length === 0) {
        console.log(`[LLTC] leader ${leader.id} broken → нет affected: у всех подчинённых мораль ≥ лидерской (${effMorale(leader)})`);
    } else {
        console.log(`[LLTC] leader ${leader.id} broken → PTC penalty=${penalty}, affected: ${affected.map(u=>u.id).join(',')}`);
        _processPTC(affected, penalty, result);
    }
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
    if (affected.length === 0) {
        console.log(`[LLMC] leader ${leader.id} eliminated → нет affected: у всех подчинённых мораль ≥ лидерской (${effMorale(leader)})`);
    } else {
        console.log(`[LLMC] leader ${leader.id} eliminated → NMC penalty=${penalty}, affected: ${affected.map(u=>u.id).join(',')}`);
        _processMC(affected, penalty, result);
    }
}

// PTC для группы целей: лидеры первыми (лучший по морали),
// накопленный leadership DRM применяется к последующим (себе не помогает).
function _processPTC(targets, drm, result) {
    targets = targets.filter(u => u.category !== 'carried');   // weapons не проходят PTC
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
    targets = targets.filter(u => u.category !== 'carried');   // weapons никогда не в целях
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
                if (u.broken) {
                    // выживший, но уже сломан → Casualty Reduction
                    result[u.id] = _casualtyReduction(u);
                    console.log(`[KIA survivor already broken] ${u.id} → CR: ${result[u.id]}`);
                } else {
                    console.log(`[KIA survivor] ${u.id} → broken + DM`);
                    result[u.id] = 'broken';
                    _placeDM(u);
                }
            });
            break;
        }
        case 'K/': {
            const idx    = Math.floor(Math.random() * targets.length);
            const victim = targets[idx];
            const others = targets.filter((_, i) => i !== idx);

            result[victim.id] = _casualtyReduction(victim);
            console.log(`[K/ casualty] ${victim.id} → ${result[victim.id]}`);
            _processMC(others, k, result);
            break;
        }
    }
    _checkLeaderLoss(targets, result);
    return result;
}

// KEU = unconcealed enemy unit к которому у нас есть LOS.
// Пока LOS всегда true (кроме hindrance≥6), concealment не реализовано.
// Когда добавятся геометрия/сокрытие — семантика будет корректна автоматически.
function _closest_enemy_distance(shooter, units, orchardInSeason = false) {
    let min = Infinity;
    for (const u of Object.values(units)) {
        if (u.nation === shooter.nation) continue;
        if (!checkLOS(shooter.hex, u.hex, orchardInSeason)) continue;   // геометрия LoS блокирована → не KEU
        if (checkHindrance([shooter.hex], u.hex) >= 6) continue;     // hindrance-порог тоже блокирует
        // TODO: concealed check когда появится (u.concealed)
        const d = hexDistance(shooter.hex, u.hex);
        if (d < min) min = d;
    }
    return min;
}

// FPF-precondition: FinalFire-стрелок может атаковать только adjacent или same hex
function _check_FPF_valid(firegroupUnits, targetHex) {
    for (const u of firegroupUnits) {
        if (u.firingStatus !== 'FinalFire') continue;
        const dist = hexDistance(u.hex, targetHex);
        if (dist > 1) {
            console.log(`[FPF blocked] ${u.id}: dist ${dist} > 1 (must be adjacent/same hex)`);
            return false;
        }
    }
    return true;
}

// SFF-precondition: любой SFF-стрелок в FG обязан быть в normal range И не дальше ближайшего KEU
function _check_SFF_valid(firegroupUnits, targetHex, units, orchardInSeason = false) {
    for (const u of firegroupUnits) {
        if (u.firingStatus !== 'FirstFire') continue;   // не SFF — пропускаем
        const dist = hexDistance(u.hex, targetHex);
        if (dist > u.range) {
            console.log(`[SFF blocked] ${u.id}: dist ${dist} > normal range ${u.range}`);
            return false;
        }
        const closest = _closest_enemy_distance(u, units, orchardInSeason);
        if (dist > closest) {
            console.log(`[SFF blocked] ${u.id}: dist ${dist} > closest KEU distance ${closest}`);
            return false;
        }
    }
    return true;
}

// Residual FP атака (правило 3.3.5) — одна IFT DR на всех вошедших юнитов.
// applyFireEffect уже сортирует лидеров first и обрабатывает leader-help pool.
// DRM = TEM/Smoke цели + FFNAM/FFMO по первому юниту (как hexUnits[0] в fireAttack).
function residualAttack(residualFP, targetUnits, targetHex) {
    const col = getIFTColumn(residualFP);
    const arr = IFT[col];

    const dr  = roll2d6();

    const tem     = calcTEM(targetHex, targetUnits);
    const ffnam   = targetUnits.length > 0 ? calcFFNAM(targetUnits[0]) : 0;
    const ffmoRaw = targetUnits.length > 0 ? calcFFMO(targetUnits[0], targetHex, false) : 0;
    // TEM в target отменяет FFMO
    const ffmo    = (tem > 0) ? 0 : ffmoRaw;
    // Smoke в target hex — для residual нет источника, только "into"
    const targetTerrain = terrainAt(targetHex.col, targetHex.row);
    const smokeDRM = targetTerrain.map(t => SMOKE_DRM[t]).find(v => v) ?? 0;
    const drm     = tem + ffnam + ffmo + smokeDRM;

    const idx = Math.max(0, dr + drm);
    console.log(`[residual attack] targets=[${targetUnits.map(u=>u.id).join(',')}], FP=${residualFP}, col=${col}, DR=${dr}, DRM=${drm} (TEM=${tem}, FFNAM=${ffnam}, FFMO=${ffmo}, smoke=${smokeDRM}), idx=${idx}`);
    if (idx >= arr.length) {
        console.log('[residual attack] промах');
        return {};
    }
    console.log('[residual attack] эффект:', arr[idx]);
    return applyFireEffect(arr[idx], targetUnits);
}

function fireAttack(firegroupUnits, targetHex, hexUnits, units, orchardInSeason = false) {
    if (!_check_SFF_valid(firegroupUnits, targetHex, units, orchardInSeason)) {
        console.log('[fireAttack] SFF constraint violated — атака отменена');
        return null;
    }
    if (!_check_FPF_valid(firegroupUnits, targetHex)) {
        console.log('[fireAttack] FPF constraint violated — атака отменена');
        return null;
    }

    // Нет FP (например, только лидер в FG) — стрелять нечем
    const totalFP = calcTotalFirepower(firegroupUnits, targetHex);
    if (totalFP <= 0) {
        console.log('[fireAttack] total FP = 0 — стрелять нечем');
        return null;
    }

    // Геометрический LoS — от каждого хекса стрелков; блокировка хотя бы одного = нет LoS
    const shooterHexes = firegroupUnits.map(u => u.hex);
    const losOk        = shooterHexes.every(h => checkLOS(h, targetHex, orchardInSeason));
    const hindrance    = checkHindrance(shooterHexes, targetHex);
    const los          = losOk && hindrance < 6;
    console.log(`[fireAttack] LOS=${los}`);
    if (!los) {
        console.log('[fireAttack] нет LOS — огонь невозможен');
        return { changes: {} };
    }

    const baseTem       = calcTEM(targetHex, hexUnits);
    const shooterHexesForHA = firegroupUnits.map(u => u.hex);
    const ha                = calcHeightAdvantage(shooterHexesForHA, targetHex, hexUnits);
    const tem           = baseTem > 0 ? baseTem : ha;
    let shield = false;
    if (firegroupUnits.length > 0) {
        const sHex = firegroupUnits[0].hex;
        shield = _los_stays_on_road_in_Orchard(sHex, targetHex, _hexLine(sHex, targetHex));
    }
    const ffnam         = hexUnits.length > 0 ? calcFFNAM(hexUnits[0]) : 0;
    const ffmoRaw       = hexUnits.length > 0 ? calcFFMO(hexUnits[0], targetHex, shield) : 0;
    const ffmo          = (ha > 0 || hindrance > 0) ? 0 : ffmoRaw;
    const leadershipDRM = calcLeadershipDRM(firegroupUnits);
    const totalDRM      = tem + hindrance + ffnam + ffmo + leadershipDRM;

    console.log(`[fireAttack] TEM=${tem}, HINDRANCE=${hindrance}, FFNAM=${ffnam}, FFMO=${ffmo}, LEADER=${leadershipDRM}, totalDRM=${totalDRM}`);

    const { effect, baseDr, coloredDie } = calcFireEffect(firegroupUnits, targetHex, totalDRM);
    const changes = applyFireEffect(effect, hexUnits);

    // B# (malfunction) и RoF (сохранение статуса) для weapons в FG
    const weaponsInFG       = firegroupUnits.filter(u => u.category === 'carried');
    const brokenWeapons     = _calc_malfunction(weaponsInFG, baseDr);
    for (const id of brokenWeapons) changes[id] = 'broken';   // флип на brokenSrc через _apply_changes_for_targets
    const weaponsKeepingRoF = _calc_weapons_kept_RoF(weaponsInFG, coloredDie, brokenWeapons);
    const residualFP        = _calc_residual_FP(firegroupUnits, targetHex, hindrance, brokenWeapons, weaponsKeepingRoF);

    // FPF Self-NMC: если FinalFire-стрелки в FG, они (+ directing leaders)
    // проходят NMC с original DR + leadership DRM (k=0, только leader help).
    const fpfShooters = firegroupUnits.filter(u => u.firingStatus === 'FinalFire');
    if (fpfShooters.length > 0) {
        const nmcSubjects = firegroupUnits.filter(u =>
            u.firingStatus === 'FinalFire' || u.type === 'leader'
        );
        console.log(`[FPF NMC] subjects: ${nmcSubjects.map(u => u.id).join(',')}, fixedDr=${baseDr}`);
        _processMC(nmcSubjects, 0, changes, baseDr);
        _checkLeaderLoss(nmcSubjects, changes);
    }

    return { changes, weaponsKeepingRoF, residualFP };
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
        const inTargetHex = u.hex && isSameHex(u.hex, targetHex);
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
    const terrain = terrainAt(hex.col, hex.row);
    return terrain.includes('dirtRoad') || terrain.includes('pavedRoad');
}

// гекс содержит Woods-Road — надо спросить игрока (UseWoods / UseRoad)
export function _hasWoodsRoad(targetHex) {
    return terrainAt(targetHex.col, targetHex.row).includes('Woods-Road');
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
        return isSameHex(u.hex, unit.hex);
    });
}

function road_bonus_is_possible(targetHex, u, overrideTerrain = null) {
    if (u.usedWoodsRoad) return false;   // использовал Woods-Road защиту → нет road bonus
    // Smoke в target hex → +1 MF при входе → road bonus не применяется (правило 1.2.5)
    const targetTerrain = terrainAt(targetHex.col, targetHex.row);
    if (targetTerrain.some(t => SMOKE_DRM[t])) return false;
    return _isRoadHex(targetHex, overrideTerrain) && _all_path_is_road(u.path) && u.roadBonus === 1;
}

function lead_bonus_is_possible(u, mg, units) {
    return u.leaderBonus > 0 && hasLeader(mg, units);
}

// Стоимость входа в targetHex с учётом откуда приходим (нужно для crestLine)
// overrideTerrain — игрок явно выбрал тип (UseWoods/UseRoad) для Woods-Road гекса
function checkCost(targetHex, fromHex, overrideTerrain = null) {
    let targetTerrain = terrainAt(targetHex.col, targetHex.row);

    // Smoke в target hex → +1 MF при входе (правило: не за выход).
    // Считаем ДО overrideTerrain — smoke живёт в overlay независимо от Woods-Road выбора.
    const smokeExtra = targetTerrain.some(t => SMOKE_DRM[t]) ? 1 : 0;

    // Woods-Road: игрок выбрал UseWoods/UseRoad → террейн интерпретируется одним типом
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
        const fromTerrain = terrainAt(fromHex.col, fromHex.row);
        const fromAbove   = fromTerrain.includes('hill') || fromTerrain.includes('crestLine');

        return (fromAbove ? baseCost : baseCost * 2) + smokeExtra;
    }

    // open ground — нет ни static, ни dynamic (в т.ч. smoke) → всегда 1
    if (targetTerrain.length === 0) return 1;
    // обычный гекс: максимум по террейнам
    return Math.max(...targetTerrain.map(t => TERRAIN_COST[t] ?? 1)) + smokeExtra;
}

function mf_after_move(unit, targetHex, overrideTerrain = null) {
    return unit.mf - checkCost(targetHex, unit.hex, overrideTerrain);
}

// Portage penalty (4.0): PP possessed weapons сверх IPC → штраф MF.
// Считается динамически при каждом move-check — drop/pickup оружия сразу меняет excess.
function _portageExcess(u, units, mg = null) {
    if (u.category !== 'infantry') return 0;
    const possessedPP = Object.values(units)
        .filter(w => w.category === 'carried' && w.possessorId === u.id)
        .reduce((s, w) => s + (w.portagePoints ?? 0), 0);

    // SMC contribution: каждый Good Order лидер в MG добавляет +1 IPC ПЕРВОМУ MMC в MG.
    let smcBonus = 0;
    if (mg && u.type === 'squad') {
        const mmcsInMg = mg.filter(id => units[id].type === 'squad');
        if (mmcsInMg[0] === u.id) {
            smcBonus = mg.filter(id => {
                const l = units[id];
                return l.type === 'leader' && !l.broken && !l.pinned && !l.wounded;
            }).length;
        }
    }
    return Math.max(0, possessedPP - ((u.ipc ?? 0) + smcBonus));
}

// Новый mf после хода (с учётом реактивно потраченных бонусов).
// null => "нет реакции" — двигаться нельзя.
function calc_mf(u, targetHex, mg, units, overrideTerrain = null) {
    const rawM   = mf_after_move(u, targetHex, overrideTerrain);
    const excess = _portageExcess(u, units, mg);
    // effective m: доступный MF (u.mf - excess) минус cost. По нему проверяем бонусы.
    const m = rawM - excess;

    // Возврат сырой u.mf - cost (без excess), чтобы не bakes penalty в u.mf → dynamic.
    if (m >= 0) return rawM;

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
    const rawM   = mf_after_move(u, targetHex, overrideTerrain);
    const excess = _portageExcess(u, units, mg);
    const m = rawM - excess;

    if (!hasLeader(mg, units))                  return u.leaderBonus;
    if (!lead_bonus_is_possible(u, mg, units))  return u.leaderBonus;

    if (m === -3 && road_bonus_is_possible(targetHex, u, overrideTerrain) && u.leaderBonus === 2) return 0;
    if (m === -2 && road_bonus_is_possible(targetHex, u, overrideTerrain) && u.leaderBonus === 1) return 0;

    if (m >= 0) return u.leaderBonus;

    return u.leaderBonus + m;   // включает m == -2 и -1
}

// Остаток roadBonus после хода
function calc_road_bonus(u, targetHex, mg, units, overrideTerrain = null) {
    const rawM   = mf_after_move(u, targetHex, overrideTerrain);
    const excess = _portageExcess(u, units, mg);
    const m = rawM - excess;

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
    checkIfAddingToMovementGroupIsValid(unit, movementStackHex, movingSide, mg, units) {
        if (unit.pinned || unit.broken) return false;
        if (unit.prepFired) return false;   // стрелял в PFPh → не двигается в MPh

        const isInSameHex = unit.hex.col === movementStackHex.col &&
                            unit.hex.row === movementStackHex.row;
        const isMovingSide = unit.side === movingSide;
        if (!(isInSameHex && isMovingSide)) return false;

        // не смешиваем двинувшихся с не-двинувшимися
        if (mg && mg.length > 0) {
            const mgMoved = mg.some(id => units[id].hasStartedMoving);
            if (mgMoved !== unit.hasStartedMoving) return false;
        }
        return true;
    },

    checkIfAddingToFireGroupIsValid(unit, firingSide, fg, units) {
        // сломанный юнит (пехота или weapon) — не стреляет
        if (unit.broken) return false;

        // В DFPh юнит с FinalFire counter не может стрелять (правило Final Fire)
        if (PhaseManager.getPhase() === 'defensiveFire' &&
            unit.category === 'infantry' &&
            unit.firingStatus === 'FinalFire') return false;

        if (unit.category === 'carried') {
            // валяется без хозяина
            if (!unit.possessorId) return false;
            const possessor = units[unit.possessorId];
            // хозяин не в форме — оружие не стреляет
            if (possessor.broken || possessor.pinned) return false;
            // Национальность weapon = национальность possessor'а (можно владеть трофейным)
            if (possessor.side !== firingSide) return false;
        } else {
            // Своя национальность у пехоты
            if (unit.side !== firingSide) return false;
        }

        // Общие правила смежности (те же для пехоты и weapon)
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

    checkDropCapability(mg, units) {
        return mg.some(id => Object.values(units).some(
            unit => unit.category === 'carried' && unit.possessorId === id
        ));
    },

    // Ищет пару (юнит из MG, оружие в его hex) для попытки Recover.
    // MVP: первый годный юнит × первое годное оружие.
    // Возвращает { unitId, weaponId } или null.
    findRecoverCandidate(mg, units) {
        for (const uid of mg) {
            const u = units[uid];
            if (u.category !== 'infantry') continue;   // carried сами не подбирают
            if (u.mf < 1) continue;                    // на Recover нужен 1 MF
            // Ищем в hex'e юнита unpossessed weapon, ещё не двигавшееся в этой MPh
            const weapon = Object.values(units).find(w =>
                w.category === 'carried' &&
                w.possessorId === null &&
                !w.movedThisMPh &&
                w.hex && isSameHex(w.hex, u.hex)
            );
            if (weapon) return { unitId: uid, weaponId: weapon.id };
        }
        return null;
    },

    rollRecoverAttempt(u) {
        const raw = _rollD6_();
        const dr  = raw + (u.exhausted ? 1 : 0);
        const success = dr < 6;
        console.log(`[recover] ${u.id}: dr=${raw}${u.exhausted ? '+1 CX' : ''}=${dr} → ${success ? 'ok' : 'fail'}`);
        return { success };
    },

    checkPlaceSmokeCapability(id, units, mg = null) {
        const u = units[id];
        if (u.type !== 'squad') return false;
        if (!u.smokeExponent)   return false;   // нет SE — не может размещать
        if (u.smokeAttempted)   return false;   // уже пытался в этом MPh
        if (u.broken || u.pinned || u.wounded || u.exhausted) return false;
        if (u.mf - _portageExcess(u, units, mg) < 1) return false;
        return true;
    },

    checkIfPlaceSmokeForMovementGroupIsValid(mg, units) {
        if (mg.length === 0) return false;
        return mg.some(id => this.checkPlaceSmokeCapability(id, units, mg));   // хотя бы один способен → показываем кнопку
    },

    // Роллит dr для попытки размещения дыма каждым юнитом из mg.
    // Возвращает { [id]: { success, mfEnded } }. State-мутации делает engine.
    rollSmokePlacementAttempts(units, unitIds, mfCost = 1) {
        const results = {};
        for (const id of unitIds) {
            const u = units[id];
            if (!this.checkPlaceSmokeCapability(id, units, unitIds)) continue;
            if (u.mf - _portageExcess(u, units, unitIds) < mfCost) continue;

            const rawDr = _rollD6_();
            const drmDr = u.exhausted ? rawDr + 1 : rawDr;
            const success = drmDr <= u.smokeExponent;
            console.log(`[smoke] ${id}: dr=${rawDr}${u.exhausted ? '+1 CX' : ''}=${drmDr} vs SE=${u.smokeExponent} → ${success ? 'placed' : 'failed'}`);
            results[id] = { success, mfEnded: rawDr === 6 };
        }
        return results;
    },

    _isRoadHex,
    _hasWoodsRoad,
    checkCost,

    // огонь
    fireAttack,
    residualAttack,
    filter_hexes_with_Los,
    array_of_adjacent_Hexes_arrays,
    hexInList: _hexInList,

    arrangeMovement(ctx) {
        if (ctx.movementGroup.length === 0) {
            console.log('[move] MG пусто');
            return null;
        }

        const fromHex = ctx.units[ctx.movementGroup[0]].hex;
        if (!isAdjacent(fromHex, ctx.targetHex)) {
            console.log(`[move] target (${ctx.targetHex.col},${ctx.targetHex.row}) не соседний с (${fromHex.col},${fromHex.row})`);
            return null;
        }
        if (!checkOverstack(ctx.targetHex, ctx.movementGroup, ctx.units)) {
            console.log(`[move] overstack в target hex (макс 3 squads / 4 leaders)`);
            return null;
        }

        const overrideTerrain = ctx.overrideTerrain || null;

        // Assault Move-ограничения: только 1 шаг, и нельзя съесть весь MF
        for (const id of ctx.movementGroup) {
            const u = ctx.units[id];
            if (!u.assaultMovement) continue;
            if (u.hasStartedMoving) {
                console.log(`[move] Assault Move: ${id} уже начал движение — нельзя`);
                return null;
            }
            if (u.mf - checkCost(ctx.targetHex, u.hex, overrideTerrain) - _portageExcess(u, ctx.units, ctx.movementGroup) <= 0) {
                console.log(`[move] Assault Move: ${id} истратил бы весь MF (запрещено правилом Assault Move)`);
                return null;
            }
        }

        let result = {};
        result = calc_mf_per_unit(ctx.movementGroup, ctx.units, ctx.targetHex, result, overrideTerrain);
        if (result === null) {
            // Детальный лог: кто именно не может и почему
            for (const id of ctx.movementGroup) {
                const u = ctx.units[id];
                const cost   = checkCost(ctx.targetHex, u.hex, overrideTerrain);
                const excess = _portageExcess(u, ctx.units, ctx.movementGroup);
                const eff    = u.mf - excess - cost;
                const m      = calc_mf(u, ctx.targetHex, ctx.movementGroup, ctx.units, overrideTerrain);
                if (m === null) {
                    console.log(`[move] ${id}: mf=${u.mf} excess=${excess} cost=${cost} → effective=${eff}, бонусы не покрывают (leaderBonus=${u.leaderBonus}, roadBonus=${u.roadBonus})`);
                }
            }
            return null;
        }

        result = calc_leader_bonus_per_unit(ctx.movementGroup, ctx.units, result, ctx.targetHex, overrideTerrain);
        result = calc_road_bonus_per_unit (ctx.movementGroup, ctx.units, result, ctx.targetHex, overrideTerrain);

        // финализация
        for (const id in result) {
            result[id].hasStartedMoving = true;
        }
        for (const id in result) {
            const u = ctx.units[id];
            const newPath = [...u.path, { hex: ctx.targetHex, isRoad: _isRoadHex(ctx.targetHex, overrideTerrain) }];

            const effMf = result[id].mf - _portageExcess(u, ctx.units, ctx.movementGroup);

            result[id].movementCompleted = false;

            if (effMf <= 0 &&
                !hasLeader(ctx.movementGroup, ctx.units) &&
                !_all_path_is_road(newPath)) {
                result[id].movementCompleted = true;
            }

            if (effMf <= 0 &&
                !hasLeader(ctx.movementGroup, ctx.units) &&
                _all_path_is_road(newPath) &&
                result[id].roadBonus === 0) {
                result[id].movementCompleted = true;
            }

            if (effMf <= 0 &&
                hasLeader(ctx.movementGroup, ctx.units) &&
                result[id].leaderBonus === 0 &&
                !_all_path_is_road(newPath)) {
                result[id].movementCompleted = true;
            }

            if (effMf <= 0 &&
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
