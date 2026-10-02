import {env,applyD1Migrations} from 'cloudflare:test';
import {beforeAll,it,expect} from 'vitest';
import worker from '../src/index';
import {Store,type Bindings} from '../src/store';
import {id,now,randomToken,sha256} from '../src/domain';
import {expireAccountActivations} from '../src/account-activations';
const bindings={...env,APP_ORIGIN:'http://localhost:8787',RP_ID:'localhost'} as Bindings,s=new Store(bindings);
let ip=0;
async function request(path:string,body?:unknown,cookie?:string,origin=bindings.APP_ORIGIN){return worker.fetch(new Request(bindings.APP_ORIGIN+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,'Content-Type':'application/json','CF-Connecting-IP':`activation-test-${++ip}`,...(cookie?{Cookie:cookie}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})}),bindings);}
async function user(admin=false){const user=id(),token=randomToken();await s.sql('INSERT INTO users(id,display_name,created_at) VALUES(?,?,?)',user,admin?'Punka':'Customer',now()).run();if(admin)await s.sql('INSERT INTO site_admins VALUES(?,?)',user,now()).run();await s.sql('INSERT INTO sessions VALUES(?,?,?)',await sha256(token),user,new Date(Date.now()+86400000).toISOString()).run();return {user,cookie:`punka_session=${token}`};}
async function issue(cookie:string,email=`${id()}@example.com`){const r=await request('/api/admin/account-activations',{email},cookie);expect(r.status,await r.clone().text()).toBe(201);const result=await r.json() as {id:string;url:string;expires_at:string};return {...result,email,token:result.url.split('/').at(-1)!};}
beforeAll(async()=>applyD1Migrations(env.DB,(env as unknown as {TEST_MIGRATIONS:Parameters<typeof applyD1Migrations>[1]}).TEST_MIGRATIONS));
it('ADMINのみ発行・一覧・取消でき、OWNERは他案件や管理画面を操作できない',async()=>{
 const admin=await user(true),owner=await user();
 for(const path of ['/admin/users','/api/admin/users']){expect((await request(path)).status).toBe(401);expect((await request(path,undefined,owner.cookie)).status).toBe(403);expect((await request(path,undefined,admin.cookie)).status).toBe(200);}
 expect((await request('/api/admin/account-activations',{email:'owner@example.com'},owner.cookie)).status).toBe(403);
 const a=await issue(admin.cookie);
 expect((await request(`/api/admin/account-activations/${a.id}/revoke`,{},owner.cookie)).status).toBe(403);
 const ownProject=await request('/api/projects',{name:'Owned'},owner.cookie);expect(ownProject.status).toBe(201);const p=await ownProject.json() as {id:string};
 expect((await request(`/api/projects/${p.id}/edit`,{name:'Updated',client_name:''},owner.cookie)).status).toBe(200);
 const other=await user(),otherProject=await request('/api/projects',{name:'Other'},other.cookie),q=await otherProject.json() as {id:string};
 expect((await request(`/api/projects/${q.id}`,undefined,owner.cookie)).status).toBe(404);
 expect((await request('/api/admin/inquiries',undefined,owner.cookie)).status).toBe(403);
 expect(await s.sql('SELECT user_id FROM site_admins WHERE user_id=?',owner.user).first()).toBeNull();
});
it('作成時のみURLを返し、tokenは256bitランダム値のSHA-256で保存する',async()=>{
 const admin=await user(true),a=await issue(admin.cookie,' Customer@Example.com ');
 expect(a.token).toMatch(/^[a-f0-9]{64}$/);expect(a.url).toContain('/activate/');
 const row=await s.sql('SELECT * FROM account_activations WHERE id=?',a.id).first();expect(row).toMatchObject({email:'customer@example.com',token_hash:await sha256(a.token),status:'PENDING',user_id:null});
 expect(JSON.stringify(row)).not.toContain(a.token);
 const list=await request('/api/admin/users',undefined,admin.cookie);const data=await list.text();expect(data).not.toContain(a.token);expect(data).not.toContain('token_hash');
 expect((await request('/api/auth/account-activation/preview',{token:a.token})).status).toBe(200);
 expect((await request('/api/admin/account-activations',{email:'customer@example.com'},admin.cookie)).status).toBe(409);
 const audits=await s.sql('SELECT * FROM audit_events WHERE target_id=?',a.id).all();expect(audits.results).toHaveLength(1);expect(audits.results[0].event_type).toBe('ACCOUNT_ACTIVATION_CREATED');expect(JSON.stringify(audits)).not.toContain(a.token);
});
it('取消・期限切れは410、再発行後も古いtokenは無効で監査が一度だけ残る',async()=>{
 const admin=await user(true),a=await issue(admin.cookie);
 expect((await request(`/api/admin/account-activations/${a.id}/revoke`,{},admin.cookie)).status).toBe(200);
 expect((await request('/api/auth/account-activation/preview',{token:a.token})).status).toBe(410);
 const replacement=await issue(admin.cookie,a.email);expect(replacement.token).not.toBe(a.token);
 expect((await request('/api/auth/passkey/register/options',{activationToken:a.token,display_name:'Old'})).status).toBe(410);
 const expired=id(),token=randomToken(),email=`${id()}@example.com`;
 await s.sql('INSERT INTO account_activations(id,email,token_hash,expires_at,created_by_admin_id,created_at) VALUES(?,?,?,?,?,?)',expired,email,await sha256(token),'2000-01-01T00:00:00.000Z',admin.user,now()).run();
 const result=await request('/api/auth/account-activation/preview',{token});expect(result.status).toBe(410);expect(await result.json()).toEqual({error:'この利用開始URLは期限切れです。'});
 await expireAccountActivations(bindings);await issue(admin.cookie,email);
 expect(await s.sql("SELECT count(*) AS n FROM audit_events WHERE target_id=? AND event_type='ACCOUNT_ACTIVATION_EXPIRED'",expired).first()).toEqual({n:1});
 expect(await s.sql("SELECT count(*) AS n FROM audit_events WHERE target_id=? AND event_type='ACCOUNT_ACTIVATION_REVOKED'",a.id).first()).toEqual({n:1});
});
it('登録途中の取消・ブラウザ違い・別ユーザーのsession・不正署名でユーザーを作らない',async()=>{
 const admin=await user(true),a=await issue(admin.cookie),another=await user();
 const before=await s.sql('SELECT count(*) AS n FROM users').first();
 const options=await request('/api/auth/passkey/register/options',{activationToken:a.token,display_name:'Customer'});expect(options.status).toBe(200);
 const cookies=options.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
 expect((await request('/api/auth/passkey/register/verify',{response:{}},cookies.split('; ')[0])).status).toBe(403);
 expect((await request('/api/auth/passkey/register/verify',{response:{}},cookies+'; '+another.cookie)).status).toBe(409);
 expect((await request('/api/auth/passkey/register/options',{activationToken:a.token,display_name:'Customer'},another.cookie)).status).toBe(409);
 expect((await request('/api/auth/passkey/register/verify',{response:{}},cookies)).status).toBe(400);
 const retry=await request('/api/auth/passkey/register/options',{activationToken:a.token,display_name:'Customer'});expect(retry.status).toBe(200);const retryCookies=retry.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
 await request(`/api/admin/account-activations/${a.id}/revoke`,{},admin.cookie);
 expect((await request('/api/auth/passkey/register/verify',{response:{}},retryCookies)).status).toBe(410);
 expect(await s.sql('SELECT count(*) AS n FROM users').first()).toEqual(before);
});
it('CSRF・権限注入・空白名・不正token・既存メールを拒否する',async()=>{
 const admin=await user(true),a=await issue(admin.cookie);
 expect((await request('/api/admin/account-activations',{email:'csrf@example.com'},admin.cookie,'https://evil.example')).status).toBe(403);
 expect((await request('/api/admin/account-activations',{email:'admin@example.com',is_admin:true},admin.cookie)).status).toBe(400);
 for(const display_name of [' ', 'x'.repeat(51)])expect((await request('/api/auth/passkey/register/options',{activationToken:a.token,display_name})).status).toBe(400);
 expect((await request('/api/auth/passkey/register/options',{activationToken:a.token,display_name:'Normal',is_admin:true})).status).toBe(400);
 expect((await request('/api/auth/account-activation/preview',{token:'bad'})).status).toBe(400);
 expect((await request('/api/auth/signup',{name:'Nobody',project_name:'No'})).status).toBe(410);
 await s.sql('UPDATE users SET email=? WHERE id=?','existing@example.com',admin.user).run();
 expect((await request('/api/admin/account-activations',{email:'EXISTING@example.com'},admin.cookie)).status).toBe(409);
});
it('認証APIのレート制限を維持する',async()=>{
 let status=0;for(let n=0;n<31;n++){const r=await worker.fetch(new Request(bindings.APP_ORIGIN+'/api/auth/account-activation/preview',{method:'POST',headers:{Origin:bindings.APP_ORIGIN,'Content-Type':'application/json','CF-Connecting-IP':'activation-rate-test'},body:JSON.stringify({token:'a'.repeat(64)})}),bindings);status=r.status;}expect(status).toBe(429);
});
it('Passkey操作中に期限が切れたactivationは確定できない',async()=>{
 const admin=await user(true),activation=id(),token=randomToken();
 await s.sql('INSERT INTO account_activations(id,email,token_hash,expires_at,created_by_admin_id,created_at) VALUES(?,?,?,?,?,?)',activation,`${id()}@example.com`,await sha256(token),new Date(Date.now()+1500).toISOString(),admin.user,now()).run();
 const options=await request('/api/auth/passkey/register/options',{activationToken:token,display_name:'Expiring customer'});expect(options.status).toBe(200);const cookies=options.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
 await new Promise(resolve=>setTimeout(resolve,1600));
 const verify=await request('/api/auth/passkey/register/verify',{response:{}},cookies);expect(verify.status).toBe(410);expect(await verify.json()).toEqual({error:'この利用開始URLは期限切れです。'});
 expect(await s.sql('SELECT status,user_id FROM account_activations WHERE id=?',activation).first()).toEqual({status:'EXPIRED',user_id:null});
});
