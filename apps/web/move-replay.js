// Replays describe accepted moves; they never change authoritative ownership or scores.
export function playOpponentMoves(root, game, moves) {
  if (!moves.length || !root.querySelector('.board')) return () => {};
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const banner = document.createElement('div');
  banner.className = 'move-replay'; banner.setAttribute('role', 'status');
  root.querySelector('.board-wrap').before(banner);
  let cancelled = false;
  const timers = new Map(), animations = new Set();
  const pause = ms => new Promise(resolve => { const id = setTimeout(() => { timers.delete(id); resolve(); }, ms); timers.set(id, resolve); });
  const animate = (node, keyframes, options) => {
    if (!node || reduced || cancelled) return;
    const animation = node.animate(keyframes, options);
    animations.add(animation);
    animation.finished.catch(() => {}).finally(() => animations.delete(animation));
  };
  (async () => {
    for (const move of moves) {
      if (cancelled) break;
      const seat = game.seats.find(seat => seat.id === move.actor);
      banner.className = `move-replay p${seat?.index ?? 0}`;
      banner.dataset.replayTurn = String(move.turn);
      banner.textContent = move.type === 'pass' ? `${seat?.displayName || 'Opponent'} passed` : `${seat?.displayName || 'Opponent'} played ${move.word}`;
      animate(banner, [{ opacity: 0 }, { opacity: 1 }], { duration: 160, fill: 'both' });
      if (move.type === 'word' && !reduced) {
        for (const id of move.tileIds || []) {
          if (cancelled) break;
          const tile = root.querySelector(`[data-tile="${id}"]`);
          animate(tile, [{ transform: 'scale(1)', outline: '0px solid transparent' }, { transform: 'scale(1.1)', outline: '3px solid #222d29' }, { transform: 'scale(1)', outline: '0px solid transparent' }], { duration: 420, easing: 'ease-out' });
          await pause(85);
        }
      }
      if (cancelled) break;
      await pause(reduced ? 1200 : 750);
    }
    banner.remove();
  })();
  return () => {
    cancelled = true;
    for (const [id, resolve] of timers) { clearTimeout(id); resolve(); }
    timers.clear();
    for (const animation of animations) animation.cancel();
    banner.remove();
  };
}
