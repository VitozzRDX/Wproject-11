import { Rules, setRollQueue } from './rules.js';

export function runWoundSimulation() {
    console.log('=== WOUND СИМУЛЯЦИЯ ===');
    console.log('Стек: 9-1, 8-1, 467. K/# → 9-1 elim → LLMC → 8-1 broken → LLTC → 467 pinned');

    const shooter = {
        id: 'sim_628', type: 'squad', nation: 'soviet',
        firepower: 6, range: 2, morale: 8,
        hex: { col: 20, row: 20 },
    };
    const targetHex = { col: 20, row: 19 };

    const unit_L91 = {
        id: 'sim_L91', type: 'leader', nation: 'german',
        morale: 9, brokenMorale: 9, leadershipModifier: -1,
        hex: targetHex,
        hasStartedMoving: true, assaultMovement: true,
        broken: false, pinned: false, wounded: false,
    };
    const unit_L81 = {
        id: 'sim_L81', type: 'leader', nation: 'german',
        morale: 8, brokenMorale: 8, leadershipModifier: -1,
        hex: targetHex,
        hasStartedMoving: true, assaultMovement: true,
        broken: false, pinned: false, wounded: false,
    };
    const unit_467 = {
        id: 'sim_467', type: 'squad', nation: 'german',
        firepower: 4, range: 6, morale: 7, brokenMorale: 7,
        hex: targetHex,
        hasStartedMoving: true, assaultMovement: true,
        broken: false, pinned: false, wounded: false,
    };
    const hexUnits = [unit_L91, unit_L81, unit_467];

    // Броски по порядку:
    // Fire 2d6: [1,3]=4          → DRM=-1, idx=3 → [3,'K/']
    // Wound severity d6: [5]     → eliminated
    // K/ others MC:
    //   L81 2d6: [1,2]=3         → finalDr=6, ok, leaderDRM=-1
    //   467 2d6: [1,2]=3         → finalDr=5, ok
    // LLMC (penalty=+1, affected=[L81,467]):
    //   L81 2d6: [5,3]=8         → finalDr=9 > 8 → broken
    //   467 2d6: [1,4]=5         → finalDr=6, ok
    // LLTC (penalty=+1, affected=[467]):
    //   467 PTC 2d6: [4,3]=7     → finalDr=8 > 7 → pinned
    setRollQueue([1, 3, 5, 1, 2, 1, 2, 5, 3, 1, 4, 4, 3]);

    // K/ victim = targets[0] = sim_L91
    const origRandom = Math.random;
    Math.random = () => 0;

    const result = Rules.fireAttack([shooter], targetHex, hexUnits);

    Math.random = origRandom;
    setRollQueue(null);

    console.log('РЕЗУЛЬТАТ:', result);
    console.log('=== КОНЕЦ ===');
}
