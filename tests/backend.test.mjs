import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../services/local/server.mjs';
import { DatabaseSync } from 'node:sqlite';
import { chooseBotAction, seededRandom } from '../packages/engine/index.mjs';

const credential = () => randomBytes(24).toString('base64url');
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(),'wordboogie-api-'));
  const databasePath = join(directory,'test.sqlite');
  let app = createApp({databasePath,botIntervalMs:0,seed:'backend-tests',...options});
  const listen = () => new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  await listen();
  t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
  const request = async (path,body,bearer,method = body ? 'POST':'GET') => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}${path}`,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(bearer?{Authorization:`Bearer ${bearer}`}:{})},...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,...await response.json()};
  };
  return {request, databasePath, get app(){return app;},restart:async()=>{await app.close();app=createApp({databasePath,botIntervalMs:0,seed:'backend-tests',...options});await listen();}};
}
const createBody = (seatTypes = ['human','bot'],boardSize=5) => ({displayName:'Host',boardSize,playerCount:seatTypes.length,seatTypes,requestId:randomUUID(),guestToken:credential()});

test('create and join retries persist across restart without claiming additional seats',async t=>{
  const f=await fixture(t), body=createBody(['human','human']);
  const created=await f.request('/games',body);assert.equal(created.status,200);assert.equal(created.game.status,'lobby');
  assert.deepEqual(await f.request('/games',body),created);
  assert.equal((await f.request('/games',{...body,boardSize:6})).code,'IDEMPOTENCY_CONFLICT');
  const joinBody={inviteToken:created.inviteToken,displayName:'Guest',guestToken:credential(),requestId:randomUUID()};
  const joined=await f.request(`/games/${created.game.id}/join`,joinBody);assert.equal(joined.status,200);
  await f.restart();assert.deepEqual(await f.request(`/games/${created.game.id}/join`,joinBody),joined);
  assert.equal((await f.request(`/games/${created.game.id}`,null,joinBody.guestToken)).seatId,joined.seatId);
  assert.equal((await f.request(`/games/${created.game.id}`)).status,401);
  assert.equal((await f.request(`/games/${created.game.id}`,null,created.inviteToken)).status,401);
});

test('concurrent last-seat joins serialize; host rights and invite rotation are enforced',async t=>{
  const f=await fixture(t), body=createBody(['human','human']), created=await f.request('/games',body), path=`/games/${created.game.id}`;
  const premature=await f.request(`${path}/start`,{expectedRevision:0,requestId:randomUUID()},body.guestToken);assert.equal(premature.status,400);
  const claims=['Alice','Bob'].map(displayName=>({inviteToken:created.inviteToken,displayName,guestToken:credential(),requestId:randomUUID()}));
  const results=await Promise.all(claims.map(payload=>f.request(`${path}/join`,payload)));
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  const winner=results.findIndex(r=>r.status===200);
  assert.equal((await f.request(`${path}/start`,{expectedRevision:1,requestId:randomUUID()},claims[winner].guestToken)).status,403);
  const configuration={boardSize:7,playerCount:2,seatTypes:['human','bot'],expectedRevision:1,requestId:randomUUID()};
  assert.equal((await f.request(`${path}/lobby`,configuration,body.guestToken,'PATCH')).code,'INVALID_INPUT');
  assert.equal((await f.request(path,null,body.guestToken)).game.revision,1);
  const rotated=await f.request(`${path}/invite`,{expectedRevision:1,requestId:randomUUID()},body.guestToken);assert.equal(rotated.status,200);
  assert.equal((await f.request('/invites/resolve',{inviteToken:created.inviteToken})).code,'INVITE_INVALID');
  const started=await f.request(`${path}/start`,{expectedRevision:2,requestId:randomUUID()},body.guestToken);assert.equal(started.game.status,'active');
  assert.equal((await f.request('/invites/resolve',{inviteToken:rotated.inviteToken})).status,409);
});

test('competing moves commit once, retries return original move, and bots recover after restart',async t=>{
  const f=await fixture(t), body=createBody(['human','bot','bot']), created=await f.request('/games',body), path=`/games/${created.game.id}`;
  const started=await f.request(`${path}/start`,{expectedRevision:0,requestId:randomUUID()},body.guestToken);assert.equal(started.game.tiles.length,25);
  const actions=[0,1].map(()=>({type:'pass',expectedRevision:1,requestId:randomUUID()}));
  const results=await Promise.all(actions.map(payload=>f.request(`${path}/actions`,payload,body.guestToken)));
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  const index=results.findIndex(r=>r.status===200);assert.deepEqual(await f.request(`${path}/actions`,actions[index],body.guestToken),results[index]);
  await f.restart();f.app.runBots();f.app.runBots();
  const current=await f.request(path,null,body.guestToken);assert.equal(current.game.revision,4);assert.equal(current.game.history.length,3);assert.equal(current.game.currentSeatIndex,0);
  f.app.runBots();assert.equal((await f.request(path,null,body.guestToken)).game.revision,4);
  const history=await f.request(`${path}/history`,null,body.guestToken);assert.equal(history.items.length,3);
});

test('all board sizes/player counts start, lobby rejects occupied-seat removal, and expiration is enforced',async t=>{
  let clock=Date.parse('2026-01-01T00:00:00Z');const f=await fixture(t,{now:()=>clock});
  for(const size of [5,6,7]) for(const count of [2,3,4]) {
    const body=createBody(['human',...Array(count-1).fill('bot')],size), created=await f.request('/games',body);
    const started=await f.request(`/games/${created.game.id}/start`,{expectedRevision:0,requestId:randomUUID()},body.guestToken);
    assert.equal(started.game.tiles.length,size*size);assert.equal(started.game.seats.length,count);
  }
  const body=createBody(),created=await f.request('/games',body);
  clock+=31*86400000;assert.equal((await f.request(`/games/${created.game.id}`,null,body.guestToken)).code,'GAME_EXPIRED');
  assert.equal((await f.request('/games',body)).code,'GAME_EXPIRED');
});

test('complete human and bot games for every supported size and player count',async t=>{
  const f=await fixture(t,{rng:seededRandom('complete-bots')});
  const humanRandom = seededRandom('complete-human');
  for(const size of [5,6,7]) for(const count of [2,3,4]) {
    const body=createBody(['human',...Array(count-1).fill('bot')],size), created=await f.request('/games',body), path=`/games/${created.game.id}`;
    let {game}=await f.request(`${path}/start`,{expectedRevision:0,requestId:randomUUID()},body.guestToken);
    for(let turns=0;game.status==='active' && turns<1500;turns++) {
      if(game.currentSeatIndex===0) {
        const result=await f.request(`${path}/actions`,{...chooseBotAction(game,humanRandom),expectedRevision:game.revision,requestId:randomUUID()},body.guestToken);
        assert.equal(result.status,200,JSON.stringify(result));game=result.game;
      } else {f.app.runBots();game=(await f.request(path,null,body.guestToken)).game;}
    }
    assert.equal(game.status,'finished',`${size}x${size}/${count} players`);
    assert.ok(game.result.winnerIds.length>0);
    assert.equal(Object.values(game.scores).reduce((sum,n)=>sum+n,0),game.tiles.filter(tile=>tile.owner!==null).length);
  }
});

test('background timer advances consecutive bots without any client polling',async t=>{
  const f=await fixture(t,{botIntervalMs:10,rng:()=>0.5});
  const body=createBody(['human','bot','bot']),created=await f.request('/games',body),path=`/games/${created.game.id}`;
  await f.request(`${path}/start`,{expectedRevision:0,requestId:randomUUID()},body.guestToken);
  await f.request(`${path}/actions`,{type:'pass',expectedRevision:1,requestId:randomUUID()},body.guestToken);
  // This integration check exercises real scheduling; engine unit tests inject RNG.
  await new Promise(resolve=>setTimeout(resolve,500));
  const {game}=await f.request(path,null,body.guestToken);
  assert.equal(game.revision,4);assert.equal(game.currentSeatIndex,0);
});

test('HTTP validation, origin restrictions and lobby changes reject invalid input', async t => {
  const f = await fixture(t);
  const base = `http://127.0.0.1:${f.app.server.address().port}`;
  assert.equal((await fetch(base + '/health')).status, 200);
  assert.equal((await fetch(base + '/health', { headers: { Origin: 'https://untrusted.example' } })).status, 403);
  const preflight = await fetch(base + '/games', { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  for (const body of ['{', '[]', 'null']) assert.equal((await fetch(base + '/games', { method: 'POST', body })).status, 400);
  assert.equal((await fetch(base + '/games', { method: 'POST', body: 'x'.repeat(17000) })).status, 413);
  assert.equal((await f.request('/unknown')).status, 404);
  assert.equal((await f.request('/games', { ...createBody(), guestToken: 'short' })).status, 400);
  assert.equal((await f.request('/games', { ...createBody(), requestId: 'bad' })).status, 400);
  assert.equal((await f.request('/games', { ...createBody(), boardSize: 8 })).status, 400);
  assert.equal((await f.request('/games', { ...createBody(), displayName: '' })).status, 400);
  const body = createBody(['human', 'human']), created = await f.request('/games', body), path = `/games/${created.game.id}`;
  const invalidJoin = { inviteToken: 'invalid', displayName: 'Guest', guestToken: credential(), requestId: randomUUID() };
  assert.equal((await f.request(`${path}/join`, invalidJoin)).status, 404);
  const guest = { ...invalidJoin, inviteToken: created.inviteToken, requestId: randomUUID() };
  await f.request(`${path}/join`, guest);
  const removal = { boardSize: 6, playerCount: 2, seatTypes: ['human', 'bot'], expectedRevision: 1, requestId: randomUUID() };
  assert.equal((await f.request(`${path}/lobby`, removal, body.guestToken, 'PATCH')).status, 400);
  const edited = await f.request(`${path}/lobby`, { ...removal, seatTypes: ['human', 'human'], requestId: randomUUID() }, body.guestToken, 'PATCH');
  assert.equal(edited.game.boardSize, 6);
  assert.equal((await f.request(`${path}/history?cursor=-1`, null, body.guestToken)).status, 400);
  assert.equal((await f.request(`${path}/actions`, { type: 'pass', expectedRevision: 2, requestId: randomUUID() })).status, 401);
});

test('bot computation failure preserves its turn and a later retry succeeds', async t => {
  let broken = true;
  const errors = [];
  const f = await fixture(t, { rng: () => { if (broken) throw new Error('test failure'); return 0.5; }, onBotError: error => errors.push(error) });
  const body = createBody(), created = await f.request('/games', body), path = `/games/${created.game.id}`;
  await f.request(`${path}/start`, { expectedRevision: 0, requestId: randomUUID() }, body.guestToken);
  await f.request(`${path}/actions`, { type: 'pass', expectedRevision: 1, requestId: randomUUID() }, body.guestToken);
  f.app.runBots();
  assert.equal(errors.length, 1);
  assert.equal((await f.request(path, null, body.guestToken)).game.revision, 2);
  broken = false; f.app.runBots();
  assert.equal((await f.request(path, null, body.guestToken)).game.revision, 3);
});


test('SCOWL migration accepts HARSH in a saved game without regenerating its board', async t => {
  const f = await fixture(t);
  const body = createBody(), created = await f.request('/games', body), path = '/games/' + created.game.id;
  const { game } = await f.request(path + '/start', { expectedRevision: 0, requestId: randomUUID() }, body.guestToken);
  game.dictionaryVersion = 'authored-en-starter-1';
  game.generatorVersion = 'weighted-seeded-1';
  'HARSH'.split('').forEach((letter, i) => { game.tiles[i].letter = letter; });
  const database = new DatabaseSync(f.databasePath);
  database.prepare('UPDATE games SET state=? WHERE id=?').run(JSON.stringify(game), game.id);
  database.close();
  await f.restart();
  const restored = (await f.request(path, null, body.guestToken)).game;
  assert.equal(restored.dictionaryVersion, 'scowl-2026.02.25-en-US-60-v1');
  assert.equal(restored.generatorVersion, 'weighted-seeded-1');
  assert.deepEqual(restored.tiles, game.tiles);
  const result = await f.request(path + '/actions', { type:'word', tileIds:[0,1,2,3,4], expectedRevision: game.revision, requestId: randomUUID() }, body.guestToken);
  assert.equal(result.status, 200);
  assert.equal(result.game.history[0].word, 'HARSH');
  assert.deepEqual(result.game.tiles.map(t => t.letter), game.tiles.map(t => t.letter));
});
test('optional rules validate, persist, appear in invites and cannot change after start',async t=>{
  const f=await fixture(t),body=createBody();body.rules={permanentDefense:true,exclusiveDefense:true};
  const created=await f.request('/games',body);assert.equal(created.status,200);
  const path=`/games/${created.game.id}`;
  assert.deepEqual(created.game.rules,body.rules);
  assert.deepEqual((await f.request('/invites/resolve',{inviteToken:created.inviteToken})).rules,body.rules);
  await f.restart();assert.deepEqual((await f.request(path,null,body.guestToken)).game.rules,body.rules);
  const started=await f.request(`${path}/start`,{expectedRevision:0,requestId:randomUUID()},body.guestToken);
  assert.deepEqual(started.game.rules,body.rules);
  assert.equal((await f.request(`${path}/lobby`,{...body,requestId:randomUUID(),expectedRevision:1,rules:{}},body.guestToken,'PATCH')).code,'GAME_STARTED');
  for(const rules of [{permanentDefense:'yes'},{unknown:true},[]]) assert.equal((await f.request('/games',{...createBody(),rules})).code,'INVALID_INPUT');
  assert.deepEqual((await f.request('/games',createBody())).game.rules,{permanentDefense:false,exclusiveDefense:false});
});
