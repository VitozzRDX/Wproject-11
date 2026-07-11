import { Rules, setRollQueue } from './rules.js';

export function runFireSimulation() {
    console.log('=== ОГНЕВАЯ СИМУЛЯЦИЯ ===');
    console.log('Стрелок: so_628 (F5)');
    console.log('Цель: ge_467 двинулся G3→G4');
    console.log('Броски: 3+4=7 (огонь), 3+3=6 (MC)');

    const shooter = {
        id: 'sim_628', type: 'squad', nation: 'soviet',
        firepower: 6, range: 2, morale: 8,
        hex: { col: 5, row: 5 },
    };
    const target = {
        id: 'sim_467', type: 'squad', nation: 'german',
        firepower: 4, range: 6, morale: 7,
        hex: { col: 6, row: 4 },
        hasStartedMoving: true, broken: false, pinned: false,
        assaultMovement: false,
    };

    setRollQueue([3, 4, 3, 3]);

    const result = Rules.defensiveFF([shooter], target.hex, [target]);
    console.log('РЕЗУЛЬТАТ:', result);
    console.log('=== КОНЕЦ СИМУЛЯЦИИ ===');

    setRollQueue(null);
}
