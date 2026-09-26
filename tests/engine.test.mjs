import test from 'node:test';
import assert from 'node:assert/strict';
import { dictionaryMetadata } from '../packages/engine/dictionary.mjs';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createBoard, boardIsPlayable, fallbackLetters, seededRandom, words, dictionaryVersion, letterGroups, letterQuotas, getDefended, getScores, applyAction, legalWords, chooseBotAction } from '../packages/engine/index.mjs';
function game(n = 5, players = 2, letters = 'CATSQUARTZAEIOURNLDBMPEGHS') {
  return { id: 'test', status: 'active', revision: 1, boardSize: n, seats: Array.from({ length: players }, (_, index) => ({ id: `p${index}`, index, kind: index ? 'bot' : 'human', displayName: `Player ${index}` })), tiles: Array.from({ length: n*n }, (_, id) => ({ id, letter: letters[id % letters.length], owner: null })), currentSeatIndex: 0, consecutivePasses: 0, history: [] };
}
function ids(g, word) { const unused = [...g.tiles]; return [...word].map(letter => { const index = unused.findIndex(tile => tile.letter === letter); assert.ok(index >= 0); return unused.splice(index,1)[0].id; }); }
function play(g, word) { return applyAction(g, g.seats[g.currentSeatIndex].id, { type: 'word', tileIds: ids(g, word) }); }
function rejects(g, action, code, seat = 'p0') { const before = structuredClone(g); assert.throws(() => applyAction(g, seat, action), { code }); assert.deepEqual(g, before); }
test('dictionary is normalized, unique, alphabetic and substantial', () => { assert.ok(words.length > 1000); assert.equal(words.length, new Set(words).size); assert.ok(words.every(word => /^[A-Z]{2,49}$/.test(word))); assert.equal(dictionaryVersion, 'scowl-2026.02.25-en-US-60-v1'); });
test('seeded generators and fallback boards satisfy quality for all sizes', () => {
  for (const size of [5,6,7]) {
    const tiles = createBoard(size, 'fixture');
    assert.deepEqual(tiles, createBoard(size, 'fixture'));
    assert.equal(tiles.length, size*size);
    assert.equal(new Set(tiles.map(t => t.id)).size, size*size);
    assert.ok(tiles.every(t => /^[A-Z]$/.test(t.letter) && t.owner === null));
    assert.ok(boardIsPlayable(tiles));
    assert.equal(fallbackLetters[size].length, size*size);
    assert.ok(boardIsPlayable(createBoard(size, 'fallback', 0)));
    for (const count of [2,3,4]) { const g = game(size, count); g.tiles = tiles; assert.equal(play(g, legalWords(g)[0]).currentSeatIndex, 1); }
  }
  assert.throws(() => createBoard(8), { code: 'INVALID_INPUT' });
  assert.deepEqual(createBoard(5), createBoard(5));
  assert.ok(!boardIsPlayable(game(5,2,'Z').tiles));
  assert.ok(!boardIsPlayable(game(5,2,'A').tiles));
  assert.ok(!boardIsPlayable(game(5,2,'QZQZQZQZA').tiles));
  const a = seededRandom('same'), b = seededRandom('same'); for(let i=0;i<5;i++) assert.equal(a(), b());
});
test('defense uses pre-move orthogonal owners including edges, ignores diagonals', () => {
  const g = game();
  for (const id of [0,1,2,5,6,7,10,11,12]) g.tiles[id].owner = 'p1';
  assert.deepEqual(getDefended(g), [0,1,5,6]);
  g.tiles[6].owner = null;
  assert.deepEqual(getDefended(g), [0]);
  g.tiles[6].owner = 'p1';
  g.tiles[1].letter = 'C'; g.tiles[2].letter = 'A'; g.tiles[6].letter = 'T';
  const next = applyAction(g, 'p0', {type:'word',tileIds:[1,2,6]});
  assert.equal(next.tiles[1].owner, 'p1'); assert.equal(next.tiles[6].owner, 'p1'); assert.equal(next.tiles[2].owner, 'p0');
  assert.ok(!getDefended(next).includes(1));
  assert.equal(g.tiles[2].owner, 'p1');
});
test('captures from multiple opponents simultaneously and permits zero captures', () => {
  const g = game(5,4); g.tiles[0].owner='p1'; g.tiles[1].owner='p2'; g.tiles[2].owner='p3';
  const next = play(g,'CAT'); assert.deepEqual(getScores(next), {p0:3,p1:0,p2:0,p3:0});
  const defended = game(); for(const t of defended.tiles) t.owner='p1'; defended.tiles[24].owner=null;
  const unchanged = play(defended,'CAT'); assert.equal(getScores(unchanged).p0,0); assert.equal(unchanged.history[0].word,'CAT');
});
test('word records, pass reset, prefix direction, turns and input immutability', () => {
  const g=game(); g.consecutivePasses=1; const before=structuredClone(g);
  const next=play(g,'QUART'); assert.deepEqual(g,before); assert.equal(next.revision,2); assert.equal(next.consecutivePasses,0);
  assert.deepEqual(next.history[0],{turn:1,actor:'p0',type:'word',revision:2,word:'QUART',tileIds:ids(g,'QUART')});
  const extended=play(next,'QUARTZ'); assert.equal(extended.currentSeatIndex,0);
  rejects(extended,{type:'word',tileIds:ids(g,'QUARTZ')},'WORD_ALREADY_USED');
  const onlyLong=game(); onlyLong.history=[{type:'word',word:'QUARTZ'}]; rejects(onlyLong,{type:'word',tileIds:ids(g,'QUART')},'WORD_IS_PREFIX');
});
test('invalid requests never mutate state', () => {
  const g=game();
  rejects(g,{type:'pass'},'NOT_YOUR_TURN','p1');
  for(const action of [null,{}, {type:'unknown'}]) rejects(g,action,'INVALID_INPUT');
  rejects(g,{type:'pass',expectedRevision:0},'STALE_REVISION');
  for(const tileIds of [undefined, [], [0], [0,0], [-1,2], [0,25], [0,.5], ['0',1], Array.from({length:26},(_,i)=>i)]) rejects(g,{type:'word',tileIds},'INVALID_INPUT');
  rejects(g,{type:'word',tileIds:[4,9]},'INVALID_WORD');
  assert.equal(applyAction(g,'p0',{type:'pass',expectedRevision:1}).revision,2);
  g.status='finished'; rejects(g,{type:'pass'},'GAME_FINISHED');
});
test('all player counts finish by consecutive passes with shared winners', () => {
  for(const count of [2,3,4]) {
    let g=game(5,count);
    for(let i=0;i<count;i++) g=applyAction(g,`p${i}`,{type:'pass'});
    assert.equal(g.status,'finished'); assert.equal(g.result.reason,'all_passed'); assert.deepEqual(g.result.winnerIds,g.seats.map(s=>s.id)); assert.equal(g.history.length,count);
  }
});
test('full board finishes with highest score and scores equal owned tiles', () => {
  const g=game(); for(const tile of g.tiles) tile.owner='p0'; g.tiles[0].owner=null;
  const next=play(g,'CAT'); assert.equal(next.status,'finished'); assert.deepEqual(next.result,{reason:'board_full',winnerIds:['p0']}); assert.equal(getScores(next).p0,25);
  assert.equal(Object.values(getScores(g)).reduce((a,b)=>a+b,0),g.tiles.filter(t=>t.owner!==null).length);
});
test('bot picks every distinct candidate by controlled RNG and never repeats tiles', () => {
  const g=game(); const candidates=legalWords(g);
  candidates.forEach((word,index)=>{ let first=true; const action=chooseBotAction(g,()=>{if(first){first=false;return (index+.5)/candidates.length;}return .999999;}); assert.equal(action.type,'word'); assert.equal(new Set(action.tileIds).size,action.tileIds.length); assert.equal(action.tileIds.map(id=>g.tiles[id].letter).join(''),word); assert.equal(applyAction(g,'p0',action).history[0].word,word); });
  for(const size of [5,6,7]) { const board=game(size); board.tiles=createBoard(size,'bot'); assert.equal(applyAction(board,'p0',chooseBotAction(board,()=>0)).history.length,1); }
  const repeated=game(5,2,'EEL'); const action=chooseBotAction(repeated,()=>0); assert.equal(new Set(action.tileIds).size,action.tileIds.length);
});
test('bot honors history and counts, passes only on exhaustion, propagates errors', () => {
  const g=game(); g.history=legalWords(g).map(word=>({type:'word',word})); assert.deepEqual(chooseBotAction(g),{type:'pass'});
  const empty=game(5,2,'Z'); assert.deepEqual(chooseBotAction(empty),{type:'pass'});
  const playing=game();
  let seenE = false;
  for (const tile of playing.tiles) if (tile.letter === 'E') { if (seenE) tile.letter = 'Z'; seenE = true; }
  assert.ok(!legalWords(playing).includes('TEETH'));
  for(const value of [NaN,-.1,1,Infinity]) assert.throws(()=>chooseBotAction(playing,()=>value),{code:'INVALID_RANDOM'});
  assert.throws(()=>chooseBotAction(playing,()=>{throw new Error('broken');}),/broken/);
  playing.status='finished'; assert.throws(()=>chooseBotAction(playing),{code:'GAME_FINISHED'});
});


test('hard/easy/other quotas and playable vowels hold across sizes, seeds and fallbacks', () => {
  const expected = { 5: { hard:5,easy:13,other:7 }, 6: { hard:7,easy:18,other:11 }, 7: { hard:10,easy:25,other:14 } };
  for (const size of [5,6,7]) {
    assert.deepEqual(letterQuotas(size), expected[size]);
    const boards = [createBoard(size, 'forced-fallback', 0), ...Array.from({length:30}, (_, i) => createBoard(size, 'quota-' + i))];
    for (const tiles of boards) {
      assert.equal(tiles.length, size*size);
      for (const [group, letters] of Object.entries(letterGroups)) assert.equal(tiles.filter(tile => letters.includes(tile.letter)).length, expected[size][group]);
      for (const letter of 'XJQZUEST') assert.ok(tiles.some(tile => tile.letter === letter));
      assert.ok(boardIsPlayable(tiles));
    }
  }
});

test('HARSH and its common forms are accepted by both validation and bot vocabulary', () => {
  for (const word of ['HARSH','HARSHER','HARSHEST','HARSHLY','HARSHNESS']) {
    const g = game(5, 2, word);
    assert.ok(legalWords(g).includes(word));
    assert.equal(play(g, word).history[0].word, word);
  }
});

test('SCOWL artifact matches its pinned metadata, copyright and word filtering policy', () => {
  assert.equal(words.length, 78659);
  assert.equal(words.length, dictionaryMetadata.wordCount);
  assert.equal(dictionaryMetadata.commit, '7e99edab8e32f9f9ea2b15f249ca8d4d67237410');
  const source = readFileSync(new URL('../packages/engine/data/scowl-en-US-60.txt', import.meta.url));
  assert.equal(createHash('sha256').update(source).digest('hex'), dictionaryMetadata.sha256);
  const copyright = readFileSync(new URL('../packages/engine/data/SCOWL-Copyright.txt', import.meta.url));
  assert.equal(createHash('sha256').update(copyright).digest('hex'), dictionaryMetadata.copyrightSha256);
  assert.deepEqual(readFileSync(new URL('../apps/web/dictionary-license.txt', import.meta.url)), copyright);
  for (const word of ['HARSH', 'ELEPHANT', 'COMPUTER', 'RUNNING', 'QUARTZ', 'DICTIONARY']) assert.ok(words.includes(word));
  for (const word of ['LONDON', 'NASA', 'A', 'I', "DON'T", 'ZZZZNOTAWORD']) assert.ok(!words.includes(word));
});

test('a word is blocked globally for every player, including different physical tiles', () => {
  let current = game(5, 4, 'CATCATABCDEFGHIJKLMNOPQRS');
  current = applyAction(current, 'p0', { type: 'word', tileIds: [0, 1, 2] });
  for (const player of ['p1', 'p2', 'p3']) {
    rejects(current, { type: 'word', tileIds: [3, 4, 5] }, 'WORD_ALREADY_USED', player);
    assert.ok(!legalWords(current).includes('CAT'));
    current = applyAction(current, player, { type: 'pass' });
  }
  rejects(current, { type: 'word', tileIds: [3, 4, 5] }, 'WORD_ALREADY_USED', 'p0');
});

test('surrounded tile resists a word, loses defense with a neighbor, and can then be stolen', () => {
  let g = game();
  for (const id of [12, 7, 11, 13, 17]) g.tiles[id].owner = 'p1';
  for (const [id, letter] of [[12, 'C'], [7, 'A'], [2, 'T'], [3, 'S']]) g.tiles[id].letter = letter;
  assert.ok(getDefended(g).includes(12));
  g = applyAction(g, 'p0', { type: 'word', tileIds: [12, 7, 2] });
  assert.equal(g.tiles[12].owner, 'p1');
  assert.equal(g.tiles[7].owner, 'p0');
  assert.ok(!getDefended(g).includes(12));
  g = applyAction(g, 'p1', { type: 'pass' });
  g = applyAction(g, 'p0', { type: 'word', tileIds: [12, 7, 2, 3] });
  assert.equal(g.tiles[12].owner, 'p0');
});
test('permanent defense survives losing neighbors and persists through serialization', () => {
  for (const permanentDefense of [false,true]) {
    const g=game(); g.rules={permanentDefense};
    for(const id of [0,1,5]) g.tiles[id].owner='p1';
    g.tiles[0].letter='C';g.tiles[1].letter='A';g.tiles[2].letter='T';
    const next=applyAction(g,'p0',{type:'word',tileIds:[0,1,2]});
    assert.equal(next.tiles[0].owner,'p1');
    assert.equal(getDefended(JSON.parse(JSON.stringify(next))).includes(0),permanentDefense);
    assert.equal(g.tiles[0].permanentlyDefended,undefined);
  }
  const g=game();g.rules={permanentDefense:true};g.tiles[0].letter='C';g.tiles[1].letter='A';g.tiles[5].letter='T';
  const next=applyAction(g,'p0',{type:'word',tileIds:[0,1,5]});
  assert.equal(next.tiles[0].permanentlyDefended,true);
});
test('exclusive defense rejects opponent letters but allows own, and bots obey both options', () => {
  for(const permanentDefense of [false,true]) {
    const g=game(5,4);g.rules={permanentDefense,exclusiveDefense:true};
    for(const id of [0,1,5]) g.tiles[id].owner='p1';
    rejects(g,{type:'word',tileIds:[0,1,2]},'DEFENDED_TILE');
    g.currentSeatIndex=1;
    assert.equal(applyAction(g,'p1',{type:'word',tileIds:[0,1,2]}).history[0].word,'CAT');
    g.currentSeatIndex=0;
    for(let i=0;i<20;i++) {
      const action=chooseBotAction(g,seededRandom(i));
      assert.ok(!action.tileIds?.includes(0));
      assert.doesNotThrow(()=>applyAction(g,'p0',action));
    }
    for(const tile of g.tiles)tile.owner='p1';
    assert.deepEqual(chooseBotAction(g),{type:'pass'});
  }
});
