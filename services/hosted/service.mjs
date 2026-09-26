import { randomBytes, randomUUID, createHash, createHmac } from 'node:crypto';
import { createBoard, applyAction, chooseBotAction, getScores, getDefended, dictionaryVersion, generatorVersion, rulesVersion } from '../../packages/engine/index.mjs';
export const hash = value => createHash('sha256').update(value).digest('hex');
const inviteToken = (token,id,requestId) => createHmac('sha256',token).update(`invite:${id}:${requestId}`).digest('base64url');
export const fail = (code,message,status=400) => { throw Object.assign(new Error(message),{code,status}); };
const tokenValid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{22,256}$/.test(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])) : value;
const nameOf = name => { if(typeof name !== 'string' || !name.trim() || name.trim().length>24) fail('INVALID_INPUT','Display name must contain 1–24 characters.'); return name.trim(); };
const uniqueName = (seats,name) => { if(seats.some(s=>s.displayName?.toLowerCase()===name.toLowerCase()) || /^bot [1-4]$/i.test(name)) fail('INVALID_INPUT','Choose a unique player name. Bot names are reserved.'); };
const lobbyOnly = game => { if(game.status!=='lobby') fail('GAME_STARTED','The game has already started.',409); };
export function configure(body,previous=[]) {
  const {boardSize,playerCount,seatTypes}=body;
  if(![5,6,7].includes(boardSize)||![2,3,4].includes(playerCount)||!Array.isArray(seatTypes)||seatTypes.length!==playerCount||seatTypes[0]!=='human'||seatTypes.some(t=>!['human','bot'].includes(t))) fail('INVALID_INPUT','Choose 2–4 players and a board size of 5, 6, or 7.');
  for(const seat of previous) if(seat.kind==='human'&&seat.occupied&&(seat.index>=playerCount||seatTypes[seat.index]!=='human')) fail('INVALID_INPUT','An occupied human seat cannot be removed.');
  const rules=body.rules??{};
  if(typeof rules!=='object'||Array.isArray(rules)||Object.keys(rules).some(k=>!['permanentDefense','exclusiveDefense'].includes(k))||Object.values(rules).some(v=>typeof v!=='boolean')) fail('INVALID_INPUT','Defense rules must be boolean toggles.');
  return {boardSize,rules:{permanentDefense:rules.permanentDefense??false,exclusiveDefense:rules.exclusiveDefense??false},seats:seatTypes.map((kind,index)=>previous[index]?.kind===kind?previous[index]:{id:randomUUID(),index,kind,displayName:kind==='bot'?`Bot ${index+1}`:null,occupied:kind==='bot'})};
}
const gameKey = id => ({pk:`GAME#${id}`,sk:'STATE'});
const sessionKey = (id,token) => ({pk:`GAME#${id}`,sk:`SESSION#${hash(token)}`});
const invitationKey = token => ({pk:`INVITE#${hash(token)}`,sk:'LOOKUP'});
const historyKey = (id,turn) => ({pk:`GAME#${id}`,sk:`TURN#${String(turn).padStart(8,'0')}`});
const publicGame = game => { const {inviteHash,...safe}=game; return {...safe,history:game.history.slice(-100),historyCount:game.history.length,scores:getScores(game),defended:getDefended(game)}; };

/** Repository writes are atomic; conditions serialize races between HTTP requests and workers. */
export function createService({store,frontendUrl,now=()=>Date.now(),rng=Math.random}) {
  const root=new URL(frontendUrl); if(root.protocol!=='https:') throw Error('Hosted frontend URL must use HTTPS.');
  const frontend=frontendUrl.replace(/\/$/,'');
  const alive=game=>{if(Date.parse(game.expiresAt)<=now())fail('GAME_EXPIRED','This game has expired.',410);return game;};
  async function read(id) {
    const row=await store.get(gameKey(id)); if(!row)fail('NOT_FOUND','Game not found.',404);
    const game=alive(row.game);
    // State first, then immutable history up to that revision gives a consistent snapshot.
    const history=await store.query(`GAME#${id}`,'TURN#');
    return {...game,history:history.filter(r=>r.record.revision<=game.revision).map(r=>r.record)};
  }
  async function authenticate(game,token,userId) {
    if(!tokenValid(token))fail('UNAUTHORIZED','A player credential is required.',401);
    const session=await store.get(sessionKey(game.id,token));
    if(!session || session.userId!==userId)fail('UNAUTHORIZED','This credential cannot access this game.',401);
    return session.seatId;
  }
  function saved(game) {
    game.updatedAt=new Date(now()).toISOString(); game.expiresAt=new Date(now()+30*86400000).toISOString();
    for(const r of game.history)if(!r.timestamp)r.timestamp=game.updatedAt;
    const {history,...state}=game;
    return {...gameKey(game.id),game:state,revision:game.revision,ttl:Math.ceil(Date.parse(game.expiresAt)/1000),botPending:game.status==='active'&&game.seats[game.currentSeatIndex].kind==='bot'? 'BOT':undefined};
  }
  function gameWrites(game,oldRevision) {
    const writes=[{item:saved(game),...(oldRevision===null?{absent:true}:{revision:oldRevision})}];
    const last=game.history.at(-1);
    if(last?.revision===game.revision)writes.push({item:{...historyKey(game.id,last.turn),record:last},absent:true});
    return writes;
  }
  async function invited(token) {
    if(!tokenValid(token))fail('INVITE_INVALID','The invite is invalid or revoked.',404);
    const link=await store.get(invitationKey(token));if(!link)fail('INVITE_INVALID','The invite is invalid or revoked.',404);
    const game=await read(link.gameId);
    if(game.inviteHash!==hash(token))fail('INVITE_INVALID','The invite is invalid or revoked.',404);
    lobbyOnly(game);return game;
  }
  function inviteWrites(game,token) {
    game.inviteHash=hash(token);
    const key=invitationKey(token);
    return [{item:{...key,gameId:game.id},absent:true},{item:{pk:`GAME#${game.id}`,sk:`LINK#${key.pk}`,target:key},absent:true}];
  }
  const response=(game,seatId,token)=>({...{game:publicGame(game),seatId},...(token?{inviteToken:token,inviteUrl:`${frontend}/#/join/${token}`}:{})});
  async function once(scope,body,token,operation,perform) {
    if(typeof body.requestId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.requestId))fail('INVALID_INPUT','A UUID requestId is required.');
    const key={pk:`REQUEST#${hash(scope)}`,sk:body.requestId};
    const digest=hash(JSON.stringify(canonical({body,operation})));
    async function replay() {
      const existing=await store.get(key); if(!existing)return null;
      if(existing.digest!==digest)fail('IDEMPOTENCY_CONFLICT','This request ID was used for different input.',409);
      const parent=await store.get(gameKey(existing.result.game.id));if(!parent)fail('GAME_EXPIRED','This game has expired.',410);alive(parent.game);
      return {...existing.result,...(existing.hasInvite?{inviteToken:inviteToken(token,existing.result.game.id,body.requestId),inviteUrl:`${frontend}/#/join/${inviteToken(token,existing.result.game.id,body.requestId)}`}:{})};
    }
    const previous=await replay();if(previous)return previous;
    const {game,seatId,writes,invitation}=await perform();
    // Responses retain only the latest 100 turns, keeping each idempotency record below DynamoDB's item limit.
    const result=response(game,seatId);
    writes.push({item:{...key,digest,result,hasInvite:!!invitation},absent:true});
    writes.push({item:{pk:`GAME#${game.id}`,sk:`LINK#${key.pk}#${key.sk}`,target:key},absent:true});
    try { await store.transact(writes); } catch(error) {
      if(error.code!=='CONFLICT')throw error;
      const committed=await replay();if(committed)return committed;
      fail('STALE_REVISION','The game changed. Refresh and try again.',409);
    }
    return response(game,seatId,invitation);
  }
  async function route({method,path,body={},token,cursor,userId}) {
    if(method==='GET'&&path==='/health')return {ok:true,mode:'hosted'};
    if(!userId)fail('LOGIN_REQUIRED','Sign in with an approved account.',401);
    if(method==='POST'&&path==='/games') {
      if(!tokenValid(body.guestToken))fail('INVALID_INPUT','Provide a securely generated guest credential.');
      return once(`create:${userId}:${hash(body.guestToken)}`,body,body.guestToken,'create',async()=>{
        const name=nameOf(body.displayName),config=configure(body);uniqueName(config.seats,name);
        Object.assign(config.seats[0],{displayName:name,occupied:true});
        const game={id:randomUUID(),schemaVersion:1,rulesVersion,dictionaryVersion,generatorVersion,seed:randomBytes(8).toString('hex'),status:'lobby',revision:0,...config,tiles:[],currentSeatIndex:0,consecutivePasses:0,history:[],createdAt:new Date(now()).toISOString()};
        const invitation=inviteToken(body.guestToken,game.id,body.requestId);
        const writes=inviteWrites(game,invitation);
        writes.push(...gameWrites(game,null),{item:{...sessionKey(game.id,body.guestToken),seatId:game.seats[0].id,userId},absent:true});
        return {game,seatId:game.seats[0].id,writes,invitation};
      });
    }
    if(method==='POST'&&path==='/invites/resolve') {const g=await invited(body.inviteToken);return {gameId:g.id,boardSize:g.boardSize,seats:g.seats,status:g.status,rules:g.rules};}
    const match=path.match(/^\/games\/([0-9a-f-]{36})(?:\/(join|lobby|invite|start|actions|history))?$/i);
    if(!match)fail('NOT_FOUND','Endpoint not found.',404);
    const [,id,action]=match;
    if(method==='POST'&&action==='join') {
      if(!tokenValid(body.guestToken))fail('INVALID_INPUT','Provide a securely generated guest credential.');
      return once(`join:${userId}:${id}:${hash(body.guestToken)}`,body,body.guestToken,'join',async()=>{
        const game=await invited(body.inviteToken);if(game.id!==id)fail('INVITE_INVALID','This invite belongs to another game.',403);
        const old=game.revision,existing=await store.get(sessionKey(id,body.guestToken));
        if(existing && existing.userId!==userId)fail('UNAUTHORIZED','This credential belongs to another account.',401);
        if(existing)return {game,seatId:existing.seatId,writes:[{check:gameKey(id),revision:old}]};
        const seat=game.seats.find(s=>s.kind==='human'&&!s.occupied);if(!seat)fail('GAME_FULL','All human seats are occupied.',409);
        const name=nameOf(body.displayName);uniqueName(game.seats,name);Object.assign(seat,{displayName:name,occupied:true});game.revision++;
        return {game,seatId:seat.id,writes:[...gameWrites(game,old),{item:{...sessionKey(id,body.guestToken),seatId:seat.id,userId},absent:true}]};
      });
    }
    const seatId=await authenticate({id},token,userId),game=await read(id);
    if(method==='GET'&&!action)return response(game,seatId);
    if(method==='GET'&&action==='history') {const start=Number(cursor??0);if(!Number.isInteger(start)||start<0)fail('INVALID_INPUT','Invalid history cursor.');return {items:game.history.slice(start,start+50),nextCursor:start+50<game.history.length?String(start+50):null};}
    if((method==='POST'&&['start','actions','invite'].includes(action))||(method==='PATCH'&&action==='lobby')) {
      return once(`${userId}:${id}:${seatId}`,body,token,action,async()=>{
        if(body.expectedRevision!==game.revision)fail('STALE_REVISION','The game changed. Refresh and try again.',409);
        if(action!=='actions'){if(game.seats[0].id!==seatId)fail('FORBIDDEN','Only the host can do that.',403);lobbyOnly(game);}
        const old=game.revision;let next=game,invitation;const writes=[];
        if(action==='lobby')Object.assign(next,configure({...body,rules:body.rules??game.rules},game.seats));
        if(action==='start'){if(next.seats.some(s=>!s.occupied))fail('INVALID_INPUT','Fill all human seats before starting.');next.tiles=createBoard(next.boardSize,next.seed);next.status='active';}
        if(action==='actions')next=applyAction(game,seatId,{type:body.type,tileIds:body.tileIds});else next.revision++;
        if(action==='invite'){invitation=inviteToken(token,id,body.requestId);writes.push(...inviteWrites(next,invitation));}
        writes.push(...gameWrites(next,old));return {game:next,seatId,writes,invitation};
      });
    }
    fail('NOT_FOUND','Endpoint not found.',404);
  }
  async function bot(id) {
    let game;try{game=await read(id);}catch(error){if(['NOT_FOUND','GAME_EXPIRED'].includes(error.code))return;throw error;}
    const seat=game.seats[game.currentSeatIndex];if(game.status!=='active'||seat.kind!=='bot')return;
    const next=applyAction(game,seat.id,chooseBotAction(game,rng));
    try{await store.transact(gameWrites(next,game.revision));}catch(error){if(error.code!=='CONFLICT')throw error;}
  }
  async function cleanup(id) {
    // A TTL deletion is irreversible. Never clean a still-live parent.
    if(await store.get(gameKey(id)))return;
    const items=await store.query(`GAME#${id}`,'');
    await store.remove(items.filter(item=>item.target).map(item=>item.target));
    await store.remove(items.map(item=>({pk:item.pk,sk:item.sk}))); 
  }
  return {route,bot,cleanup,read};
}
