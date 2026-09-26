import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { buildWeb } from '../../scripts/build-web.mjs';
import { createHandler, createWorker } from '../../services/hosted/handler.mjs';

export async function hostedBrowser(store) {
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href:'playwright');
 const directory=await mkdtemp(join(tmpdir(),'wordboogie-pages-'));
 const frontend='https://wordboogie.example/repository',api='https://api.example.com';
 await buildWeb({apiUrl:api,frontendUrl:frontend,authDomain:'https://login.example.com',authClientId:'testclient',outDir:directory});
 const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:{})});
 const handler=createHandler({store,frontendUrl:frontend,issuer:'https://issuer.example',clientId:'testclient'}),worker=createWorker({store,frontendUrl:frontend});
 const errors=[];
 async function player() {
  const context=await browser.newContext();
  const subject='approved-'+randomUUID(),issued=new Map(),codes=new Map();
  await context.route('https://login.example.com/**',async route=>{
    const req=route.request(),url=new URL(req.url());
    if(url.pathname==='/oauth2/authorize') {
      assert.equal(url.searchParams.get('code_challenge_method'),'S256');
      const code=randomUUID();codes.set(code,url.searchParams.get('code_challenge'));
      const callback=new URL(url.searchParams.get('redirect_uri'));callback.search=new URLSearchParams({code,state:url.searchParams.get('state')});
      return route.fulfill({status:302,headers:{location:callback.href}});
    }
    if(url.pathname==='/oauth2/token') {
      const data=new URLSearchParams(req.postData());assert.equal(createHash('sha256').update(data.get('code_verifier')).digest('base64url'),codes.get(data.get('code')));
      codes.delete(data.get('code'));
      const claims={iss:'https://issuer.example',client_id:'testclient',sub:subject,exp:Math.floor(Date.now()/1000)+300,token_use:'access',scope:'openid wordboogie/play'};
      const token='test.'+Buffer.from(JSON.stringify(claims)).toString('base64url')+'.signature';issued.set(token,claims);
      return route.fulfill({status:200,headers:{'access-control-allow-origin':'https://wordboogie.example'},contentType:'application/json',body:JSON.stringify({access_token:token,expires_in:300})});
    }
    if(url.pathname==='/logout')return route.fulfill({status:302,headers:{location:frontend+'/'}});
    return route.fulfill({status:404});
  });
  await context.route('https://wordboogie.example/**',async route=>{
   const file=new URL(route.request().url()).pathname.slice('/repository/'.length)||'index.html';
   if(!/^[a-zA-Z0-9_.-]+$/.test(file))return route.fulfill({status:404,body:'Not found'});
   try{await route.fulfill({status:200,contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':'text/plain',body:await readFile(join(directory,file))});}catch{await route.fulfill({status:404,body:'Not found'});}
  });
  await context.route(api+'/**',async route=>{
   const req=route.request(),url=new URL(req.url());
   const result=await handler({rawPath:url.pathname,headers:req.headers(),body:req.postData()??'',queryStringParameters:Object.fromEntries(url.searchParams),requestContext:{authorizer:{jwt:{claims:issued.get(req.headers().authorization?.slice(7))}},http:{method:req.method(),sourceIp:'127.0.0.1'}}});
   await route.fulfill({status:result.statusCode,headers:result.headers,body:result.body});
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error'&&/Content Security Policy|Refused to/.test(m.text()))errors.push(m.text());});
  page.on('dialog',dialog=>dialog.accept());return page;
 }
 try{
  const host=await player(),guest=await player();await host.goto(frontend+'/');
  await host.getByRole('button',{name:'Sign in',exact:true}).click();
  await host.locator('#display-name').waitFor();
  assert.match(await host.locator('.local-tag').innerText(),/ONLINE PLAY/);
  await host.locator('#display-name').fill('Hosted host');await host.locator('[data-seat="1"]').selectOption('human');
  await host.locator('[data-rule="permanentDefense"]').check();await host.locator('[data-rule="exclusiveDefense"]').check();
  await host.locator('#create-form').getByRole('button',{name:'Create game'}).click();await host.locator('#invite-text').waitFor();
  const invite=await host.locator('#invite-text').innerText();assert.ok(invite.startsWith(frontend+'/#/join/'));
  await guest.goto(invite);await guest.getByRole('button',{name:'Sign in',exact:true}).click();await guest.locator('#join-name').fill('Hosted guest');await guest.getByRole('button',{name:'Join game'}).click();
  await host.locator('[data-action="start"]').click();await host.locator('[data-tile="24"]').waitFor();
  await host.locator('[data-action="pass"]').click();await guest.locator('[data-action="pass"]').click();await guest.locator('.result-banner').waitFor();
  await host.reload();await host.locator('.result-banner').waitFor();assert.match(await host.locator('#app').innerText(),/Saved online/);
  await host.goto(frontend+'/');await host.locator('#display-name').fill('Bot host');await host.locator('[data-seat="1"]').selectOption('bot');
  await host.locator('#create-form').getByRole('button',{name:'Create game'}).click();await host.locator('[data-action="start"]').click();
  await host.locator('[data-action="pass"]').click();
  await host.waitForFunction(()=>document.querySelector('.history')?.innerText.includes('PASS'));
  const id=new URL(host.url()).hash.split('/')[2];
  // Simulate stream delivery, independently of browser polling.
  await worker({Records:[{eventName:'MODIFY',dynamodb:{Keys:{pk:{S:`GAME#${id}`},sk:{S:'STATE'}}}}]});
  await host.reload();await host.locator('.move-replay').waitFor();assert.match(await host.locator('.move-replay').innerText(),/Bot 2/);
  await host.getByRole('button',{name:'Sign out',exact:true}).click();await host.getByRole('button',{name:'Sign in',exact:true}).waitFor();
  assert.deepEqual(errors,[]);console.log('PASS: built Pages artifact, two independent hosted players, rules, durable reload, and bot replay with real DynamoDB Local.');
 }finally{await browser.close();await rm(directory,{recursive:true,force:true});}
}
