import test from 'node:test';
import assert from 'node:assert/strict';
import { opponentMoves, toggleTile, reorderSelection, tileAppearance, canPlay, reconcileSelection, errorMessage, MARKERS } from '../apps/web/model.js';
import { renderTile } from '../apps/web/composer.js';
test('selection appends nonadjacent tiles and removes without reordering', () => { const initial = [2, 18]; assert.deepEqual(toggleTile(initial, 4), [2, 18, 4]); assert.deepEqual(toggleTile([2, 18, 4], 18), [2, 4]); assert.deepEqual(initial, [2, 18]); });
test('only active current human may compose a word', () => { const game = { status: 'active', currentSeatIndex: 0, seats: [{ id: 'a', kind: 'human' }, { id: 'b', kind: 'bot' }] }; assert.equal(canPlay(game, 'a'), true); assert.equal(canPlay(game, 'b'), false); assert.equal(canPlay({ ...game, currentSeatIndex: 1 }, 'b'), false); assert.equal(canPlay({ ...game, status: 'finished' }, 'a'), false); assert.equal(canPlay(null, 'a'), false); });
test('unchanged polling preserves selection; revisions and game changes clear it', () => { const game = { id: 'g', revision: 2 }; assert.deepEqual(reconcileSelection(game, { ...game }, [1, 8]), [1, 8]); assert.deepEqual(reconcileSelection(game, { ...game, revision: 3 }, [1, 8]), []); assert.deepEqual(reconcileSelection(game, { ...game, id: 'h' }, [1, 8]), []); assert.deepEqual(reconcileSelection(null, game, [1]), []); });
test('errors distinguish stale state, word history and network failures', () => { assert.match(errorMessage({ code: 'STALE_REVISION' }), /selection was cleared/); assert.match(errorMessage({ code: 'WORD_ALREADY_USED' }), /already been played/); assert.match(errorMessage({ code: 'WORD_IS_PREFIX' }), /longer word/); assert.equal(errorMessage({ code: 'NETWORK', message: 'Offline' }), 'Offline'); assert.match(errorMessage({}), /Something went wrong/); assert.equal(new Set(MARKERS).size, 4); });

test('reordering moves the exact selected tile without duplicates or mutations', () => {
  const initial = [4, 19, 2, 13];
  assert.deepEqual(reorderSelection(initial, 0, 3), [19, 2, 13, 4]);
  assert.deepEqual(reorderSelection(initial, 3, 0), [13, 4, 19, 2]);
  assert.deepEqual(reorderSelection(initial, 1, 1), initial);
  for (const [from, to] of [[-1, 2], [0, 4], [0.5, 1], [0, NaN]]) assert.deepEqual(reorderSelection(initial, from, to), initial);
  assert.deepEqual(initial, [4, 19, 2, 13]);
});

test('tile presentation keeps ownership and defense independent of selection', () => {
  const game = { seats: [{ id: 'a', index: 0, displayName: 'Ada' }, { id: 'b', index: 1, displayName: 'Bob' }], defended: [12] };
  assert.deepEqual(tileAppearance(game, { id: 12, owner: 'b' }), { colorClass: 'p1', marker: MARKERS[1], ownership: 'owned by Bob', defended: true });
  assert.deepEqual(tileAppearance(game, { id: 3, owner: null }), { colorClass: '', marker: '', ownership: 'unclaimed', defended: false });
});

test('defended styling and accessible marker are shared by grid and selected word tiles', () => {
  const game = { boardSize: 5, seats: [{ id: 'a', index: 0, displayName: 'Ada' }], defended: [12] };
  const tile = { id: 12, letter: 'C', owner: 'a' };
  for (const options of [{ selectedIndex: 0 }, { wordIndex: 0 }]) {
    const html = renderTile(game, tile, options);
    assert.match(html, /class="tile p0 defended/);
    assert.match(html, /owned by Ada, protected/);
    assert.match(html, /class="protected"/);
  }
  assert.doesNotMatch(renderTile({ ...game, defended: [] }, tile), /class="tile p0 defended|class="protected"/);
});

test('replay latest opponent action on entry and all newly observed opponent actions during play', () => {
  const history = [{ turn: 1, actor: 'me', type: 'word' }, { turn: 2, actor: 'bot', type: 'word' }, { turn: 3, actor: 'friend', type: 'pass' }];
  const game = { id: 'g', history };
  assert.deepEqual(opponentMoves(null, game, 'me'), [history[2]]);
  assert.deepEqual(opponentMoves(null, game, 'friend'), []);
  assert.deepEqual(opponentMoves({ id: 'g', history: history.slice(0, 1) }, game, 'me'), history.slice(1));
  assert.deepEqual(opponentMoves(game, game, 'me'), []);
  assert.deepEqual(opponentMoves({ id: 'other', history }, game, 'me'), [history[2]]);
  assert.deepEqual(opponentMoves(null, game, null), []);
  assert.deepEqual(opponentMoves(null, { id: 'g', history: [] }, 'me'), []);
});
