// OAuth authorization-code flow with S256 PKCE. No password or client secret enters this app.
const key='wordboogie.auth';
const pendingKey='wordboogie.oauth';
const encode=bytes=>btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
export function safeReturnHash(value){return /^#\/(?:game\/[0-9a-f-]{36}|join\/[A-Za-z0-9_-]{22,256})?$/.test(value??'')?value:'#/';}
export function createAuth(config,{storage=sessionStorage,location=window.location,history=window.history,fetcher=fetch,cryptoApi=crypto,now=()=>Date.now()}={}) {
  let session=null,error='';
  const enabled=config.mode==='hosted';
  const settings=config.auth;
  if(enabled&&(!settings?.domain||!settings?.clientId))throw Error('Login configuration is missing.');
  const domain=enabled?new URL(settings.domain).origin:'';
  if(enabled&&new URL(domain).protocol!=='https:')throw Error('Login must use HTTPS.');
  const callback=config.frontendOrigin.replace(/\/$/,'')+'/';
  const read=k=>{try{return JSON.parse(storage.getItem(k)||'null');}catch{return null;}};
  function clear(){session=null;storage.removeItem(key);}
  function accessToken(){if(session?.expiresAt>now()+15000)return session.accessToken;return null;}
  async function initialize(){
    if(!enabled)return;
    session=read(key);
    const url=new URL(location.href);
    if(!url.searchParams.has('code')&&!url.searchParams.has('error'))return;
    const pending=read(pendingKey);storage.removeItem(pendingKey);
    // Remove authorization codes from the address bar even on failure.
    history.replaceState(null,'',callback+safeReturnHash(pending?.returnHash));
    try{
      if(!pending||url.searchParams.get('state')!==pending.state||pending.createdAt<now()-600000)throw Error('Sign-in request expired or did not match. Please sign in again.');
      if(url.searchParams.has('error'))throw Error('Sign-in was not completed. Please try again.');
      const response=await fetcher(domain+'/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:settings.clientId,code:url.searchParams.get('code'),redirect_uri:callback,code_verifier:pending.verifier}),signal:AbortSignal.timeout(12000)});
      if(!response.ok)throw Error('Could not complete sign-in. Please try again.');
      const data=await response.json();
      if(typeof data.access_token!=='string'||!Number.isFinite(data.expires_in)||data.expires_in<=0)throw Error('Invalid sign-in response.');
      // This decode is only for browser storage separation; the server validates the JWT.
      const part=data.access_token.split('.')[1];
      const claims=JSON.parse(atob(part.replaceAll('-','+').replaceAll('_','/')));
      if(typeof claims.sub!=='string'||!claims.sub)throw Error('Invalid sign-in response.');
      const previous=read(key);
      if(previous?.subject!==claims.sub)storage.removeItem('wordboogie.pending');
      session={accessToken:data.access_token,subject:claims.sub,expiresAt:now()+Math.min(data.expires_in,300)*1000};
      storage.setItem(key,JSON.stringify(session));
      // Refresh and ID tokens are deliberately not stored. Cognito's session can handle reauthentication.
    }catch(e){clear();error=e.message;}
  }
  async function login(){
    const verifier=encode(cryptoApi.getRandomValues(new Uint8Array(32))),state=encode(cryptoApi.getRandomValues(new Uint8Array(32)));
    const challenge=encode(new Uint8Array(await cryptoApi.subtle.digest('SHA-256',new TextEncoder().encode(verifier))));
    storage.setItem(pendingKey,JSON.stringify({verifier,state,createdAt:now(),returnHash:safeReturnHash(location.hash)}));
    const url=new URL(domain+'/oauth2/authorize');url.search=new URLSearchParams({response_type:'code',client_id:settings.clientId,redirect_uri:callback,scope:'openid wordboogie/play',state,code_challenge:challenge,code_challenge_method:'S256'}).toString();
    location.assign(url.href);
  }
  function logout(){clear();storage.removeItem(pendingKey);storage.removeItem('wordboogie.pending');const url=new URL(domain+'/logout');url.search=new URLSearchParams({client_id:settings.clientId,logout_uri:callback}).toString();location.assign(url.href);}
  return {initialize,login,logout,clear,accessToken,get subject(){return session?.subject;},get error(){return error;}};
}
