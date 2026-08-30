// Список фаз в порядке очерёдности (8 фаз per player turn).
const PHASES = [
    'rally',
    'prepFire',
    'movement',
    'defensiveFire',
    'advancingFire',
    'rout',
    'advance',
    'closeCombat',
];

let phase = 'rally';
let phaseIdx = 0;

export const PhaseManager = {
    getPhase()  { return phase; },
    setPhase(p) {
        phase = p;
        const idx = PHASES.indexOf(p);
        if (idx >= 0) phaseIdx = idx;
    },
    next() {
        phaseIdx = (phaseIdx + 1) % PHASES.length;
        phase = PHASES[phaseIdx];
        return phase;
    },
};
