import { generateRegistrationOptions, generateAuthenticationOptions, verifyRegistrationResponse, verifyAuthenticationResponse, type RegistrationResponseJSON, type AuthenticationResponseJSON, type AuthenticatorTransport } from '@simplewebauthn/server';
import { z } from 'zod';
import {displayName} from './display-name';
import { HttpError, id, now, randomToken, sha256 } from './domain';
import { Store, type Bindings } from './store';
export function cookieValue(request:Request,name:string) { return request.headers.get('Cookie')?.split(';').map(v=>v.trim()).find(v=>v.startsWith(`${name}=`))?.slice(name.length+1); }
export function cookie(env:Bindings,name:string,value:string,seconds:number) { return `${name}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${seconds}${env.APP_ORIGIN.startsWith('https://')?'; Secure':''}`; }
export async function currentUser(request:Request,service:Store) {
 const token=cookieValue(request,'punka_session'); if(!token) throw new HttpError(401,'Passkeyでログインしてください');
 const session=await service.sql('SELECT recipient_id FROM sessions WHERE token_hash=? AND expires_at>?',await sha256(token),now()).first<{recipient_id:string}>();
 if(!session) throw new HttpError(401,'ログイン期限が切れています'); return session.recipient_id;
}
// Enrollment cookie binds registration to its original invitation; recheck after device interaction.
async function validateInviteEnrollment(s:Store,hash:string){
 const invite=await s.sql('SELECT i.consumed_at,i.revoked_at,i.expires_at,p.archived_at FROM invite_enrollments e JOIN project_invites i ON i.id=e.invite_id JOIN projects p ON p.id=i.project_id WHERE e.token_hash=?',hash).first<{consumed_at:string|null;revoked_at:string|null;expires_at:string;archived_at:string|null}>();
 if(!invite)return;
 if(invite.consumed_at||invite.revoked_at)throw new HttpError(400,'この招待は使用済みまたは無効です');
 if(invite.expires_at<=now())throw new HttpError(410,'招待URLの有効期限が切れています');
 if(invite.archived_at)throw new HttpError(409,'案件はアーカイブ済みです');
}
async function authRequest(request:Request,env:Bindings,path:string):Promise<Response> {
 const s=new Store(env);
 if(['/api/auth/signup','/api/auth/invite-signup'].includes(path)&&request.method==='POST'){
  const invited=path==='/api/auth/invite-signup';
  if(env.SIGNUP_ENABLED!=='true')throw new HttpError(503,'新規登録は現在準備中です');
  const schema=invited?z.object({name:displayName,token:z.string().min(32).max(200),website:z.string().max(200).default('')}).strict():z.object({name:z.string().trim().min(1).max(200),project_name:z.string().trim().min(1).max(200),website:z.string().max(200).default('')}).strict();
  const d=schema.parse(await request.json());if(d.website)throw new HttpError(400,'入力を確認してください');
  let inviteId:string|null=null;
  if('token' in d){const invitation=await s.sql('SELECT i.id,i.expires_at,i.consumed_at,i.revoked_at,p.archived_at FROM project_invites i JOIN projects p ON p.id=i.project_id WHERE token_hash=?',await sha256(d.token)).first<{id:string;expires_at:string;consumed_at:string|null;revoked_at:string|null;archived_at:string|null}>();if(!invitation)throw new HttpError(400,'招待が無効です');if(invitation.consumed_at||invitation.revoked_at)throw new HttpError(400,'この招待は使用済みまたは無効です');if(invitation.expires_at<=now())throw new HttpError(410,'招待URLの有効期限が切れています');if(invitation.archived_at)throw new HttpError(409,'案件はアーカイブ済みです');inviteId=invitation.id;}

  const bucket=await sha256(`signup:${request.headers.get('CF-Connecting-IP')??'local'}`),epoch=Math.floor(Date.now()/3600000);const rate=await s.sql('INSERT INTO rate_limits(key,count,reset_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN reset_at=excluded.reset_at THEN count+1 ELSE 1 END,reset_at=excluded.reset_at RETURNING count',bucket,epoch).first<{count:number}>();if(rate!.count>5)throw new HttpError(429,'登録をしばらく待ってから再試行してください');
  const user=id(),token=randomToken(),hash=await sha256(token),time=now();await env.DB.batch([s.sql('INSERT INTO users(id,display_name,created_at) VALUES(?,?,?)',user,d.name,time),s.sql('INSERT INTO enrollment_tokens VALUES(?,?,?,NULL)',hash,user,new Date(Date.now()+600000).toISOString()),...('project_name' in d?[s.sql('INSERT INTO signup_enrollments VALUES(?,?,?)',hash,d.project_name,time)]:[s.sql('INSERT INTO invite_enrollments VALUES(?,?,?)',hash,inviteId,time)])]);return Response.json({ok:true},{status:201,headers:{'Set-Cookie':cookie(env,'ct_enrollment',token,600)}});
 }
 if(path==='/api/auth/session' && request.method==='GET') { try {const user=await currentUser(request,s),profile=await s.sql('SELECT display_name FROM users WHERE id=?',user).first<{display_name:string|null}>();const memberships=(await s.sql("SELECT m.project_id,p.name AS project_name,m.role FROM project_members m JOIN projects p ON p.id=m.project_id WHERE m.user_id=? AND m.status='ACTIVE' AND p.archived_at IS NULL ORDER BY p.name,p.id",user).all()).results;return Response.json({authenticated:true,recipient_id:user,display_name:profile?.display_name??'',memberships,is_admin:!!await s.sql('SELECT user_id FROM site_admins WHERE user_id=?',user).first()});} catch {return Response.json({authenticated:false});} }
 if(path==='/api/auth/passkeys' && request.method==='GET') {
  const recipient=await currentUser(request,s);
  const passkeys=await s.sql('SELECT id,name,created_at FROM webauthn_credentials WHERE recipient_id=? ORDER BY created_at',recipient).all<{created_at:string}>();
  return Response.json({passkeys:passkeys.results});
 }
 if(request.method!=='POST') throw new HttpError(405,'Method not allowed');
 const removal=path.match(/^\/api\/auth\/passkeys\/([^/]+)\/remove$/);
 if(removal){const user=await currentUser(request,s);const credential=decodeURIComponent(removal[1]);const count=await s.sql('SELECT count(*) AS n FROM webauthn_credentials WHERE recipient_id=?',user).first<{n:number}>();if(count!.n<=1)throw new HttpError(409,'最後のPasskeyは削除できません');await env.DB.batch([s.sql('DELETE FROM webauthn_credentials WHERE id=? AND recipient_id=?',credential,user),s.sql('INSERT INTO audit_events(actor_user_id,event_type,target_type,target_id,created_at) VALUES(?,?,?,?,?)',user,'PASSKEY_REMOVED','passkey',credential,now())]);return Response.json({ok:true});}
 if(path==='/api/auth/logout') {
  const token=cookieValue(request,'punka_session'); if(token) await s.sql('DELETE FROM sessions WHERE token_hash=?',await sha256(token)).run();
  return Response.json({ok:true},{headers:{'Set-Cookie':cookie(env,'punka_session','',0)}});
 }
 const registration=path.includes('/register/');
 if(!/^\/api\/auth\/passkey\/(register|login)\/(options|verify)$/.test(path)) throw new HttpError(404,'Not found');
 const body=z.record(z.string(),z.unknown()).parse(await request.json());
 if(path.endsWith('/options')) {
  let recipientId:string|null=null, enrollmentHash:string|null=null;
  if(registration) {
   if(!Object.hasOwn(body,'invite')) {
    const token=cookieValue(request,'ct_enrollment');
    if(token){const hash=await sha256(token),enrollment=await s.sql('SELECT e.recipient_id FROM enrollment_tokens e LEFT JOIN signup_enrollments se ON se.token_hash=e.token_hash LEFT JOIN invite_enrollments ie ON ie.token_hash=e.token_hash WHERE e.token_hash=? AND e.consumed_at IS NULL AND e.expires_at>? AND (se.token_hash IS NOT NULL OR ie.token_hash IS NOT NULL)',hash,now()).first<{recipient_id:string}>();if(enrollment){recipientId=enrollment.recipient_id;enrollmentHash=hash;}else recipientId=await currentUser(request,s);}else recipientId=await currentUser(request,s);
   } else {
    throw new HttpError(410,'修了証の招待による登録は停止しました');
   }
  }
  if(enrollmentHash)await validateInviteEnrollment(s,enrollmentHash);
  const options=registration?await generateRegistrationOptions({rpName:'Creator Trace',rpID:env.RP_ID,userName:`Creator Trace ${recipientId!.slice(0,8)}`,userID:Uint8Array.from(new TextEncoder().encode(recipientId!)),attestationType:'none',timeout:300000,authenticatorSelection:{residentKey:'required',userVerification:'required'},excludeCredentials:(await s.sql('SELECT id,transports_json FROM webauthn_credentials WHERE recipient_id=?',recipientId!).all<{id:string;transports_json:string}>()).results.map(c=>({id:c.id,transports:JSON.parse(c.transports_json) as AuthenticatorTransport[]}))}):{...await generateAuthenticationOptions({rpID:env.RP_ID,userVerification:'required',timeout:300000}),hints:['hybrid']};
  // Advisory hints allow phone QR registration without restricting attachment to this PC.
  if(registration)options.hints=['hybrid','client-device','security-key'];
  const challengeId=randomToken();
  await s.sql('INSERT INTO auth_challenges VALUES(?,?,?,?,?,?)',await sha256(challengeId),options.challenge,registration?'register':'login',recipientId,enrollmentHash,new Date(Date.now()+300000).toISOString()).run();
  return Response.json(options,{headers:{'Set-Cookie':cookie(env,'punka_challenge',challengeId,300)}});
 }
 const challengeToken=cookieValue(request,'punka_challenge');
 if(!challengeToken) throw new HttpError(400,'認証を開始し直してください');
 // Atomic consume happens before verification: even invalid responses cannot replay a challenge.
 const challenge=await s.sql('DELETE FROM auth_challenges WHERE id=? AND kind=? AND expires_at>? RETURNING *',await sha256(challengeToken),registration?'register':'login',now()).first<{challenge:string;recipient_id:string;enrollment_hash:string|null}>();
 if(!challenge) throw new HttpError(400,'認証チャレンジが無効です');
 if(registration && !challenge.enrollment_hash && await currentUser(request,s)!==challenge.recipient_id) throw new HttpError(403,'登録を開始したアカウントでログインしてください');
 if(registration&&challenge.enrollment_hash)await validateInviteEnrollment(s,challenge.enrollment_hash);
 let recipientId:string;
 try {
  const response=z.object({response:z.object({id:z.string().max(2048),rawId:z.string().max(2048),type:z.literal('public-key'),response:z.record(z.string(),z.unknown()),clientExtensionResults:z.record(z.string(),z.unknown())}).passthrough()}).parse(body).response;
  if(registration) {
   const result=await verifyRegistrationResponse({response:response as unknown as RegistrationResponseJSON,expectedChallenge:challenge.challenge,expectedOrigin:env.APP_ORIGIN,expectedRPID:env.RP_ID,requireUserVerification:true});
   if(!result.verified || !result.registrationInfo) throw new Error('invalid');
   recipientId=challenge.recipient_id;
   const credential=result.registrationInfo.credential;
   // Consume enrollment and insert credential atomically. Project invitation remains pending until explicit acceptance.
   const signup=challenge.enrollment_hash?await s.sql('SELECT project_name FROM signup_enrollments WHERE token_hash=?',challenge.enrollment_hash).first<{project_name:string}>():null;
   await env.DB.batch([
    s.sql('INSERT INTO webauthn_credentials(id,recipient_id,public_key,counter,transports_json,created_at,enrollment_hash,name) VALUES(?,?,?,?,?,?,?,?)',credential.id,recipientId,btoa(String.fromCharCode(...credential.publicKey)),credential.counter,JSON.stringify(credential.transports??[]),now(),challenge.enrollment_hash,z.string().trim().min(1).max(100).default('Passkey').parse(body.name)),
    s.sql('UPDATE enrollment_tokens SET consumed_at=? WHERE token_hash=?',now(),challenge.enrollment_hash),
    ...(challenge.enrollment_hash?[s.sql('UPDATE users SET consent_at=? WHERE id=?',now(),recipientId)]:[]),
    ...(signup?[s.sql('INSERT INTO projects(id,name,owner_id,created_at) VALUES(?,?,?,?)',id(),signup.project_name,recipientId,now())]:[]),
    s.sql('INSERT INTO audit_events(actor_user_id,event_type,target_type,target_id,created_at) VALUES(?,?,?,?,?)',recipientId,'PASSKEY_ADDED','passkey',credential.id,now()),s.audit('recipient','PASSKEY_REGISTERED','recipient',recipientId)
   ]);
  } else {
   const credential=await s.sql('SELECT * FROM webauthn_credentials WHERE id=?',response.id).first<{id:string;recipient_id:string;public_key:string;counter:number;transports_json:string}>();
   if(!credential) throw new Error('invalid');
   const result=await verifyAuthenticationResponse({response:response as unknown as AuthenticationResponseJSON,expectedChallenge:challenge.challenge,expectedOrigin:env.APP_ORIGIN,expectedRPID:env.RP_ID,requireUserVerification:true,credential:{id:credential.id,publicKey:Uint8Array.from(atob(credential.public_key),c=>c.charCodeAt(0)),counter:credential.counter,transports:JSON.parse(credential.transports_json) as AuthenticatorTransport[]}});
   if(!result.verified) throw new Error('invalid');
   recipientId=credential.recipient_id;
   const changed=await s.sql('UPDATE webauthn_credentials SET counter=? WHERE id=? AND counter=? RETURNING id',result.authenticationInfo.newCounter,credential.id,credential.counter).first();
   if(!changed) throw new Error('concurrent assertion');
  }
 } catch {
  throw new HttpError(400,'Passkeyの確認に失敗しました。もう一度お試しください');
 }
 const token=randomToken();
 await env.DB.batch([s.sql('INSERT INTO sessions VALUES(?,?,?)',await sha256(token),recipientId,new Date(Date.now()+86400000).toISOString()),s.audit('recipient','LOGIN_SUCCEEDED','recipient',recipientId)]);
 const headers=new Headers();headers.append('Set-Cookie',cookie(env,'punka_session',token,86400));headers.append('Set-Cookie',cookie(env,'punka_challenge','',0));
 return Response.json({ok:true},{headers});
}

export async function auth(request:Request,env:Bindings,path:string):Promise<Response> {
 try {return await authRequest(request,env,path);} catch(error) {
  if(path.endsWith('/login/verify')||path.endsWith('/register/verify')) await new Store(env).audit('anonymous','LOGIN_FAILED','auth','passkey').run();
  throw error;
 }
}
