import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto, createHash } from 'node:crypto';
import { createAuth, safeReturnHash } from '../apps/web/auth.js';
import { createHandler, allowedRoute } from '../services/hosted/handler.mjs';
import { readFileSync } from 'node:fs';

const config={mode:'hosted',frontendOrigin:'https://pages.example/repo',auth:{domain:'https://login.example',clientId:'client'}};
function fixture(){const data=new Map();const storage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};const location={href:'https://pages.example/repo/#/join/'+'x'.repeat(32),hash:'#/join/'+'x'.repeat(32),assign(url){this.assigned=url;}};const history={replaceState(a,b,url){location.replaced=url;}};let tokenCalls=0;
 const access='header.'+Buffer.from(JSON.stringify({sub:'alice'})).toString('base64url')+'.signature';
 const options={storage,location,history,cryptoApi:webcrypto,now:()=>1000000,fetcher:async(url,args)=>{tokenCalls++;return {ok:true,json:async()=>({access_token:access,expires_in:300,refresh_token:'DO_NOT_STORE'})};}};
 return {storage,location,options,get tokenCalls(){return tokenCalls;}};}
test('PKCE sign-in restores invite, validates state, stores only short-lived access token and signs out',async()=>{
 const f=fixture(),auth=createAuth(config,f.options);await auth.login();const url=new URL(f.location.assigned),pending=JSON.parse(f.storage.getItem('wordboogie.oauth'));
 assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.equal(url.searchParams.get('code_challenge'),createHash('sha256').update(pending.verifier).digest('base64url'));assert.equal(url.searchParams.get('redirect_uri'),'https://pages.example/repo/');
 f.location.href='https://pages.example/repo/?code=test&state='+pending.state;await auth.initialize();assert.ok(auth.accessToken());assert.equal(auth.subject,'alice');assert.ok(f.location.replaced.endsWith(pending.returnHash));assert.ok(!f.storage.getItem('wordboogie.auth').includes('DO_NOT_STORE'));assert.equal(f.storage.getItem('wordboogie.oauth'),null);
 auth.logout();assert.equal(auth.accessToken(),null);assert.equal(new URL(f.location.assigned).pathname,'/logout');
});
test('OAuth rejects state mismatch before token exchange, cleans callback and refuses unsafe redirect hashes',async()=>{
 const f=fixture(),auth=createAuth(config,f.options);await auth.login();f.location.href='https://pages.example/repo/?code=test&state=wrong';await auth.initialize();assert.equal(f.tokenCalls,0);assert.equal(auth.accessToken(),null);assert.match(auth.error,/did not match/);assert.ok(!f.location.replaced.includes('code='));
 for(const hash of ['https://evil.example','#//evil.example','#/join/<script>'])assert.equal(safeReturnHash(hash),'#/');
 assert.throws(()=>createAuth({...config,auth:null},f.options),/missing/);
});
test('missing, wrong, expired and ID-token claims are rejected before any database operation',async()=>{
 let touched=0;const store=new Proxy({}, {get(){return async()=>{touched++;throw Error('Storage must not be touched');};}});
 const handler=createHandler({store,frontendUrl:config.frontendOrigin,issuer:'https://issuer.example',clientId:'client',now:()=>1000000});
 const valid={iss:'https://issuer.example',client_id:'client',token_use:'access',scope:'wordboogie/play',sub:'alice',exp:1300};
 for(const claims of [undefined,{...valid,iss:'wrong'},{...valid,client_id:'wrong'},{...valid,token_use:'id'},{...valid,exp:999},{...valid,scope:'openid'},{...valid,sub:''}]){
 const result=await handler({rawPath:'/games',headers:{authorization:'Bearer forged'},body:'{}',requestContext:{http:{method:'POST'},authorizer:{jwt:{claims}}}});assert.equal(result.statusCode,401);
 }
 assert.equal(touched,0);
 const probe=await handler({rawPath:'/wp-admin',requestContext:{http:{method:'GET'}}});assert.equal(probe.statusCode,404);assert.equal(touched,0);
});
test('template exposes only named routes, admin-only Cognito, scoped JWT authorization and noindex build source',()=>{
 const template=JSON.parse(readFileSync('infra/template.json','utf8'));
 const events=Object.values(template.Resources.ApiFunction.Properties.Events);assert.equal(events.length,10);
 for(const event of events){const {Path,Method}=event.Properties;assert.ok(!Path.includes('proxy'));assert.notEqual(Method,'ANY');assert.ok(allowedRoute(Method,Path.replace('{id}','123')));}
 assert.equal(template.Resources.UserPool.Properties.AdminCreateUserConfig.AllowAdminCreateUserOnly,true);
 assert.equal(template.Resources.WebClient.Properties.GenerateSecret,false);
 assert.deepEqual(template.Resources.WebClient.Properties.AllowedOAuthFlows,['code']);
 assert.equal(template.Resources.HttpApi.Properties.Auth.DefaultAuthorizer,'ApprovedPlayers');
 assert.deepEqual(template.Resources.HttpApi.Properties.Auth.Authorizers.ApprovedPlayers.AuthorizationScopes,['wordboogie/play']);
 assert.match(readFileSync('apps/web/index.html','utf8'),/name="robots" content="noindex, nofollow"/);
});
test('bootstrap trusts only the production repository and enforces a runtime permissions boundary',()=>{
 const bootstrap=JSON.parse(readFileSync('infra/bootstrap.json','utf8'));
 const role=bootstrap.Resources.GitHubDeployRole.Properties;
 const trust=role.AssumeRolePolicyDocument.Statement[0];
 assert.equal(trust.Condition.StringEquals['token.actions.githubusercontent.com:aud'],'sts.amazonaws.com');
 assert.equal(trust.Condition.StringEquals['token.actions.githubusercontent.com:sub']['Fn::Sub'],'repo:${GitHubRepository}:environment:production');
 const policy=bootstrap.Resources.CloudFormationRole.Properties.Policies[0].PolicyDocument.Statement;
 const create=policy.find(statement=>statement.Action.includes('iam:CreateRole'));
 assert.deepEqual(create.Condition.StringEquals['iam:PermissionsBoundary'],{Ref:'RuntimeBoundary'});
 assert.equal(policy.some(statement=>statement.Action.includes('iam:DeleteRolePermissionsBoundary')),false);
 const template=JSON.parse(readFileSync('infra/template.json','utf8'));
 for(const name of ['ApiFunction','BotFunction'])assert.deepEqual(template.Resources[name].Properties.PermissionsBoundary,{Ref:'RuntimePermissionsBoundaryArn'});
});
