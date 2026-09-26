export const MARKERS = ['●', '▲', '■', '✦'];
export function opponentMoves(previous, next, seatId) {
  if (!seatId || !next?.history?.length) return [];
  const records = previous?.id === next.id
    ? next.history.filter(record => record.turn > (previous.history?.at(-1)?.turn || 0))
    : next.history.slice(-1);
  return records.filter(record => record.actor !== seatId);
}
export function toggleTile(selection, id) { return selection.includes(id) ? selection.filter(value => value !== id) : [...selection, id]; }
export function reorderSelection(selection, from, to) {
  const result = [...selection];
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= result.length || to >= result.length) return result;
  const [id] = result.splice(from, 1);
  result.splice(to, 0, id);
  return result;
}
export function tileAppearance(game, tile) {
  const owner = game.seats.find(seat => seat.id === tile.owner);
  return { colorClass: owner ? `p${owner.index}` : '', marker: owner ? MARKERS[owner.index] : '',
    ownership: owner ? `owned by ${owner.displayName}` : 'unclaimed', defended: (game.defended || []).includes(tile.id) };
}
export function canPlay(game, seatId) { return game?.status === 'active' && game.seats[game.currentSeatIndex]?.id === seatId && game.seats[game.currentSeatIndex]?.kind === 'human'; }
export function reconcileSelection(previous, next, selection) { return previous?.id === next.id && previous.revision === next.revision ? selection : []; }
export function errorMessage(error) { const messages = { STALE_REVISION: 'The board changed. Your selection was cleared—try your move again.', NOT_YOUR_TURN: 'It’s another player’s turn. The board has been refreshed.', INVALID_WORD: 'That word isn’t in our dictionary. Try another combination.', WORD_ALREADY_USED: 'That word has already been played.', WORD_IS_PREFIX: 'A longer word starting with this word was already played.', GAME_FULL: 'This game has no open seats.', INVITE_INVALID: 'This invite is no longer available. Ask the host for a fresh link.', GAME_EXPIRED: 'This game has expired.', UNAUTHORIZED: 'This browser no longer has access to that seat.' }; return messages[error.code] || error.message || 'Something went wrong. Please try again.'; }
