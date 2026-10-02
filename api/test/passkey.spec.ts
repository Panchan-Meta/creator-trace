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
function registrationResponse(challenge:string){
 const {publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),jwk=publicKey.export({format:'jwk'}),credentialId=crypto.getRandomValues(new Uint8Array(32));
 const cose=cbor(new Map<number,unknown>([[1,2],[3,-7],[-1,1],[-2,Buffer.from(jwk.x!,'base64url')],[-3,Buffer.from(jwk.y!,'base64url')]]));
 const authData=Buffer.concat([hash('localhost'),Buffer.from([0x45,0,0,0,0]),Buffer.alloc(16),Buffer.from([0,32]),Buffer.from(credentialId),cose]);
 return {id:b64(credentialId),rawId:b64(credentialId),type:'public-key',response:{clientDataJSON:b64(Buffer.from(JSON.stringify({type:'webauthn.create',challenge,origin:bindings.APP_ORIGIN,crossOrigin:false}))),attestationObject:b64(cbor(new Map<string,unknown>([['fmt','none'],['attStmt',new Map()],['authData',authData]]))),transports:['internal']},clientExtensionResults:{}};
}
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
it('一般登録は設定がtrueでも拒否し、ユーザー・登録token・案件を作成しない',async()=>{
 const counts=async()=>({users:await s.sql('SELECT count(*) AS n FROM users').first(),projects:await s.sql('SELECT count(*) AS n FROM projects').first(),tokens:await s.sql('SELECT count(*) AS n FROM enrollment_tokens').first(),credentials:await s.sql('SELECT count(*) AS n FROM webauthn_credentials').first()});
 const before=await counts();
 for(const body of [{name:'Creator',project_name:'Unexpected project'},{name:'Creator',project_name:'Unexpected',is_admin:true},{}]){
  const response=await req('/api/auth/signup',body);expect(response.status).toBe(410);expect(response.headers.get('Set-Cookie')).toBeNull();
 }
 expect(await counts()).toEqual(before);
});
it('停止前の自己登録tokenと登録challengeは再開できず、既存データを保持する',async()=>{
 const user=id(),token=randomToken(),enrollment=await sha256(token),challenge=randomToken(),time=now();
 await s.sql('INSERT INTO users(id,display_name,created_at) VALUES(?,?,?)',user,'Pending historical signup',time).run();
 await s.sql('INSERT INTO enrollment_tokens VALUES(?,?,?,NULL)',enrollment,user,new Date(Date.now()+600000).toISOString()).run();
 await s.sql('INSERT INTO signup_enrollments VALUES(?,?,?)',enrollment,'Must not be created',time).run();
 await s.sql('INSERT INTO auth_challenges VALUES(?,?,?,?,?,?)',await sha256(challenge),'old-challenge','register',user,enrollment,new Date(Date.now()+300000).toISOString()).run();
 expect((await req('/api/auth/passkey/register/options',{},`ct_enrollment=${token}`)).status).toBe(410);
 expect((await req('/api/auth/passkey/register/verify',{response:{}},`punka_challenge=${challenge}`)).status).toBe(410);
 expect(await s.sql('SELECT id,display_name FROM users WHERE id=?',user).first()).toEqual({id:user,display_name:'Pending historical signup'});
 expect(await s.sql('SELECT consumed_at FROM enrollment_tokens WHERE token_hash=?',enrollment).first()).toEqual({consumed_at:null});
 expect((await s.sql('SELECT id FROM webauthn_credentials WHERE recipient_id=?',user).all()).results).toHaveLength(0);
 expect((await s.sql('SELECT id FROM projects WHERE owner_id=?',user).all()).results).toHaveLength(0);
 expect(await s.sql('SELECT project_name FROM signup_enrollments WHERE token_hash=?',enrollment).first()).toEqual({project_name:'Must not be created'});
});
it.each(['provisioned','invite','activation'])('%s: 実署名Passkeyの登録 → ログイン → session → logout、招待再使用を拒否',async mode=>{
 authTestIP=`passkey-flow-${mode}`;
 let invitation:any,ownerProject:string|undefined,activationAdminCookie:string|undefined;
 if(mode==='invite'){const owner=id(),session=randomToken();await s.sql('INSERT INTO users(id,display_name,created_at) VALUES(?,?,?)',owner,'Punka',now()).run();ownerProject=id();await s.sql('INSERT INTO projects(id,name,owner_id,created_at) VALUES(?,?,?,?)',ownerProject,"Rahab's mission",owner,now()).run();await s.sql('INSERT INTO sessions VALUES(?,?,?)',await sha256(session),owner,new Date(Date.now()+86400000).toISOString()).run();invitation=await (await req(`/api/projects/${ownerProject}/invites`,{email:'mfzb5683rhcp2525@gmail.com',role:'CREATOR'},`punka_session=${session}`)).json();}
 let enrollmentCookie:string,userId:string;
 if(mode==='provisioned'){
  userId=id();const token=randomToken();await s.sql('INSERT INTO users(id,display_name,created_at) VALUES(?,?,?)',userId,'Creator',now()).run();await s.sql('INSERT INTO sessions VALUES(?,?,?)',await sha256(token),userId,new Date(Date.now()+86400000).toISOString()).run();enrollmentCookie=`punka_session=${token}`;
 }else if(mode==='activation'){
  const admin=id(),session=randomToken();await s.sql('INSERT INTO users(id,display_name,created_at) VALUES(?,?,?)',admin,'System admin',now()).run();await s.sql('INSERT INTO site_admins VALUES(?,?)',admin,now()).run();await s.sql('INSERT INTO sessions VALUES(?,?,?)',await sha256(session),admin,new Date(Date.now()+86400000).toISOString()).run();
  activationAdminCookie=`punka_session=${session}`;const issued=await req('/api/admin/account-activations',{email:'customer@example.com'},activationAdminCookie);expect(issued.status).toBe(201);invitation=await issued.json();enrollmentCookie='';userId='';
 }else{
  const signup=await req('/api/auth/invite-signup',{name:'Rahab',token:invitation.url.split('/').at(-1)});expect(signup.status).toBe(201);enrollmentCookie=signup.headers.get('Set-Cookie')!.split(';')[0];const enrollment=await s.sql('SELECT recipient_id FROM enrollment_tokens WHERE token_hash=?',await sha256(enrollmentCookie.split('=')[1])).first<{recipient_id:string}>();userId=enrollment!.recipient_id;
 }
 const enrollmentToken=enrollmentCookie.split('=')[1];
 expect((await req('/api/auth/passkey/register/options',{})).status).toBe(401);
 const optionsResponse=await req('/api/auth/passkey/register/options',mode==='activation'?{activationToken:invitation.url.split('/').at(-1),display_name:'  Customer A  '}:{},enrollmentCookie);expect(optionsResponse.status).toBe(200);const options=await optionsResponse.json() as {user:{id:string};challenge:string;authenticatorSelection:{authenticatorAttachment?:string;residentKey:string;userVerification:string};hints:string[]};expect(options.authenticatorSelection.authenticatorAttachment).toBeUndefined();expect(options.authenticatorSelection.residentKey).toBe('required');expect(options.authenticatorSelection.userVerification).toBe('required');expect(options.hints).toEqual(['hybrid','client-device','security-key']);const challengeCookie=optionsResponse.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
 if(mode==='activation'){userId=Buffer.from(options.user.id,'base64url').toString();expect(await s.sql('SELECT id FROM users WHERE id=?',userId).first()).toBeNull();expect((await req('/api/auth/passkey/register/verify',{response:{}},challengeCookie.split('; ')[0])).status).toBe(403);}
 const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});const jwk=publicKey.export({format:'jwk'});const credentialId=crypto.getRandomValues(new Uint8Array(32));
 const cose=cbor(new Map<number,unknown>([[1,2],[3,-7],[-1,1],[-2,Buffer.from(jwk.x!,'base64url')],[-3,Buffer.from(jwk.y!,'base64url')]]));
 const authData=Buffer.concat([hash('localhost'),Buffer.from([0x45,0,0,0,0]),Buffer.alloc(16),Buffer.from([0,32]),Buffer.from(credentialId),cose]);
 const attestation=cbor(new Map<string,unknown>([['fmt','none'],['attStmt',new Map()],['authData',authData]]));
 const clientData=Buffer.from(JSON.stringify({type:'webauthn.create',challenge:options.challenge,origin:bindings.APP_ORIGIN,crossOrigin:false}));
 const response={id:b64(credentialId),rawId:b64(credentialId),type:'public-key',response:{clientDataJSON:b64(clientData),attestationObject:b64(attestation),transports:['internal']},clientExtensionResults:{}};
 const registration=await req('/api/auth/passkey/register/verify',{response},mode==='provisioned'?`${enrollmentCookie}; ${challengeCookie}`:challengeCookie);expect(registration.status,await registration.clone().text()).toBe(200);expect(registration.headers.get('Set-Cookie')).toContain('HttpOnly');expect(registration.headers.get('Set-Cookie')).toContain('SameSite=Strict');
 if(mode==='invite')expect((await req('/api/auth/passkey/register/options',{},enrollmentCookie)).status).toBe(401);const projects=await s.sql('SELECT * FROM projects WHERE owner_id=?',userId).all();expect(projects.results).toHaveLength(0);
 if(mode==='activation'){
  expect(await s.sql('SELECT status,user_id,activated_at FROM account_activations WHERE id=?',invitation.id).first()).toMatchObject({status:'ACTIVATED',user_id:userId,activated_at:expect.any(String)});
  expect(await s.sql('SELECT display_name,email FROM users WHERE id=?',userId).first()).toEqual({display_name:'Customer A',email:'customer@example.com'});
  expect(await s.sql('SELECT user_id FROM site_admins WHERE user_id=?',userId).first()).toBeNull();
  expect((await req('/api/auth/account-activation/preview',{token:invitation.url.split('/').at(-1)})).status).toBe(410);
  expect((await req('/api/auth/passkey/register/options',{activationToken:invitation.url.split('/').at(-1),display_name:'Reuse'})).status).toBe(410);
  const session=registration.headers.getSetCookie()[0].split(';')[0];
  const created=await req('/api/projects',{name:'Customer project'},session);expect(created.status).toBe(201);const project=await created.json() as {id:string;created_at:string};
  expect(await s.sql('SELECT user_id,role,status,created_at FROM project_members WHERE project_id=?',project.id).first()).toEqual({user_id:userId,role:'OWNER',status:'ACTIVE',created_at:project.created_at});
  expect((await worker.fetch(new Request('http://localhost:8787/admin/users',{headers:{Cookie:session}}),bindings)).status).toBe(403);
  expect((await req('/api/admin/account-activations',{email:'other@example.com'},session)).status).toBe(403);
  expect((await worker.fetch(new Request('http://localhost:8787/api/admin/inquiries',{headers:{Cookie:session}}),bindings)).status).toBe(403);
  for(const event of ['ACCOUNT_ACTIVATED','PROJECT_CREATED','OWNER_ASSIGNED'])expect(await s.sql('SELECT event_type FROM audit_events WHERE actor_user_id=? AND event_type=?',userId,event).first()).not.toBeNull();
 }
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
 const sessionCookie=loggedIn.headers.get('Set-Cookie')!.split(';')[0];const session=await worker.fetch(new Request('http://localhost:8787/api/auth/session',{headers:{Cookie:sessionCookie}}),bindings);expect(await session.json()).toMatchObject({authenticated:true,recipient_id:userId,display_name:mode==='provisioned'?'Creator':mode==='activation'?'Customer A':'Rahab'});
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
 if(mode==='activation'){
  const pending=await req('/api/auth/passkey/login/options',{}),challenge=await pending.json() as {challenge:string};
  const client=Buffer.from(JSON.stringify({type:'webauthn.get',challenge:challenge.challenge,origin:bindings.APP_ORIGIN,crossOrigin:false}));
  const data=Buffer.concat([hash('localhost'),Buffer.from([0x05,0,0,0,2])]);
  const stopped={...assertion,response:{...assertion.response,authenticatorData:b64(data),clientDataJSON:b64(client),signature:b64(sign('sha256',Buffer.concat([data,hash(client)]),privateKey))}};
  expect((await req(`/api/admin/users/${userId}/terminate`,{},activationAdminCookie)).status).toBe(200);
  expect((await req('/api/auth/passkey/login/verify',{response:stopped},pending.headers.get('Set-Cookie')!.split(';')[0])).status).toBe(400);
  const credentials=await s.sql('SELECT revoked_at FROM webauthn_credentials WHERE recipient_id=?',userId).all();expect(credentials.results).toHaveLength(2);expect(credentials.results.every(c=>c.revoked_at!==null)).toBe(true);
 }

});

it('同じactivationを2ブラウザーで同時に実署名登録しても1ユーザー・1credentialだけ確定する',async()=>{
 authTestIP='activation-concurrency';const admin=id(),session=randomToken();
 await s.sql('INSERT INTO users(id,display_name,created_at) VALUES(?,?,?)',admin,'Admin',now()).run();await s.sql('INSERT INTO site_admins VALUES(?,?)',admin,now()).run();await s.sql('INSERT INTO sessions VALUES(?,?,?)',await sha256(session),admin,new Date(Date.now()+86400000).toISOString()).run();
 const issued=await req('/api/admin/account-activations',{email:'concurrent@example.com'},`punka_session=${session}`);expect(issued.status).toBe(201);const activation=await issued.json() as {id:string;url:string};
 const registrations=[];
 for(const name of ['Browser A','Browser B']){const r=await req('/api/auth/passkey/register/options',{activationToken:activation.url.split('/').at(-1),display_name:name});expect(r.status).toBe(200);const options=await r.json() as {challenge:string};registrations.push({cookie:r.headers.getSetCookie().map(c=>c.split(';')[0]).join('; '),response:registrationResponse(options.challenge)});}
 const results=await Promise.all(registrations.map(r=>req('/api/auth/passkey/register/verify',{response:r.response},r.cookie)));
 expect(results.filter(r=>r.status===200)).toHaveLength(1);expect(results.filter(r=>[400,410,401].includes(r.status))).toHaveLength(1);
 expect(await s.sql("SELECT count(*) AS n FROM users WHERE email='concurrent@example.com'").first()).toEqual({n:1});
 expect(await s.sql("SELECT count(*) AS n FROM webauthn_credentials c JOIN users u ON u.id=c.recipient_id WHERE u.email='concurrent@example.com'").first()).toEqual({n:1});
 expect(await s.sql("SELECT count(*) AS n FROM audit_events WHERE target_id=? AND event_type='ACCOUNT_ACTIVATED'",activation.id).first()).toEqual({n:1});
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
