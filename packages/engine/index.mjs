import { words, dictionaryVersion } from './dictionary.mjs';
export { words, dictionaryVersion };
export const generatorVersion = 'category-quota-2';
export const rulesVersion = 'territory-2';
const wordSet = new Set(words);
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
export function seededRandom(seed) {
  let value = 2166136261;
  for (const letter of String(seed)) value = Math.imul(value ^ letter.charCodeAt(0), 16777619);
  return () => { value += 0x6D2B79F5; let t = Math.imul(value ^ value >>> 15, 1 | value); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function counts(letters) {
  const result = Object.create(null);
  for (const letter of letters) result[letter] = (result[letter] || 0) + 1;
  return result;
}
export function isBlocked(word, history) { return history.some(record => record.type === 'word' && record.word.startsWith(word)); }
// Cache only board-letter candidates, never history-dependent legality. Bounded for long-running servers.
const wordCounts = words.map(word => Object.entries(counts(word)));
const boardCandidates = new Map();
export function usableTiles(game, seatId = game.seats?.[game.currentSeatIndex]?.id) {
  const defended = new Set(game.rules?.exclusiveDefense ? getDefended(game) : []);
  return game.tiles.filter(tile => !defended.has(tile.id) || tile.owner === seatId);
}
export function legalWords(game) {
  const available = counts(usableTiles(game).map(tile => tile.letter));
  const key = Object.keys(available).sort().map(letter => `${letter}${available[letter]}`).join('');
  let candidates = boardCandidates.get(key);
  if (!candidates) {
    candidates = words.filter((word, index) => wordCounts[index].every(([letter, amount]) => amount <= (available[letter] || 0)));
    if (boardCandidates.size >= 32) boardCandidates.delete(boardCandidates.keys().next().value);
    boardCandidates.set(key, candidates);
  }
  const blocked = new Set();
  for (const record of game.history) if (record.type === 'word') {
    for (let length = 2; length <= record.word.length; length++) blocked.add(record.word.slice(0, length));
  }
  return candidates.filter(word => !blocked.has(word));
}
export const letterGroups = Object.freeze({ hard: 'XJQZ', easy: 'AEILNORSTU', other: 'BCDFGHKMPVWY' });
const vowelDistribution = 'A'.repeat(9) + 'E'.repeat(12) + 'I'.repeat(9) + 'O'.repeat(8) + 'U'.repeat(4);
const easyDistribution = vowelDistribution + 'LLLLNNNNNNRRRRRRSSSSTTTTTT';
const otherDistribution = 'BBCCDDDDFFGGGHHK MMPP VVWWYY'.replaceAll(' ', '');
export function letterQuotas(size) {
  const total = size * size;
  const hard = Math.round(total * .2), easy = Math.round(total * .5);
  return { hard, easy, other: total - hard - easy };
}
function shuffle(letters, random) {
  for (let i = letters.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [letters[i], letters[j]] = [letters[j], letters[i]];
  }
  return letters;
}
export const fallbackLetters = Object.freeze({
  5: 'XJQZXAEIOUAERSTLNSDGHBCMP',
  6: 'XJQZXJQAEIOUAEIOERSTLNSTADGHBCMPFWHY',
  7: 'XJQZXJQZXJAEIOUAEIOUAEIORSTLNSTAEIRDGHBCMPFWHYDVK'
});
export function boardIsPlayable(tiles) {
  const vowels = tiles.filter(tile => 'AEIOU'.includes(tile.letter)).length;
  return vowels >= Math.ceil(tiles.length * .25) && vowels <= Math.floor(tiles.length * .5) && legalWords({ tiles, history: [] }).length >= 20;
}
export function createBoard(size, seed = 'default', attempts = 100) {
  if (![5, 6, 7].includes(size)) fail('INVALID_INPUT', 'Board size must be 5, 6, or 7.');
  const build = letters => [...letters].map((letter, id) => ({ id, letter, owner: null }));
  const quotas = letterQuotas(size);
  for (let attempt = 0; attempt < attempts; attempt++) {
    const random = seededRandom(`${seed}:${attempt}`);
    const draw = distribution => distribution[Math.floor(random() * distribution.length)];
    // Balance hard letters across X/J/Q/Z; provide U for Q and useful E/T/S anchors.
    const hardCycle = shuffle([...letterGroups.hard], random);
    const hard = Array.from({ length: quotas.hard }, (_, i) => hardCycle[i % hardCycle.length]);
    const easy = ['U', 'E', 'T', 'S'];
    for (let vowels = 2; vowels < Math.ceil(size * size * .25); vowels++) easy.push(draw(vowelDistribution));
    while (easy.length < quotas.easy) easy.push(draw(easyDistribution));
    const other = Array.from({ length: quotas.other }, () => draw(otherDistribution));
    const tiles = build(shuffle([...hard, ...easy, ...other], random));
    if (boardIsPlayable(tiles)) return tiles;
  }
  return build(fallbackLetters[size]);
}
export function getScores(game) {
  const scores = Object.fromEntries(game.seats.map(seat => [seat.id, 0]));
  for (const tile of game.tiles) if (tile.owner !== null) scores[tile.owner]++;
  return scores;
}
export function getDefended(game) {
  const n = game.boardSize;
  return game.tiles.filter(tile => {
    if (tile.owner === null) return false;
    if (game.rules?.permanentDefense && tile.permanentlyDefended) return true;
    const r = Math.floor(tile.id / n), c = tile.id % n;
    const neighbors = [];
    if (r > 0) neighbors.push(tile.id - n);
    if (r < n - 1) neighbors.push(tile.id + n);
    if (c > 0) neighbors.push(tile.id - 1);
    if (c < n - 1) neighbors.push(tile.id + 1);
    return neighbors.every(id => game.tiles[id].owner === tile.owner);
  }).map(tile => tile.id);
}
export function applyAction(game, seatId, action) {
  if (game.status !== 'active') fail('GAME_FINISHED', 'This game is not active.');
  if (game.seats[game.currentSeatIndex].id !== seatId) fail('NOT_YOUR_TURN', 'Wait for your turn.');
  if (!action || !['word', 'pass'].includes(action.type)) fail('INVALID_INPUT', 'Choose a word or pass.');
  if (action.expectedRevision !== undefined && action.expectedRevision !== game.revision) fail('STALE_REVISION', 'Refresh the game before playing.');
  const next = structuredClone(game);
  next.revision++;
  if (game.rules?.permanentDefense) for (const id of getDefended(game)) next.tiles[id].permanentlyDefended = true;
  const record = { turn: game.history.length + 1, actor: seatId, type: action.type, revision: next.revision };
  if (action.type === 'word') {
    const ids = action.tileIds;
    if (!Array.isArray(ids) || ids.length < 2 || ids.length > game.tiles.length || new Set(ids).size !== ids.length || ids.some(id => !Number.isInteger(id) || id < 0 || id >= game.tiles.length)) fail('INVALID_INPUT', 'Select at least two distinct board tiles.');
    if (game.rules?.exclusiveDefense) {
      const usable = new Set(usableTiles(game, seatId).map(tile => tile.id));
      if (ids.some(id => !usable.has(id))) fail('DEFENDED_TILE', 'Exclusive Defense prevents using another player’s defended tiles.');
    }
    const word = ids.map(id => game.tiles[id].letter).join('');
    if (!wordSet.has(word)) fail('INVALID_WORD', 'That word is not in the game dictionary.');
    if (game.history.some(entry => entry.type === 'word' && entry.word === word)) fail('WORD_ALREADY_USED', 'That word has already been played.');
    if (isBlocked(word, game.history)) fail('WORD_IS_PREFIX', 'That word is a prefix of an earlier word.');
    const defended = new Set(getDefended(game));
    for (const id of ids) if (!defended.has(id)) next.tiles[id].owner = seatId;
    Object.assign(record, { word, tileIds: [...ids] });
    next.consecutivePasses = 0;
  } else next.consecutivePasses++;
  if (game.rules?.permanentDefense) for (const id of getDefended(next)) next.tiles[id].permanentlyDefended = true;
  next.history.push(record);
  const reason = next.tiles.every(tile => tile.owner !== null) ? 'board_full' : next.consecutivePasses >= next.seats.length ? 'all_passed' : null;
  if (reason) {
    next.status = 'finished';
    const scores = getScores(next), highest = Math.max(...Object.values(scores));
    next.result = { reason, winnerIds: next.seats.filter(seat => scores[seat.id] === highest).map(seat => seat.id) };
  } else next.currentSeatIndex = (next.currentSeatIndex + 1) % next.seats.length;
  return next;
}
function randomIndex(length, rng) {
  const value = rng();
  if (!Number.isFinite(value) || value < 0 || value >= 1) fail('INVALID_RANDOM', 'Random source must return a number in [0, 1).');
  return Math.floor(value * length);
}
export function chooseBotAction(game, rng = Math.random) {
  if (game.status !== 'active') fail('GAME_FINISHED', 'This game is not active.');
  const candidates = legalWords(game);
  if (!candidates.length) return { type: 'pass' };
  const word = candidates[randomIndex(candidates.length, rng)];
  const available = usableTiles(game), tileIds = [];
  for (const letter of word) {
    const matches = available.filter(tile => tile.letter === letter);
    const chosen = matches[randomIndex(matches.length, rng)];
    tileIds.push(chosen.id);
    available.splice(available.indexOf(chosen), 1);
  }
  return { type: 'word', tileIds };
}
