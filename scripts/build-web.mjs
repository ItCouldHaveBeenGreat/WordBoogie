import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export async function buildWeb({apiUrl,frontendUrl,authDomain,authClientId,outDir='dist/web'}) {
  if(!authClientId || !/^[a-zA-Z0-9]+$/.test(authClientId))throw Error('A Cognito public client ID is required.');
  const auth=new URL(authDomain);
  if(auth.protocol!=='https:'||auth.username||auth.password||auth.pathname!=='/'||auth.search||auth.hash)throw Error('A Cognito HTTPS domain origin is required.');
  const api=new URL(apiUrl),frontend=new URL(frontendUrl);
  for(const url of [api,frontend])if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw Error('Use public HTTPS URLs without credentials, query strings or fragments.');
  if(api.pathname!=='/'||apiUrl.endsWith('//'))throw Error('API URL must be an origin without a path.');
  frontendUrl=frontendUrl.replace(/\/$/,'');apiUrl=api.origin;
  await mkdir(outDir,{recursive:true});await cp('apps/web',outDir,{recursive:true});
  const policy=`default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ${api.origin} ${auth.origin}; img-src 'self' data:; base-uri 'none'; form-action 'self'`;
  const html=(await readFile('apps/web/index.html','utf8')).replace('<meta name="viewport"',`<meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer"><meta name="viewport"`);
  await writeFile(resolve(outDir,'index.html'),html);
  await writeFile(resolve(outDir,'config.js'),`window.WORDBOOGIE_CONFIG=${JSON.stringify({mode:'hosted',apiUrl,frontendOrigin:frontendUrl,auth:{domain:auth.origin,clientId:authClientId}})};\n`);
  await writeFile(resolve(outDir,'.nojekyll'),'');
  return {apiUrl,frontendUrl,outDir};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  await buildWeb({apiUrl:process.env.API_URL,frontendUrl:process.env.FRONTEND_URL,authDomain:process.env.AUTH_DOMAIN,authClientId:process.env.AUTH_CLIENT_ID});
  console.log('Hosted frontend built in dist/web');
}
