import {type Page} from '@playwright/test';
import {generateKeyPairSync,randomBytes,createHash,sign} from 'node:crypto';
// Test-only software authenticator signs real challenges. It does not bypass the server verifier.
export async function installAuthenticator(page:Page){
 const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 const jwk=publicKey.export({format:'jwk'});let credentialId=randomBytes(32);
 let userHandle:Buffer,counter=0;
 const calls:{kind:string;selection?:Record<string,unknown>;hints?:string[]}[]=[];
 const hash=(b:Uint8Array|string)=>createHash('sha256').update(b).digest();
 function cbor(v:unknown):Buffer {
  function size(major:number,n:number){return n<24?Buffer.from([major*32+n]):n<256?Buffer.from([major*32+24,n]):Buffer.from([major*32+25,n>>8,n&255]);}
  if(typeof v==='number')return size(v<0?1:0,v<0?-1-v:v);
  if(typeof v==='string'){const b=Buffer.from(v);return Buffer.concat([size(3,b.length),b]);}
  if(v instanceof Uint8Array)return Buffer.concat([size(2,v.length),Buffer.from(v)]);
  if(v instanceof Map)return Buffer.concat([size(5,v.size),...[...v].flatMap(([k,value])=>[cbor(k),cbor(value)])]);
  throw new Error('test CBOR');
 }
 await page.exposeFunction('punkaTestAuthenticator',({kind,challenge,user,origin,selection,hints}:{kind:string;challenge:string;user?:number[];origin:string;selection?:Record<string,unknown>;hints?:string[]})=>{
  calls.push({kind,selection,hints});
  const client=Buffer.from(JSON.stringify({type:kind==='create'?'webauthn.create':'webauthn.get',challenge,origin,crossOrigin:false}));
  if(kind==='create'){
   credentialId=randomBytes(32);counter=0;
   userHandle=Buffer.from(user!);const cose=cbor(new Map<number,unknown>([[1,2],[3,-7],[-1,1],[-2,Buffer.from(jwk.x!,'base64url')],[-3,Buffer.from(jwk.y!,'base64url')]]));
   const auth=Buffer.concat([hash('localhost'),Buffer.from([0x45,0,0,0,0]),Buffer.alloc(16),Buffer.from([0,32]),credentialId,cose]);
   const attestation=cbor(new Map<string,unknown>([['fmt','none'],['attStmt',new Map()],['authData',auth]]));
   return {id:credentialId.toString('base64url'),rawId:[...credentialId],clientDataJSON:[...client],attestationObject:[...attestation]};
  }
  const number=Buffer.alloc(4);number.writeUInt32BE(++counter);const auth=Buffer.concat([hash('localhost'),Buffer.from([0x05]),number]);const signature=sign('sha256',Buffer.concat([auth,hash(client)]),privateKey);
  return {id:credentialId.toString('base64url'),rawId:[...credentialId],clientDataJSON:[...client],authenticatorData:[...auth],signature:[...signature],userHandle:[...userHandle]};
 });
 await page.addInitScript(()=>{
  const encode=(b:ArrayBuffer)=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  async function credential(kind:string,options:any){
   const raw=await (window as any).punkaTestAuthenticator({kind,selection:options.publicKey.authenticatorSelection,hints:options.publicKey.hints,challenge:encode(options.publicKey.challenge),user:options.publicKey.user?[...new Uint8Array(options.publicKey.user.id)]:undefined,origin:location.origin});
   const response:Record<string,unknown>={};for(const [key,value] of Object.entries(raw)){if(Array.isArray(value)&&key!=='rawId')response[key]=new Uint8Array(value as number[]).buffer;}
   response.getTransports=()=>['internal'];
   return {id:raw.id,rawId:new Uint8Array(raw.rawId).buffer,type:'public-key',authenticatorAttachment:'platform',response,getClientExtensionResults:()=>({})};
  }
  Object.defineProperty(navigator.credentials,'create',{value:(options:any)=>credential('create',options)});
  Object.defineProperty(navigator.credentials,'get',{value:(options:any)=>credential('get',options)});
 });
 return {calls};
}
