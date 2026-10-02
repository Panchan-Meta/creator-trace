import {env,applyD1Migrations} from 'cloudflare:test';
import {beforeAll,it,expect} from 'vitest';
import {generateKeyPairSync,createHash,sign} from 'node:crypto';
import worker from '../src/index';
import {Store,type Bindings} from '../src/store';
import {id,now,sha256,randomToken} from '../src/domain';
const bindings={...env,APP_ORIGIN:'http://localhost:8787',RP_ID:'localhost',SIGNUP_ENABLED:'true'} as Bindings;
const s=new Store(bindings);
const b64=(b:Uint8Array)=>Buffer.from(b).toString('base64url');
const hash=(b:Uint8Array|string)=>createHash('sha256').update(b).digest();
// Minimal CBOR encoder for real none-attestation test credentials, not a verification mock.
function cbor(value:unknown):Buffer {
 function length(major:number,n:number){return n<24?Buffer.from([major*32+n]):n<256?Buffer.from([major*32+24,n]):Buffer.from([major*32+25,n>>8,n&255]);}
 if(typeof value==='number')return length(value<0?1:0,value<0?-1-value:value);
 if(typeof value==='string'){const bytes=Buffer.from(value);return Buffer.concat([length(3,bytes.length),bytes]);}
 if(value instanceof Uint8Array)return Buffer.concat([length(2,value.length),Buffer.from(value)]);
 if(value instanceof Map){return Buffer.concat([length(5,value.size),...[...value].flatMap(([key,item])=>[cbor(key),cbor(item)])]);}
 throw new Error('Unsupported test CBOR');
}
let authTestIP='127.0.0.31';
async function req(path:string,body:unknown,cookie?:string){return worker.fetch(new Request('http://localhost:8787'+path,{method:'POST',headers:{Origin:bindings.APP_ORIGIN,'CF-Connecting-IP':authTestIP,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body)}),bindings);}
beforeAll(async()=>applyD1Migrations(env.DB,(env as unknown as {TEST_MIGRATIONS:Parameters<typeof applyD1Migrations>[1]}).TEST_MIGRATIONS));
it.each(['normal','invite'])('%s: 実署名Passkeyの登録 → ログイン → session → logout、招待再使用を拒否',async mode=>{
 authTestIP=mode==='normal'?'127.0.0.31':'127.0.0.32';
 let invitation:any,ownerProject:string|undefined;
 if(mode==='invite'){const owner=id(),session=randomToken();await s.sql('INSERT INTO users(id,display_name,created_at) VALUES(?,?,?)',owner,'Punka',now()).run();ownerProject=id();await s.sql('INSERT INTO projects(id,name,owner_id,created_at) VALUES(?,?,?,?)',ownerProject,"Rahab's mission",owner,now()).run();await s.sql('INSERT INTO sessions VALUES(?,?,?)',await sha256(session),owner,new Date(Date.now()+86400000).toISOString()).run();invitation=await (await req(`/api/projects/${ownerProject}/invites`,{email:'mfzb5683rhcp2525@gmail.com',role:'CREATOR'},`punka_session=${session}`)).json();}
 const signup=mode==='normal'?await req('/api/auth/signup',{name:'Creator',project_name:'First project'}):await req('/api/auth/invite-signup',{name:'Rahab',token:invitation.url.split('/').at(-1)});expect(signup.status).toBe(201);const enrollmentCookie=signup.headers.get('Set-Cookie')!.split(';')[0];
 const enrollmentToken=enrollmentCookie.split('=')[1];const enrollment=await s.sql('SELECT recipient_id FROM enrollment_tokens WHERE token_hash=?',await sha256(enrollmentToken)).first<{recipient_id:string}>();const userId=enrollment!.recipient_id;
 expect((await req('/api/auth/passkey/register/options',{})).status).toBe(401);
 const optionsResponse=await req('/api/auth/passkey/register/options',{},enrollmentCookie);expect(optionsResponse.status).toBe(200);const options=await optionsResponse.json() as {challenge:string;authenticatorSelection:{authenticatorAttachment?:string;residentKey:string;userVerification:string};hints:string[]};expect(options.authenticatorSelection.authenticatorAttachment).toBeUndefined();expect(options.authenticatorSelection.residentKey).toBe('required');expect(options.authenticatorSelection.userVerification).toBe('required');expect(options.hints).toEqual(['hybrid','client-device','security-key']);const challengeCookie=optionsResponse.headers.get('Set-Cookie')!.split(';')[0];
 const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});const jwk=publicKey.export({format:'jwk'});const credentialId=crypto.getRandomValues(new Uint8Array(32));
 const cose=cbor(new Map<number,unknown>([[1,2],[3,-7],[-1,1],[-2,Buffer.from(jwk.x!,'base64url')],[-3,Buffer.from(jwk.y!,'base64url')]]));
 const authData=Buffer.concat([hash('localhost'),Buffer.from([0x45,0,0,0,0]),Buffer.alloc(16),Buffer.from([0,32]),Buffer.from(credentialId),cose]);
 const attestation=cbor(new Map<string,unknown>([['fmt','none'],['attStmt',new Map()],['authData',authData]]));
 const clientData=Buffer.from(JSON.stringify({type:'webauthn.create',challenge:options.challenge,origin:bindings.APP_ORIGIN,crossOrigin:false}));
 const response={id:b64(credentialId),rawId:b64(credentialId),type:'public-key',response:{clientDataJSON:b64(clientData),attestationObject:b64(attestation),transports:['internal']},clientExtensionResults:{}};
 const registration=await req('/api/auth/passkey/register/verify',{response},challengeCookie);expect(registration.status,await registration.clone().text()).toBe(200);expect(registration.headers.get('Set-Cookie')).toContain('HttpOnly');expect(registration.headers.get('Set-Cookie')).toContain('SameSite=Strict');
 expect((await req('/api/auth/passkey/register/options',{},enrollmentCookie)).status).toBe(401);const projects=await s.sql('SELECT * FROM projects WHERE owner_id=?',userId).all();expect(projects.results).toHaveLength(mode==='normal'?1:0);
 if(mode==='invite'){
  expect(await s.sql('SELECT invite_id FROM invite_enrollments WHERE token_hash=?',await sha256(enrollmentToken)).first()).toEqual({invite_id:invitation.id});
  expect(await s.sql('SELECT consumed_at FROM project_invites WHERE id=?',invitation.id).first()).toEqual({consumed_at:null});
  const accepted=await req('/api/project-invites/accept',{token:invitation.url.split('/').at(-1)},registration.headers.get('Set-Cookie')!.split(';')[0]);expect(accepted.status).toBe(200);expect(await accepted.json()).toMatchObject({project_id:ownerProject,project_name:"Rahab's mission",role:'CREATOR',status:'ACCEPTED'});
  expect(await s.sql('SELECT project_id,user_id,role,status FROM project_members WHERE project_id=? AND user_id=?',ownerProject!,userId).first()).toEqual({project_id:ownerProject,user_id:userId,role:'CREATOR',status:'ACTIVE'});
  expect(await s.sql('SELECT email,consumed_by FROM project_invites WHERE id=?',invitation.id).first()).toEqual({email:'mfzb5683rhcp2525@gmail.com',consumed_by:userId});
  expect((await req('/api/auth/invite-signup',{name:'Another',token:invitation.url.split('/').at(-1)})).status).toBe(400);
 }

 const loginOptions=await req('/api/auth/passkey/login/options',{});const login=await loginOptions.json() as {challenge:string};const loginCookie=loginOptions.headers.get('Set-Cookie')!.split(';')[0];
 const assertionData=Buffer.concat([hash('localhost'),Buffer.from([0x05,0,0,0,1])]);const loginClient=Buffer.from(JSON.stringify({type:'webauthn.get',challenge:login.challenge,origin:bindings.APP_ORIGIN,crossOrigin:false}));const signature=sign('sha256',Buffer.concat([assertionData,hash(loginClient)]),privateKey);
 const assertion={id:b64(credentialId),rawId:b64(credentialId),type:'public-key',response:{authenticatorData:b64(assertionData),clientDataJSON:b64(loginClient),signature:b64(signature),userHandle:b64(Buffer.from(userId))},clientExtensionResults:{}};
 const loggedIn=await req('/api/auth/passkey/login/verify',{response:assertion},loginCookie);expect(loggedIn.status,await loggedIn.clone().text()).toBe(200);
 const sessionCookie=loggedIn.headers.get('Set-Cookie')!.split(';')[0];const session=await worker.fetch(new Request('http://localhost:8787/api/auth/session',{headers:{Cookie:sessionCookie}}),bindings);expect(await session.json()).toMatchObject({authenticated:true,recipient_id:userId,display_name:mode==='normal'?'Creator':'Rahab'});
 const extraOptionsResponse=await req('/api/auth/passkey/register/options',{},sessionCookie);expect(extraOptionsResponse.status).toBe(200);const extraOptions=await extraOptionsResponse.json() as {challenge:string;excludeCredentials:{id:string}[]};expect(extraOptions.excludeCredentials.map(c=>c.id)).toContain(response.id);
 const extraCookie=extraOptionsResponse.headers.get('Set-Cookie')!.split(';')[0];
 const extraId=crypto.getRandomValues(new Uint8Array(32));const extraAuthData=Buffer.concat([hash('localhost'),Buffer.from([0x45,0,0,0,0]),Buffer.alloc(16),Buffer.from([0,32]),Buffer.from(extraId),cose]);
 const extraResponse={...response,id:b64(extraId),rawId:b64(extraId),response:{...response.response,transports:['hybrid'],clientDataJSON:b64(Buffer.from(JSON.stringify({type:'webauthn.create',challenge:extraOptions.challenge,origin:bindings.APP_ORIGIN,crossOrigin:false}))),attestationObject:b64(cbor(new Map<string,unknown>([['fmt','none'],['attStmt',new Map()],['authData',extraAuthData]])))}};
 expect((await req('/api/auth/passkey/register/verify',{response:extraResponse},`${sessionCookie}; ${extraCookie}`)).status).toBe(200);
 const list=await worker.fetch(new Request('http://localhost:8787/api/auth/passkeys',{headers:{Cookie:sessionCookie}}),bindings);expect((await list.json() as {passkeys:unknown[]}).passkeys).toHaveLength(2);
 const unbound=await req('/api/auth/passkey/register/options',{},sessionCookie);const unboundCookie=unbound.headers.get('Set-Cookie')!.split(';')[0];expect((await req('/api/auth/passkey/register/verify',{response:extraResponse},unboundCookie)).status).toBe(401);
 const otherUser=id(),otherToken=randomToken();await s.sql('INSERT INTO users(id,created_at) VALUES(?,?)',otherUser,now()).run();await s.sql('INSERT INTO sessions VALUES(?,?,?)',await sha256(otherToken),otherUser,new Date(Date.now()+60000).toISOString()).run();
 const bound=await req('/api/auth/passkey/register/options',{},sessionCookie);const boundCookie=bound.headers.get('Set-Cookie')!.split(';')[0];expect((await req('/api/auth/passkey/register/verify',{response:extraResponse},`punka_session=${otherToken}; ${boundCookie}`)).status).toBe(403);
 expect((await req('/api/auth/passkey/login/verify',{response:assertion},loginCookie)).status).toBe(400);
 expect((await req('/api/auth/logout',{},sessionCookie)).status).toBe(200);
 const after=await worker.fetch(new Request('http://localhost:8787/api/auth/session',{headers:{Cookie:sessionCookie}}),bindings);expect(await after.json()).toEqual({authenticated:false});
});

it.each(['expired','used','revoked'])('招待が登録途中で%sになったらoptions/verifyを拒否する',async state=>{
 authTestIP=`passkey-${state}`;
 const owner=id(),project=id(),invite=id(),token=randomToken();
 await s.sql('INSERT INTO users(id,display_name,created_at) VALUES(?,?,?)',owner,'Owner',now()).run();
 await s.sql('INSERT INTO projects(id,name,owner_id,created_at) VALUES(?,?,?,?)',project,'Invitation registration',owner,now()).run();
 await s.sql('INSERT INTO project_invites(id,project_id,email,role,token_hash,expires_at,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)',invite,project,'pending@example.com','CREATOR',await sha256(token),new Date(Date.now()+86400000).toISOString(),owner,now()).run();
 const signup=await req('/api/auth/invite-signup',{name:'Guest',token});expect(signup.status).toBe(201);
 const cookie=signup.headers.get('Set-Cookie')!.split(';')[0];
 const options=await req('/api/auth/passkey/register/options',{},cookie);expect(options.status).toBe(200);
 const challenge=options.headers.get('Set-Cookie')!.split(';')[0];
 if(state==='expired')await s.sql('UPDATE project_invites SET expires_at=? WHERE id=?','2000-01-01',invite).run();
 else if(state==='revoked')await s.sql('UPDATE project_invites SET revoked_at=? WHERE id=?',now(),invite).run();
 else {const acceptedUser=id();await s.sql('INSERT INTO users(id,created_at) VALUES(?,?)',acceptedUser,now()).run();await s.sql('UPDATE project_invites SET consumed_at=?,consumed_by=? WHERE id=?',now(),acceptedUser,invite).run();}
 expect((await req('/api/auth/passkey/register/options',{},cookie)).status).toBe(state==='expired'?410:400);
 expect((await req('/api/auth/passkey/register/verify',{response:{}},challenge)).status).toBe(state==='expired'?410:400);
 expect((await s.sql('SELECT c.id FROM webauthn_credentials c JOIN enrollment_tokens e ON e.recipient_id=c.recipient_id WHERE e.token_hash=?',await sha256(cookie.split('=')[1])).all()).results).toHaveLength(0);
});
