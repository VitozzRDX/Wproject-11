import { describe, test, expect } from 'vitest';
import { Rules } from './rules.js';

function makeUnit(id, hex, mf = 4) {
  return { id, hex, mf, nation: 'german', type: 'squad', path: [{ hex, isRoad: false }], leaderBonus: 2, roadBonus: 1 };
}

describe('arrangeMovement', () => {

  test('null если movementGroup пустая', () => {
    const result = Rules.arrangeMovement({
      movementGroup: [],
      units:         {},
      targetHex:     { col: 1, row: 1 },
    });
    expect(result).toBeNull();
  });

  test('null если target гекс не соседний', () => {
    const u = makeUnit('a', { col: 1, row: 1 });
    const result = Rules.arrangeMovement({
      movementGroup: ['a'],
      units:         { a: u },
      targetHex:     { col: 5, row: 5 },
    });
    expect(result).toBeNull();
  });

  test('null если не хватает MF (target = forest, cost=2, у юнита mf=1)', () => {
    const u = makeUnit('a', { col: 0, row: 3 }, 1);
    const result = Rules.arrangeMovement({
      movementGroup: ['a'],
      units:         { a: u },
      targetHex:     { col: 0, row: 4 },
    });
    expect(result).toBeNull();
  });

  test('успех на пустой гекс — newMf = mf-1, флаги выставлены', () => {
    const u = makeUnit('a', { col: 100, row: 100 }, 4);
    const result = Rules.arrangeMovement({
      movementGroup: ['a'],
      units:         { a: u },
      targetHex:     { col: 100, row: 101 },
    });
    expect(result.unitChanges.a).toEqual({
      mf:                3,
      hasStartedMoving:  true,
      movementCompleted: false,
      leaderBonus:       2,
      roadBonus:         1,
    });
  });

  test('cost от террейна — forest=2', () => {
    const u = makeUnit('a', { col: 0, row: 3 }, 4);
    const result = Rules.arrangeMovement({
      movementGroup: ['a'],
      units:         { a: u },
      targetHex:     { col: 0, row: 4 },
    });
    expect(result.unitChanges.a.mf).toBe(2);
  });

  test('movementCompleted=true если mf исчерпан', () => {
    const u = makeUnit('a', { col: 100, row: 100 }, 1);
    const result = Rules.arrangeMovement({
      movementGroup: ['a'],
      units:         { a: u },
      targetHex:     { col: 100, row: 101 },
    });
    expect(result.unitChanges.a.movementCompleted).toBe(true);
    expect(result.unitChanges.a.mf).toBe(0);
  });

  test('null если overstack: 3 squad в гексе + новый', () => {
    const target = { col: 100, row: 101 };
    const mover  = makeUnit('mover', { col: 100, row: 100 });
    const units  = {
      mover,
      a: makeUnit('a', target),
      b: makeUnit('b', target),
      c: makeUnit('c', target),
    };
    const result = Rules.arrangeMovement({
      movementGroup: ['mover'],
      units,
      targetHex:     target,
    });
    expect(result).toBeNull();
  });

  test('overstack ok: 2 squad + новый = 3', () => {
    const target = { col: 100, row: 101 };
    const mover  = makeUnit('mover', { col: 100, row: 100 });
    const units  = {
      mover,
      a: makeUnit('a', target),
      b: makeUnit('b', target),
    };
    const result = Rules.arrangeMovement({
      movementGroup: ['mover'],
      units,
      targetHex:     target,
    });
    expect(result).not.toBeNull();
  });

  test('per-unit MF: разные стартовые MF сохраняются', () => {
    const startHex = { col: 100, row: 100 };
    const squad  = { id: 'sq', hex: startHex, mf: 4, nation: 'german', type: 'squad', path: [{ hex: startHex, isRoad: false }], leaderBonus: 2, roadBonus: 1 };
    const leader = { id: 'ld', hex: startHex, mf: 6, nation: 'german', type: 'leader', path: [{ hex: startHex, isRoad: false }], leaderBonus: 0, roadBonus: 1 };
    const result = Rules.arrangeMovement({
      movementGroup: ['sq', 'ld'],
      units:         { sq: squad, ld: leader },
      targetHex:     { col: 100, row: 101 },
    });
    expect(result.unitChanges.sq.mf).toBe(3);
    expect(result.unitChanges.ld.mf).toBe(5);
  });

  test('leader bonus реактивный: при mf=1 cost=2 → бонус тратится, mf=0, leaderBonus=1', () => {
    // squad mf=1, cost=2 (forest) → m=-1 → leaderBonus -1
    const startHex = { col: 0, row: 3 };
    const squad  = { id: 'sq', hex: startHex, mf: 1, nation: 'german', type: 'squad', path: [{ hex: startHex, isRoad: false }], leaderBonus: 2, roadBonus: 1 };
    const leader = { id: 'ld', hex: startHex, mf: 6, nation: 'german', type: 'leader', path: [{ hex: startHex, isRoad: false }], leaderBonus: 0, roadBonus: 1 };
    const result = Rules.arrangeMovement({
      movementGroup: ['sq', 'ld'],
      units:         { sq: squad, ld: leader },
      targetHex:     { col: 0, row: 4 },
    });
    expect(result.unitChanges.sq.mf).toBe(0);
    expect(result.unitChanges.sq.leaderBonus).toBe(1);
    expect(result.unitChanges.ld.mf).toBe(4);
  });

  test('leader bonus не доступен (leaderBonus=0): mf=1, cost=2 → null', () => {
    const startHex = { col: 0, row: 3 };
    const squad  = { id: 'sq', hex: startHex, mf: 1, nation: 'german', type: 'squad', path: [{ hex: startHex, isRoad: false }], leaderBonus: 0, roadBonus: 1 };
    const leader = { id: 'ld', hex: startHex, mf: 6, nation: 'german', type: 'leader', path: [{ hex: startHex, isRoad: false }], leaderBonus: 0, roadBonus: 1 };
    const result = Rules.arrangeMovement({
      movementGroup: ['sq', 'ld'],
      units:         { sq: squad, ld: leader },
      targetHex:     { col: 0, row: 4 },
    });
    expect(result).toBeNull();
  });

  test('halfSquad считается за 0.5: 6 halfSquad = 3 squad — на пределе', () => {
    const target = { col: 100, row: 101 };
    const start  = { col: 100, row: 100 };
    const mkHS = id => ({ id, hex: target, mf: 4, nation: 'german', type: 'squad', size: 'halfSquad', path: [{ hex: target, isRoad: false }], leaderBonus: 2, roadBonus: 1 });
    const mover = { id: 'mover', hex: start, mf: 4, nation: 'german', type: 'squad', size: 'halfSquad', path: [{ hex: start, isRoad: false }], leaderBonus: 2, roadBonus: 1 };
    const units = {
      mover,
      h1: mkHS('h1'), h2: mkHS('h2'), h3: mkHS('h3'),
      h4: mkHS('h4'), h5: mkHS('h5'),
    };
    const result = Rules.arrangeMovement({
      movementGroup: ['mover'],
      units,
      targetHex:     target,
    });
    expect(result).not.toBeNull();
  });
});
