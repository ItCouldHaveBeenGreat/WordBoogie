import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash, createHmac } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBoard, applyAction, chooseBotAction, getScores, getDefended, dictionaryVersion, generatorVersion, rulesVersion } from '../../packages/engine/index.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const invitation = (credential,gameId,requestId) => createHmac('sha256',credential).update(`invite:${gameId}:${requestId}`).digest('base64url');
const fail = (code, message, status = 400, extras = {}) => { throw Object.assign(new Error(message), {code, status, ...extras}); };
const validToken = value => typeof value === 'string' && /^[A-Za-z0-9_-]{22,256}$/.test(value);
const normalize = value => Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, normalize(value[k])])) : value;
const fingerprint = body => hash(JSON.stringify(normalize(body)));
const nameOf = value => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 24) fail('INVALID_INPUT', 'Display name must contain 1–24 characters.');
  return value.trim();
};

/** Local authoritative API. All writes, including idempotency records, commit together. */
export function createApp({databasePath = '.local/wordboogie.sqlite', frontendOrigin = 'http://localhost:5173', botIntervalMs = 500, seed, now = () => Date.now(), rng = Math.random, onBotError = () => {}} = {}) {
  if (databasePath !== ':memory:') mkdirSync(dirname(resolve(databasePath)), {recursive: true});
  const db = new DatabaseSync(databasePath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS games(id TEXT PRIMARY KEY, state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(game_id TEXT NOT NULL, token_hash TEXT NOT NULL, seat_id TEXT NOT NULL, PRIMARY KEY(game_id,token_hash));
    CREATE TABLE IF NOT EXISTS invites(game_id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL);
    CREATE TABLE IF NOT EXISTS requests(scope TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(scope,request_id));`);
  const transaction = fn => { db.exec('BEGIN IMMEDIATE'); try {const result = fn(); db.exec('COMMIT'); return result;} catch (error) {db.exec('ROLLBACK'); throw error;} };
  const read = id => {
    const row = db.prepare('SELECT state FROM games WHERE id=?').get(id);
    if (!row) fail('NOT_FOUND', 'Game not found.', 404);
    const game = JSON.parse(row.state);
    // Replace the starter vocabulary in saved games while preserving accepted history and letters.
    if (['authored-en-starter-1', 'authored-en-starter-2'].includes(game.dictionaryVersion)) game.dictionaryVersion = dictionaryVersion;
    if (Date.parse(game.expiresAt) <= now()) fail('GAME_EXPIRED', 'This game has expired.', 410);
    return game;
  };
  const save = game => {
    game.updatedAt = new Date(now()).toISOString();
    for (const record of game.history) if (!record.timestamp) record.timestamp = game.updatedAt;
    game.expiresAt = new Date(now() + 30 * 86400000).toISOString();
    db.prepare('INSERT INTO games(id,state) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state').run(game.id, JSON.stringify(game));
    return game;
  };
  const snapshot = game => ({...game, scores: getScores(game), defended: [...getDefended(game)]});
  const authenticate = (game, req) => {
    const raw = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
    if (!validToken(raw)) fail('UNAUTHORIZED', 'A player credential is required.', 401);
    const session = db.prepare('SELECT seat_id FROM sessions WHERE game_id=? AND token_hash=?').get(game.id, hash(raw));
    if (!session) fail('UNAUTHORIZED', 'This credential cannot access this game.', 401);
    return session.seat_id;
  };
  const hostOnly = (game, seatId) => {if (game.seats[0].id !== seatId) fail('FORBIDDEN', 'Only the host can do that.', 403);};
  const lobbyOnly = game => {if (game.status !== 'lobby') fail('GAME_STARTED', 'The game has already started.', 409);};
  const revision = (game, body) => {if (body.expectedRevision !== game.revision) fail('STALE_REVISION', 'The game changed. Refresh and try again.', 409, {currentRevision: game.revision});};
  const once = (scope, body, fn, credential = body.guestToken, operation = '') => {
    if (typeof body.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.requestId)) fail('INVALID_INPUT', 'A UUID requestId is required.');
    const digest = fingerprint({body,operation});
    const previous = db.prepare('SELECT fingerprint,response FROM requests WHERE scope=? AND request_id=?').get(scope,body.requestId);
    if (previous) {if (previous.fingerprint !== digest) fail('IDEMPOTENCY_CONFLICT', 'This request ID was used for different input.', 409); const response=JSON.parse(previous.response); if(response.game?.id)read(response.game.id); if(response.hasInvite){delete response.hasInvite;return wrapInvite(response.game,response.seatId,invitation(credential,response.game.id,body.requestId));} return response;}
    const result = fn();
    const persisted = {...result};
    if (persisted.inviteToken) {delete persisted.inviteToken;delete persisted.inviteUrl;persisted.hasInvite=true;}
    db.prepare('INSERT INTO requests VALUES (?,?,?,?)').run(scope,body.requestId,digest,JSON.stringify(persisted));
    return result;
  };
  const configure = (body, previous = []) => {
    const {boardSize,playerCount,seatTypes} = body;
    if (![5,6,7].includes(boardSize) || ![2,3,4].includes(playerCount) || !Array.isArray(seatTypes) || seatTypes.length !== playerCount || seatTypes[0] !== 'human' || seatTypes.some(kind => !['human','bot'].includes(kind))) fail('INVALID_INPUT','Choose 2–4 players and a board size of 5, 6, or 7.');
    for (const seat of previous) if (seat.kind === 'human' && seat.occupied && (seat.index >= playerCount || seatTypes[seat.index] !== 'human')) fail('INVALID_INPUT','An occupied human seat cannot be removed.');
    const seats = seatTypes.map((kind,index) => previous[index]?.kind === kind ? previous[index] : ({id: randomUUID(), index, kind, displayName: kind === 'bot' ? `Bot ${index + 1}` : null, occupied: kind === 'bot'}));
    const rules = body.rules ?? {};
    if (!rules || typeof rules !== 'object' || Array.isArray(rules) || Object.keys(rules).some(key => !['permanentDefense','exclusiveDefense'].includes(key)) || Object.values(rules).some(value => typeof value !== 'boolean')) fail('INVALID_INPUT','Defense rules must be boolean toggles.');
    return {boardSize,seats,rules:{permanentDefense:rules.permanentDefense ?? false,exclusiveDefense:rules.exclusiveDefense ?? false}};
  };
  const checkName = (seats,name) => {if (seats.some(s => s.displayName?.toLowerCase() === name.toLowerCase()) || /^bot [1-4]$/i.test(name)) fail('INVALID_INPUT','Choose a unique player name; Bot names are reserved.');};
  const setInvite = (game,raw) => {db.prepare('INSERT INTO invites VALUES (?,?) ON CONFLICT(game_id) DO UPDATE SET token_hash=excluded.token_hash').run(game.id,hash(raw)); return raw;};
  const inviteGame = raw => {
    if (!validToken(raw)) fail('INVITE_INVALID','The invite is invalid or revoked.',404);
    const row = db.prepare('SELECT game_id FROM invites WHERE token_hash=?').get(hash(raw));
    if (!row) fail('INVITE_INVALID','The invite is invalid or revoked.',404);
    const game = read(row.game_id); lobbyOnly(game); return game;
  };
  const wrapInvite = (game, seatId, inviteToken) => ({game:snapshot(game),seatId,inviteToken,inviteUrl:`${frontendOrigin.replace(/\/$/,'')}/#/join/${inviteToken}`});

  function route(req, body, url) {
    const path = url.pathname;
    if (req.method === 'GET' && path === '/health') return {ok:true,mode:'local'};
    if (req.method === 'POST' && path === '/games') {
      if (!validToken(body.guestToken)) fail('INVALID_INPUT','Provide a securely generated guest credential.');
      return transaction(() => once(`create:${hash(body.guestToken)}`,body,() => {
        const name = nameOf(body.displayName); const config = configure(body); checkName(config.seats,name);
        config.seats[0] = {...config.seats[0],displayName:name,occupied:true};
        const game = save({id:randomUUID(),schemaVersion:1,rulesVersion,dictionaryVersion,generatorVersion,seed:seed ?? randomBytes(8).toString('hex'),status:'lobby',revision:0,...config,tiles:[],currentSeatIndex:0,consecutivePasses:0,history:[],createdAt:new Date(now()).toISOString()});
        db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(game.id,hash(body.guestToken),game.seats[0].id);
        return wrapInvite(game,game.seats[0].id,setInvite(game,invitation(body.guestToken,game.id,body.requestId)));
      }));
    }
    if (req.method === 'POST' && path === '/invites/resolve') {
      const game = inviteGame(body.inviteToken);
      return {gameId:game.id,boardSize:game.boardSize,seats:game.seats,status:game.status,rules:game.rules};
    }
    const match = path.match(/^\/games\/([^/]+)(?:\/(join|lobby|invite|start|actions|history))?$/);
    if (!match) fail('NOT_FOUND','Endpoint not found.',404);
    const [,id,action] = match;
    if (req.method === 'POST' && action === 'join') {
      if (!validToken(body.guestToken)) fail('INVALID_INPUT','Provide a securely generated guest credential.');
      return transaction(() => {read(id); return once(`join:${id}:${hash(body.guestToken)}`,body,() => {
        const game = inviteGame(body.inviteToken); if (game.id !== id) fail('INVITE_INVALID','This invite belongs to another game.',403);
        const existing = db.prepare('SELECT seat_id FROM sessions WHERE game_id=? AND token_hash=?').get(id,hash(body.guestToken));
        if (existing) return {game:snapshot(game),seatId:existing.seat_id};
        const seat = game.seats.find(s => s.kind === 'human' && !s.occupied); if (!seat) fail('GAME_FULL','All human seats are occupied.',409);
        const name = nameOf(body.displayName); checkName(game.seats,name); Object.assign(seat,{displayName:name,occupied:true}); game.revision++;
        db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(id,hash(body.guestToken),seat.id); save(game);
        return {game:snapshot(game),seatId:seat.id};
      });});
    }
    if (req.method === 'GET') {
      const game = read(id), seatId = authenticate(game,req);
      if (!action) return {game:snapshot(game),seatId};
      if (action === 'history') {const cursor = Number(url.searchParams.get('cursor') ?? 0); if (!Number.isInteger(cursor) || cursor < 0) fail('INVALID_INPUT','Invalid history cursor.'); const items=game.history.slice(cursor,cursor+50); return {items,nextCursor:cursor+items.length<game.history.length?String(cursor+items.length):null};}
    }
    if ((req.method === 'POST' && ['start','actions','invite'].includes(action)) || (req.method === 'PATCH' && action === 'lobby')) return transaction(() => {
      let game = read(id); const seatId = authenticate(game,req);
      return once(`${id}:${seatId}`,body,() => {
        revision(game,body);
        if (action !== 'actions') {hostOnly(game,seatId); lobbyOnly(game);}
        if (action === 'lobby') Object.assign(game,configure({...body,rules:body.rules ?? game.rules},game.seats));
        if (action === 'start') {
          if (game.seats.some(s => !s.occupied)) fail('INVALID_INPUT','Fill all human seats before starting.');
          game.generatorVersion = generatorVersion;
          const generated = createBoard(game.boardSize,game.seed);
          game.tiles = Array.isArray(generated) ? generated : generated.tiles;
          game.status = 'active';
        }
        if (action === 'actions') game = applyAction(game,seatId,{type:body.type,tileIds:body.tileIds}); else game.revision++;
        save(game);
        if (action === 'invite') return wrapInvite(game,seatId,setInvite(game,invitation(req.headers.authorization.slice(7),game.id,body.requestId)));
        return {game:snapshot(game),seatId};
      },req.headers.authorization.slice(7),action);
    });
    fail('NOT_FOUND','Endpoint not found.',404);
  }

  const server = http.createServer(async (req,res) => {
    res.setHeader('Content-Type','application/json; charset=utf-8'); res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    const origin = req.headers.origin;
    if (origin && origin !== frontendOrigin) {res.writeHead(403);res.end(JSON.stringify({code:'FORBIDDEN',message:'Origin is not allowed.'}));return;}
    if (origin) {res.setHeader('Access-Control-Allow-Origin',frontendOrigin);res.setHeader('Vary','Origin');}
    if (req.method === 'OPTIONS') {res.setHeader('Access-Control-Allow-Methods','GET,POST,PATCH,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization');res.writeHead(204);res.end();return;}
    try {
      let size = 0, chunks = [];
      for await (const chunk of req) {size += chunk.length;if (size > 16384) fail('INVALID_INPUT','Request body too large.',413);chunks.push(chunk);}
      let body = {};
      if (size) {try {body=JSON.parse(Buffer.concat(chunks).toString());} catch {fail('INVALID_INPUT','Request body must be valid JSON.');} if (!body || Array.isArray(body) || typeof body !== 'object') fail('INVALID_INPUT','Expected a JSON object.');}
      const result = route(req,body,new URL(req.url,'http://localhost'));
      res.writeHead(200);res.end(JSON.stringify(result));
    } catch (error) {
      const code = error.code ?? 'INTERNAL_ERROR';
      const status = error.status ?? ({NOT_YOUR_TURN:409,STALE_REVISION:409,GAME_FINISHED:409,DEFENDED_TILE:422,INVALID_WORD:422,WORD_ALREADY_USED:422,WORD_IS_PREFIX:422,INVALID_INPUT:400}[code] ?? 500);
      res.writeHead(status);res.end(JSON.stringify({code,message:status >= 500 ? 'The server could not complete this request.' : error.message,...(error.currentRevision === undefined?{}:{currentRevision:error.currentRevision})}));
    }
  });
  function runBots() {
    for (const row of db.prepare('SELECT id FROM games').all()) {
      try {transaction(() => {const game = read(row.id);const seat=game.seats[game.currentSeatIndex];if (game.status !== 'active' || seat.kind !== 'bot') return;const action=chooseBotAction(game,rng);save(applyAction(game,seat.id,action));});}
      catch (error) {if (error.code !== 'GAME_EXPIRED') onBotError({gameId:row.id,code:error.code ?? 'BOT_FAILURE'});}
    }
  }
  const timer = botIntervalMs > 0 ? setInterval(runBots,botIntervalMs) : null;
  timer?.unref();
  let closed = false;
  async function close() {if(closed)return;closed=true;if(timer)clearInterval(timer);if(server.listening)await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));db.close();}
  return {server,close,runBots};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.env.APP_MODE && process.env.APP_MODE !== 'local') throw new Error('This bootstrap supports APP_MODE=local only.');
  const port = Number(process.env.API_PORT ?? process.env.PORT ?? 3001);
  const app = createApp({databasePath:process.env.DATABASE_PATH ?? '.local/wordboogie.sqlite',frontendOrigin:process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173',seed:process.env.DEV_SEED,onBotError:error=>console.error('Bot retry pending:',error.code,error.gameId)});
  app.server.on('error',async error=>{console.error(`Local API failed on port ${port}: ${error.code}`);await app.close();process.exitCode=1;});
  app.server.listen(port,'127.0.0.1',()=>console.log(`Local API: http://localhost:${port}`));
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal,async()=>{await app.close();process.exit(0);});
}
