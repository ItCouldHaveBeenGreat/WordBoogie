import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { createService } from '../services/hosted/service.mjs';
import { createHandler, createWorker } from '../services/hosted/handler.mjs';
import { chooseBotAction, seededRandom } from '../packages/engine/index.mjs';
import { dynamoStore } from '../services/hosted/dynamo.mjs';
import { buildWeb } from '../scripts/build-web.mjs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function memoryStore() {
  const rows=new Map(),key=item=>JSON.stringify([item.pk,item.sk]);
  return {rows,async get(k){return structuredClone(rows.get(key(k)));},async query(pk,prefix){return structuredClone([...rows.values()].filter(r=>r.pk===pk&&r.sk.startsWith(prefix)).sort((a,b)=>a.sk.localeCompare(b.sk)));},async transact(writes){
    for(const w of writes){const current=rows.get(key(w.item??w.check));if((w.absent&&current)||(w.revision!==undefined&&current?.revision!==w.revision))throw Object.assign(Error('Conflict'),{code:'CONFLICT'});}
    for(const w of writes)if(w.item)rows.set(key(w.item),structuredClone(w.item));
  },async remove(keys){keys.forEach(k=>rows.delete(key(k)));},async rate(){}};
}
const token=()=>randomBytes(24).toString('base64url');
const body=(types=['human','bot'],size=5)=>({requestId:randomUUID(),guestToken:token(),displayName:'Host',boardSize:size,playerCount:types.length,seatTypes:types,rules:{permanentDefense:true,exclusiveDefense:true}});
function fixture(store=memoryStore()){const service=createService({store,frontendUrl:'https://example.github.io/WordBoogie',rng:seededRandom('hosted')});const route=service.route; service.route=args=>route({userId:'approved-user',...args});return {store,service,create:b=>service.route({method:'POST',path:'/games',body:b}),call:(id,action,b,t)=>service.route({method:action==='lobby'?'PATCH':'POST',path:`/games/${id}/${action}`,body:b,token:t})};}
const action=(revision,extra={})=>({requestId:randomUUID(),expectedRevision:revision,...extra});

test('hosted create retry stores no raw credentials, preserves Pages path and persists rule toggles',async()=>{
 const f=fixture(),b=body(),g=await f.create(b);assert.deepEqual(await f.create(b),g);assert.match(g.inviteUrl,/example.github.io\/WordBoogie\/#\/join\//);assert.deepEqual(g.game.rules,b.rules);
 assert.equal(JSON.stringify([...f.store.rows.values()]).includes(b.guestToken),false);assert.equal(JSON.stringify([...f.store.rows.values()]).includes(g.inviteToken),false);
 assert.equal(g.game.inviteHash,undefined);
 await assert.rejects(()=>f.create({...b,boardSize:7}),{code:'IDEMPOTENCY_CONFLICT'});
 const racing=body();const results=await Promise.all([f.create(racing),f.create(racing)]);assert.deepEqual(results[0],results[1]);
});
test('hosted invite races cannot overfill; credentials and host rights are enforced',async()=>{
 const f=fixture(),b=body(['human','human']),g=await f.create(b),id=g.game.id;
 await assert.rejects(()=>f.service.route({method:'GET',path:`/games/${id}`,token:g.inviteToken}),{code:'UNAUTHORIZED'});
 const join=name=>({inviteToken:g.inviteToken,guestToken:token(),displayName:name,requestId:randomUUID()});
 const a=join('Alice'),c=join('Bob');const results=await Promise.allSettled([f.call(id,'join',a),f.call(id,'join',c)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 const accepted=results[0].status==='fulfilled'?a:c,joined=await f.call(id,'join',accepted);
 await assert.rejects(()=>f.call(id,'start',action(1),accepted.guestToken),{code:'FORBIDDEN'});
 await f.call(id,'start',action(1),b.guestToken);assert.deepEqual(await f.call(id,'join',accepted),joined);
});
test('hosted revision races, original-response retries, global word history and bot duplicates',async()=>{
 const f=fixture(),b=body(),created=await f.create(b),id=created.game.id;
 const start=await f.call(id,'start',action(0),b.guestToken);
 const move=action(1,chooseBotAction(start.game,seededRandom('move')));
 const results=await Promise.allSettled([f.call(id,'actions',move,b.guestToken),f.call(id,'actions',action(1,{type:'pass'}),b.guestToken)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(results[0].status,'fulfilled');
 await Promise.all([f.service.bot(id),f.service.bot(id)]);
 const g=await f.service.read(id);assert.equal(g.history.length,2);assert.deepEqual(await f.call(id,'actions',move,b.guestToken),results[0].value);
 assert.equal(new Set(g.history.filter(r=>r.word).map(r=>r.word)).size,g.history.filter(r=>r.word).length);
 assert.equal((await f.store.query(`GAME#${id}`,'TURN#')).length,2);
 assert.equal((await f.store.get({pk:`GAME#${id}`,sk:'STATE'})).game.history,undefined);
});
test('all sizes and 2–4 seats complete hosted bot turns without browsers',async()=>{
 for(const size of [5,6,7])for(const count of [2,3,4]){
  const f=fixture(),b=body(['human',...Array(count-1).fill('bot')],size),created=await f.create(b),id=created.game.id;
  await f.call(id,'start',action(0),b.guestToken);await f.call(id,'actions',action(1,{type:'pass'}),b.guestToken);
  for(let i=1;i<count;i++)await f.service.bot(id);
  const game=await f.service.read(id);assert.equal(game.history.length,count);assert.equal(game.currentSeatIndex,0);
 }
});
test('invitation rotation, lobby validation, pass endings, expiration and cleanup',async()=>{
 const f=fixture(),b=body(['human','human']),created=await f.create(b),id=created.game.id;
 const rotated=await f.call(id,'invite',action(0),b.guestToken);
 await assert.rejects(()=>f.service.route({method:'POST',path:'/invites/resolve',body:{inviteToken:created.inviteToken}}),{code:'INVITE_INVALID'});
 const guest=token();await f.call(id,'join',{guestToken:guest,displayName:'Guest',inviteToken:rotated.inviteToken,requestId:randomUUID()});
 await assert.rejects(()=>f.call(id,'lobby',{...b,...action(2),seatTypes:['human','bot']},b.guestToken),{code:'INVALID_INPUT'});
 await f.call(id,'start',action(2),b.guestToken);await f.call(id,'actions',action(3,{type:'pass'}),b.guestToken);
 const end=await f.call(id,'actions',action(4,{type:'pass'}),guest);assert.equal(end.game.status,'finished');assert.equal(end.game.result.winnerIds.length,2);
 const future=createService({store:f.store,frontendUrl:'https://example.com',now:()=>Date.now()+31*86400000});
 await assert.rejects(()=>future.route({userId:'approved-user',method:'GET',path:`/games/${id}`,token:b.guestToken}),{code:'GAME_EXPIRED'});
 await f.service.cleanup(id);assert.ok(f.store.rows.size);
 await f.store.remove([{pk:`GAME#${id}`,sk:'STATE'}]);await f.service.cleanup(id);assert.equal(f.store.rows.size,0);
});
test('Lambda HTTP adapter handles exact origin, body limits, malformed JSON, rate errors and safe logs',async()=>{
 const f=fixture(),logs=[],handler=createHandler({store:f.store,issuer:'https://issuer.example',clientId:'client',frontendUrl:'https://example.github.io/repo',logger:{error:s=>logs.push(s)}});
 const event={rawPath:'/games',headers:{origin:'https://example.github.io'},requestContext:{authorizer:{jwt:{claims:{iss:'https://issuer.example',client_id:'client',token_use:'access',scope:'wordboogie/play',sub:'approved-user',exp:Date.now()/1000+300}}},requestId:'safe',http:{method:'POST',sourceIp:'192.0.2.1'}},body:JSON.stringify(body())};
 assert.equal((await handler(event)).statusCode,200);
 assert.equal((await handler({...event,headers:{origin:'https://evil.example'}})).statusCode,403);
 assert.equal((await handler({...event,body:'[]'})).statusCode,400);
 assert.equal((await handler({...event,body:'{'})).statusCode,400);
 assert.equal((await handler({...event,body:'x'.repeat(16385)})).statusCode,413);
 const options=await handler({...event,requestContext:{http:{method:'OPTIONS'}}});assert.equal(options.statusCode,204);assert.equal(options.headers['access-control-allow-origin'],'https://example.github.io');
 f.store.rate=async()=>{throw Object.assign(Error('Slow down'),{code:'RATE_LIMITED',status:429});};assert.equal((await handler(event)).statusCode,429);
 f.store.rate=async()=>{throw Error('secret token');};const failed=await handler(event);assert.equal(failed.statusCode,500);assert.ok(!failed.body.includes('secret'));assert.ok(!logs.join().includes('secret'));
});
test('stream worker ignores non-state records and retries operational failures',async()=>{
 const f=fixture(),b=body(),g=await f.create(b);await f.call(g.game.id,'start',action(0),b.guestToken);await f.call(g.game.id,'actions',action(1,{type:'pass'}),b.guestToken);
 const worker=createWorker({store:f.store,frontendUrl:'https://example.com'}),record={eventName:'MODIFY',dynamodb:{Keys:{pk:{S:`GAME#${g.game.id}`},sk:{S:'STATE'}}}};
 await worker({Records:[{...record,dynamodb:{Keys:{sk:{S:'TURN#00000001'}}}}]});assert.equal((await f.service.read(g.game.id)).history.length,1);
 await worker({Records:[record]});assert.equal((await f.service.read(g.game.id)).history.length,2);
 f.store.get=async()=>{throw Error('Storage unavailable');};await assert.rejects(()=>worker({Records:[record]}),/Worker operation failed/);
});
test('Dynamo adapter paginates, generates conditional transactions and propagates infrastructure failures',async()=>{
 const names=['GetCommand','QueryCommand','TransactWriteCommand','BatchWriteCommand','UpdateCommand'];const commands=Object.fromEntries(names.map(name=>[name,class {constructor(input){this.name=name;this.input=input;}}]));
 const calls=[];let query=0,mode='ok';const client={async send(cmd){calls.push(cmd);if(mode==='capacity')throw Object.assign(Error('Capacity'),{name:'TransactionCanceledException',CancellationReasons:[{Code:'ProvisionedThroughputExceeded'}]});if(mode==='conflict')throw Object.assign(Error('Conflict'),{name:'TransactionCanceledException',CancellationReasons:[{Code:'ConditionalCheckFailed'}]});if(cmd.name==='QueryCommand')return ++query===1?{Items:[{a:1}],LastEvaluatedKey:{pk:'p',sk:'a'}}:{Items:[{a:2}]};return {};}};
 const store=dynamoStore({client,commands,table:'test'});assert.equal((await store.query('p','TURN#')).length,2);assert.ok(calls[1].input.ExclusiveStartKey);
 await store.transact([{item:{pk:'p',sk:'s'},revision:3},{item:{pk:'p',sk:'new'},absent:true}]);assert.equal(calls.at(-1).input.TransactItems[0].Put.ConditionExpression,'revision = :revision');
 mode='conflict';await assert.rejects(()=>store.transact([]),{code:'CONFLICT'});mode='capacity';await assert.rejects(()=>store.transact([]),/Capacity/);
});
test('Pages artifact has hosted config, HTTPS-only API, relative assets, CSP and no Jekyll',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'wordboogie-build-'));
 try{await buildWeb({authDomain:'https://login.example.com',authClientId:'client',apiUrl:'https://api.example.com',frontendUrl:'https://example.github.io/WordBoogie/',outDir:dir});
 const html=await readFile(join(dir,'index.html'),'utf8'),config=await readFile(join(dir,'config.js'),'utf8');
 assert.match(html,/Content-Security-Policy/);assert.match(html,/\.\/app.js/);assert.match(config,/"mode":"hosted"/);assert.match(config,/example.github.io\/WordBoogie/);assert.equal(await readFile(join(dir,'.nojekyll'),'utf8'),'');
 await assert.rejects(()=>buildWeb({authDomain:'https://login.example.com',authClientId:'client',apiUrl:'http://api.example.com',frontendUrl:'https://example.com',outDir:dir}));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('hosted rejects invalid input and reports expired/unknown/finished games without writes',async()=>{
 const f=fixture();
 for(const bad of [{...body(),guestToken:'short'},{...body(),boardSize:8},{...body(),rules:{exclusiveDefense:'yes'}},{...body(),displayName:'Bot 2'},{...body(),displayName:''},{...body(),requestId:'bad'}])await assert.rejects(()=>f.create(bad),{code:'INVALID_INPUT'});
 await assert.rejects(()=>f.service.route({method:'GET',path:'/unknown'}),{code:'NOT_FOUND'});
 await assert.rejects(()=>f.service.route({method:'GET',path:`/games/${randomUUID()}`}),{code:'UNAUTHORIZED'});
 for(const inviteToken of ['short',token()])await assert.rejects(()=>f.service.route({method:'POST',path:'/invites/resolve',body:{inviteToken}}),{code:'INVITE_INVALID'});
 const b=body(['human','human']),created=await f.create(b),id=created.game.id;
 await assert.rejects(()=>f.call(id,'join',{guestToken:'short'}),{code:'INVALID_INPUT'});
 await assert.rejects(()=>f.call(randomUUID(),'join',{guestToken:token(),inviteToken:created.inviteToken,requestId:randomUUID()}),{code:'INVITE_INVALID'});
 await assert.rejects(()=>f.call(id,'start',action(0),b.guestToken),{code:'INVALID_INPUT'});
 const guest=token();await f.call(id,'join',{guestToken:guest,displayName:'Guest',inviteToken:created.inviteToken,requestId:randomUUID()});
 await f.call(id,'join',{guestToken:guest,displayName:'Guest',inviteToken:created.inviteToken,requestId:randomUUID()});
 await assert.rejects(()=>f.call(id,'join',{guestToken:token(),displayName:'Third',inviteToken:created.inviteToken,requestId:randomUUID()}),{code:'GAME_FULL'});
 await assert.rejects(()=>f.call(id,'start',action(0),b.guestToken),{code:'STALE_REVISION'});
 assert.equal((await f.service.route({method:'GET',path:`/games/${id}`,token:b.guestToken})).seatId,created.seatId);
 await assert.rejects(()=>f.service.route({method:'GET',path:`/games/${id}/history`,token:b.guestToken,cursor:'-1'}),{code:'INVALID_INPUT'});
 assert.deepEqual((await f.service.route({method:'GET',path:`/games/${id}/history`,token:b.guestToken})).items,[]);
 await assert.rejects(()=>f.call(id,'history',{},b.guestToken),{code:'NOT_FOUND'});
 await f.call(id,'start',action(1),b.guestToken);
 await assert.rejects(()=>f.call(id,'lobby',action(2),b.guestToken),{code:'GAME_STARTED'});
 await f.service.bot(id);assert.equal((await f.service.read(id)).revision,2);
});
test('Dynamo adapter reads, recovery pagination, cleanup batches and rate limit classification',async()=>{
 const names=['GetCommand','QueryCommand','TransactWriteCommand','BatchWriteCommand','UpdateCommand'];const commands=Object.fromEntries(names.map(name=>[name,class {constructor(input){this.name=name;this.input=input;}}]));
 let calls=[],rateError;
 const client={async send(cmd){calls.push(cmd);if(cmd.name==='GetCommand')return {Item:{pk:'p',sk:'s'}};if(cmd.name==='QueryCommand')return {Items:[{pk:'GAME#one'}]};if(cmd.name==='UpdateCommand'&&rateError)throw rateError;return {};}};
 const store=dynamoStore({client,commands,table:'test'});assert.equal((await store.get({pk:'p',sk:'s'})).pk,'p');assert.deepEqual(await store.pendingBots(),['one']);
 await store.remove(Array.from({length:26},(_,i)=>({pk:'p',sk:String(i)})));assert.equal(calls.filter(c=>c.name==='BatchWriteCommand').length,2);
 await store.rate('key',5,1000);rateError=Object.assign(Error('limit'),{name:'ConditionalCheckFailedException'});await assert.rejects(()=>store.rate('key',5,1000),{code:'RATE_LIMITED'});
 rateError=Error('unavailable');await assert.rejects(()=>store.rate('key',5,1000),/unavailable/);
 await store.transact([{check:{pk:'p',sk:'s'},revision:1}]);assert.ok(calls.at(-1).input.TransactItems[0].ConditionCheck);
});
test('scheduled recovery advances pending bot and stream expiration cleans auxiliary data',async()=>{
 const f=fixture(),b=body(),g=await f.create(b),id=g.game.id;await f.call(id,'start',action(0),b.guestToken);await f.call(id,'actions',action(1,{type:'pass'}),b.guestToken);
 f.store.pendingBots=async()=>[id];const worker=createWorker({store:f.store,frontendUrl:'https://example.com'});await worker({source:'aws.events'});assert.equal((await f.service.read(id)).history.length,2);
 await f.store.remove([{pk:`GAME#${id}`,sk:'STATE'}]);await worker({Records:[{eventName:'REMOVE',dynamodb:{Keys:{pk:{S:`GAME#${id}`},sk:{S:'STATE'}}}}]});assert.equal(f.store.rows.size,0);
 await f.service.bot(id);
});
test('account ownership is required even when an approved player knows another seat credential',async()=>{
 const f=fixture(),b=body(),g=await f.create(b),path=`/games/${g.game.id}`;
 await assert.rejects(()=>f.service.route({method:'GET',path,token:b.guestToken,userId:'different-approved-user'}),{code:'UNAUTHORIZED'});
 await assert.rejects(()=>f.service.route({method:'GET',path,token:b.guestToken,userId:undefined}),{code:'LOGIN_REQUIRED'});
 assert.equal((await f.service.route({method:'GET',path,token:b.guestToken})).seatId,g.seatId);
});
