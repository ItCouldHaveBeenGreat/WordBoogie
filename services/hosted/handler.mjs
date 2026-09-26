import { createService, hash, fail } from './service.mjs';
export function allowedRoute(method,path) {
  if(method==='GET'&&path==='/health')return true;
  if(method==='POST'&&['/games','/invites/resolve'].includes(path))return true;
  const match=path?.match(/^\/games\/[^/]+(?:\/(join|lobby|invite|start|actions|history))?$/);
  return !!match && ((method==='GET'&&(!match[1]||match[1]==='history'))||(method==='PATCH'&&match[1]==='lobby')||(method==='POST'&&['join','invite','start','actions'].includes(match[1])));
}
const errorStatuses={NOT_YOUR_TURN:409,STALE_REVISION:409,GAME_FINISHED:409,DEFENDED_TILE:422,INVALID_WORD:422,WORD_ALREADY_USED:422,WORD_IS_PREFIX:422,INVALID_INPUT:400};
export function createHandler({store,frontendUrl,now=()=>Date.now(),logger=console,issuer,clientId}) {
  if(!issuer || !clientId) throw Error('Hosted authentication configuration missing');
  const origin=new URL(frontendUrl).origin,service=createService({store,frontendUrl,now});
  return async event=>{
    const headers={'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','x-robots-tag':'noindex, nofollow'};
    try{
      const incoming=Object.fromEntries(Object.entries(event.headers??{}).map(([k,v])=>[k.toLowerCase(),v]));
      if(incoming.origin&&incoming.origin!==origin)fail('FORBIDDEN','Origin is not allowed.',403);
      if(incoming.origin){headers['access-control-allow-origin']=origin;headers.vary='Origin';}
      const method=event.requestContext?.http?.method;
      if(method==='OPTIONS')return {statusCode:204,headers:{...headers,'access-control-allow-methods':'GET,POST,PATCH,OPTIONS','access-control-allow-headers':'Content-Type,Authorization,X-Game-Token'},body:''};
      if(!allowedRoute(method,event.rawPath)) fail('NOT_FOUND','Endpoint not found.',404);
      if(event.rawPath==='/health')return {statusCode:200,headers,body:JSON.stringify({ok:true,mode:'hosted'})};
      // These claims are supplied by API Gateway's JWT authorizer, never request headers/body.
      const claims=event.requestContext?.authorizer?.jwt?.claims;
      if(!claims || claims.iss!==issuer || claims.client_id!==clientId || claims.token_use!=='access' || typeof claims.sub!=='string' || !claims.sub || !(Number(claims.exp)>now()/1000) || !String(claims.scope??'').split(' ').includes('wordboogie/play')) fail('LOGIN_REQUIRED','Sign in with an approved account.',401);
      const raw=event.isBase64Encoded?Buffer.from(event.body??'','base64').toString('utf8'):event.body??'';
      if(Buffer.byteLength(raw)>16384)fail('INVALID_INPUT','Request body too large.',413);
      let body={};try{body=raw?JSON.parse(raw):{};}catch{fail('INVALID_INPUT','Request body must be valid JSON.');}
      if(!body||typeof body!=='object'||Array.isArray(body))fail('INVALID_INPUT','Expected a JSON object.');
      const path=event.rawPath,token=incoming['x-game-token'];
      if(method!=='GET'){
        // Hash addresses and credentials; never store raw identifiers in limiter keys or logs.
        await store.rate(`ip:${hash(event.requestContext?.http?.sourceIp??'unknown')}`,60,now());
        await store.rate(`user:${hash(claims.sub)}`,30,now());
        if(token)await store.rate(`seat:${hash(token)}`,30,now());
        if(path==='/games')await store.rate(`create:${hash(event.requestContext?.http?.sourceIp??'unknown')}`,10,now());
      }
      const result=await service.route({method,path,body,token,userId:claims.sub,cursor:event.queryStringParameters?.cursor});
      return {statusCode:200,headers,body:JSON.stringify(result)};
    }catch(error){
      const code=error.code??'INTERNAL_ERROR',status=error.status??errorStatuses[code]??500;
      if(status>=500)logger.error(JSON.stringify({event:'api_error',requestId:event.requestContext?.requestId,code:'INTERNAL_ERROR'}));
      return {statusCode:status,headers,body:JSON.stringify({code:status>=500?'INTERNAL_ERROR':code,message:status>=500?'The server could not complete this request.':error.message})};
    }
  };
}
export function createWorker({store,frontendUrl,logger=console}) {
  const service=createService({store,frontendUrl});
  return async event=>{
    if(event.source === 'aws.events') { for(const id of await store.pendingBots()) await service.bot(id); return; }
    for(const record of event.Records??[]){
      const key=record.dynamodb?.Keys;
      if(key?.sk?.S!=='STATE'||!key.pk?.S?.startsWith('GAME#'))continue;
      const id=key.pk.S.slice(5);
      try { if(record.eventName==='REMOVE')await service.cleanup(id); else await service.bot(id); } catch { logger.error(JSON.stringify({event:'worker_failure',gameId:id,operation:record.eventName==='REMOVE'?'cleanup':'bot'})); throw Error('Worker operation failed; see structured log for game ID.'); }
    }
  };
}
let runtime;
async function initialize(){
  if(!runtime){
    const [{DynamoDBClient},sdk,{dynamoStore}]=await Promise.all([import('@aws-sdk/client-dynamodb'),import('@aws-sdk/lib-dynamodb'),import('./dynamo.mjs')]);
    if(!process.env.TABLE_NAME||!process.env.FRONTEND_URL)throw Error('Hosted configuration missing');
    const client=sdk.DynamoDBDocumentClient.from(new DynamoDBClient({}),{marshallOptions:{removeUndefinedValues:true}});
    const store=dynamoStore({client,commands:sdk,table:process.env.TABLE_NAME});
    runtime={api:createHandler({store,frontendUrl:process.env.FRONTEND_URL,issuer:process.env.AUTH_ISSUER,clientId:process.env.AUTH_CLIENT_ID}),worker:createWorker({store,frontendUrl:process.env.FRONTEND_URL})};
  }
  return runtime;
}
export const handler=async event=>(await initialize()).api(event);
export const worker=async event=>(await initialize()).worker(event);
