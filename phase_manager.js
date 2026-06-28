let phase = 'select';

export const PhaseManager = {
  setPhase(p) { phase = p; },
  getPhase()  { return phase; },

  // Чья сейчас фаза (активная сторона)
  getActiveSide() {
    if (phase.startsWith('german')) return 'german';
    if (phase.startsWith('soviet')) return 'soviet';
    return null;
  },

  // Защищающаяся сторона (противоположная активной)
  getDefendingSide() {
    if (this.getActiveSide() === 'german') return 'soviet';
    if (this.getActiveSide() === 'soviet') return 'german';
    return null;
  }
};
