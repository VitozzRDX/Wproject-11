let phase = 'movement';
let activeRole = 'attacker';   // кто сейчас на ходу (ATTACKER, свапается player-turn'ами)

export const PhaseManager = {
  setPhase(p) { phase = p; },
  getPhase()  { return phase; },

  setActiveRole(r) { activeRole = r; },
  getActiveRole()  { return activeRole; },
  getDefendingRole() { return activeRole === 'attacker' ? 'defender' : 'attacker'; }
};
