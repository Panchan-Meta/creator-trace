import {env,applyD1Migrations} from 'cloudflare:test';
import {beforeAll,it,expect} from 'vitest';
import worker from '../src/index';
import {Store,type Bindings} from '../src/store';
import {id,now,randomToken,sha256} from '../src/domain';
const bindings={...env,APP_ORIGIN:'http://localhost:8787',RP_ID:'localhost',OPERATOR_TOKEN:'test-operator',SIGNUP_ENABLED:'true'} as Bindings,s=new Store(bindings);
let ip=0;
async function req(path:string,body?:unknown,cookie?:string,key?:string,origin=bindings.APP_ORIGIN){return worker.fetch(new Request(bindings.APP_ORIGIN+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,'Content-Type':'application/json','CF-Connecting-IP':`termination-${++ip}`,...(cookie?{Cookie:cookie}:{}),...(key?{Authorization:`Bearer ${key}`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})}),bindings);}
async function makeUser(admin=false){const user=id(),token=randomToken();await s.sql('INSERT INTO users(id,display_name,created_at) VALUES(?,?,?)',user,admin?'Punka':'Owner',now()).run();if(admin)await s.sql('INSERT INTO site_admins VALUES(?,?)',user,now()).run();await s.sql('INSERT INTO sessions VALUES(?,?,?)',await sha256(token),user,new Date(Date.now()+86400000).toISOString()).run();return {user,token,cookie:`punka_session=${token}`};}
async function project(user:{cookie:string},name='Owner project'){const r=await req('/api/projects',{name},user.cookie);expect(r.status).toBe(201);return await r.json() as {id:string;created_at:string};}
async function credential(user:string,name='public-test-credential'){const key=id();await s.sql('INSERT INTO webauthn_credentials(id,recipient_id,public_key,counter,transports_json,created_at,name) VALUES(?,?,?,?,?,?,?)',key,user,'public-test-key',0,'[]',now(),name).run();return key;}
async function apiKey(user:{cookie:string}){const r=await req('/api/api-keys',{name:'Integration',scopes:['projects:read']},user.cookie);expect(r.status).toBe(201);return await r.json() as {key_id:string;key:string};}
async function issued(admin:{cookie:string},email:string){const r=await req('/api/admin/account-activations',{email},admin.cookie);expect(r.status).toBe(201);return await r.json() as {id:string;url:string};}
async function rows(table:string){return (await s.sql(`SELECT * FROM ${table} ORDER BY 1`).all()).results;}
beforeAll(async()=>applyD1Migrations(env.DB,(env as unknown as {TEST_MIGRATIONS:Parameters<typeof applyD1Migrations>[1]}).TEST_MIGRATIONS));
it('未認証401・OWNER403・ADMIN自己終了409・全ADMIN保護・CSRF・入力検証',async()=>{
 const admin=await makeUser(true),owner=await makeUser(),otherAdmin=await makeUser(true);await project(owner);
 expect((await req(`/api/admin/users/${owner.user}/terminate`,{})).status).toBe(401);
 expect((await req(`/api/admin/users/${owner.user}/terminate`,{},owner.cookie)).status).toBe(403);
 expect((await req(`/api/admin/users/${admin.user}/terminate`,{},admin.cookie)).status).toBe(409);
 expect((await req(`/api/admin/users/${otherAdmin.user}/terminate`,{},admin.cookie)).status).toBe(409);
 expect((await req(`/api/admin/users/${owner.user}/terminate`,{},admin.cookie,undefined,'https://evil.example')).status).toBe(403);
 expect((await req(`/api/admin/users/${owner.user}/terminate`,{reason:' '},admin.cookie)).status).toBe(400);
 expect((await req(`/api/admin/users/${owner.user}/terminate`,{reason:'End',is_admin:true},admin.cookie)).status).toBe(400);
 expect((await req(`/api/admin/users/${id()}/terminate`,{},admin.cookie)).status).toBe(404);
 expect(await s.sql('SELECT status FROM users WHERE id=?',owner.user).first()).toEqual({status:'ACTIVE'});
});
it('利用権だけを一括失効し、OWNERと制作・承認・納品・OTS・Bitcoin・Botの履歴を保持する',async()=>{
 const admin=await makeUser(true),owner=await makeUser(),member=await makeUser(),other=await makeUser();
 const own=await project(owner),old=await project(owner,'Already archived'),otherProject=await project(other,'Other company');
 await s.sql('UPDATE projects SET archived_at=? WHERE id=?','2025-01-01T00:00:00.000Z',old.id).run();
 await s.sql('INSERT INTO project_members(id,project_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)',id(),own.id,member.user,'REVIEWER','ACTIVE',now()).run();
 await s.sql('INSERT INTO project_members(id,project_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)',id(),otherProject.id,owner.user,'CREATOR','ACTIVE',now()).run();
 const cred=await credential(owner.user),otherCred=await credential(other.user),key=await apiKey(owner),otherKey=await apiKey(other);
 const historyActivation=await issued(admin,`${id()}@example.com`);const historyEmail=(await s.sql('SELECT email FROM account_activations WHERE id=?',historyActivation.id).first<{email:string}>())!.email;
 await s.sql('UPDATE users SET email=? WHERE id=?',historyEmail,owner.user).run();await s.sql("UPDATE account_activations SET status='ACTIVATED',user_id=?,activated_at=? WHERE id=?",owner.user,now(),historyActivation.id).run();
 const pending=await issued(admin,`${id()}@example.com`),pendingEmail=(await s.sql('SELECT email FROM account_activations WHERE id=?',pending.id).first<{email:string}>())!.email;
 await s.sql('UPDATE users SET email=? WHERE id=?',pendingEmail,owner.user).run();
 const unaffectedPending=await issued(admin,`${id()}@example.com`);
 const enrollment=await sha256(randomToken());await s.sql('INSERT INTO enrollment_tokens VALUES(?,?,?,NULL)',enrollment,owner.user,new Date(Date.now()+600000).toISOString()).run();
 await s.sql('INSERT INTO auth_challenges VALUES(?,?,?,?,?,?)',await sha256(randomToken()),'pending-challenge','register',owner.user,enrollment,new Date(Date.now()+300000).toISOString()).run();
 const receipt=(env as unknown as {TEST_OTS:string}).TEST_OTS,digest=Buffer.from(receipt,'base64').subarray(33,65).toString('hex');
 const created=await req(`/api/projects/${own.id}/assets`,{filename:'final.wav',size:10,sha256:digest,status:'SUBMITTED'},owner.cookie);expect(created.status).toBe(201);const a=await created.json() as {id:string;version_id:string;proof_id:string};
 await s.sql("UPDATE asset_version_states SET status='APPROVED',actor_user_id=?,updated_at=? WHERE asset_version_id=?",owner.user,now(),a.version_id).run();await s.sql("UPDATE asset_version_states SET status='FINAL',actor_user_id=?,updated_at=? WHERE asset_version_id=?",owner.user,now(),a.version_id).run();
 await s.sql("UPDATE proofs SET ots_proof=?,timestamp_created_at=?,proof_status='CONFIRMED',timestamp_status='CONFIRMED',bitcoin_status='CONFIRMED',bitcoin_block_height=100,bitcoin_block_hash=?,bitcoin_block_time=?,bitcoin_confirmed_at=? WHERE id=?",receipt,now(),'a'.repeat(64),'2025-01-01T00:00:00.000Z',now(),a.proof_id).run();
 const delivery=await req(`/api/asset-versions/${a.version_id}/deliveries`,{recipient_user_id:member.user},owner.cookie);expect(delivery.status).toBe(201);const deliveryId=(await delivery.json() as {id:string}).id;
 const comment=await req(`/api/assets/${a.id}/review-comments`,{version_id:a.version_id,comment:'Existing review'},member.cookie);expect(comment.status).toBe(201);
 const run=id();await s.sql("INSERT INTO bot_review_runs(id,project_id,asset_version_id,status,model,created_by,started_at,created_at,context_json) VALUES(?,?,?,'RUNNING','test',?,?,?,'{}')",run,own.id,a.version_id,owner.user,now(),now()).run();await s.sql("INSERT INTO bot_review_messages VALUES(?,?,?,'Bot','Engineering','Retained advice',?)",id(),run,'sanada',now()).run();await s.sql("UPDATE bot_review_runs SET status='FAILED',completed_at=? WHERE id=?",now(),run).run();
 const retained=['project_members','project_member_history','assets','asset_versions','asset_version_states','asset_version_state_history','approvals','deliveries','delivery_history','review_comments','proofs','bitcoin_verification_attempts','bot_review_runs','bot_review_messages'];
 const before=await Promise.all(retained.map(rows)),audits=await rows('audit_events'),activationBefore=await s.sql('SELECT * FROM account_activations WHERE id=?',historyActivation.id).first();
 expect((await req('/api/v1/projects',undefined,undefined,key.key)).status).toBe(200);
 const response=await req(`/api/admin/users/${owner.user}/terminate`,{reason:'  契約期間終了  '},admin.cookie);expect(response.status,await response.clone().text()).toBe(200);
 expect(await s.sql('SELECT status,terminated_at,terminated_by_admin_id,termination_reason,display_name,email FROM users WHERE id=?',owner.user).first()).toEqual({status:'TERMINATED',terminated_at:expect.any(String),terminated_by_admin_id:admin.user,termination_reason:'契約期間終了',display_name:'Owner',email:pendingEmail});
 expect((await s.sql('SELECT * FROM sessions WHERE recipient_id=?',owner.user).all()).results).toHaveLength(0);
 expect((await req('/api/projects',undefined,owner.cookie)).status).toBe(401);
 expect(await s.sql('SELECT revoked_at,revoked_by_admin_id FROM webauthn_credentials WHERE id=?',cred).first()).toMatchObject({revoked_at:expect.any(String),revoked_by_admin_id:admin.user});
 expect((await req('/api/v1/projects',undefined,undefined,key.key)).status).toBe(401);
 expect(await s.sql('SELECT revoked_at FROM api_keys WHERE key_id=?',key.key_id).first()).toMatchObject({revoked_at:expect.any(String)});
 expect(await s.sql('SELECT archived_at FROM projects WHERE id=?',own.id).first()).toMatchObject({archived_at:expect.any(String)});
 expect(await s.sql('SELECT archived_at FROM projects WHERE id=?',old.id).first()).toEqual({archived_at:'2025-01-01T00:00:00.000Z'});
 expect(await s.sql('SELECT archived_at FROM projects WHERE id=?',otherProject.id).first()).toEqual({archived_at:null});
 expect(await Promise.all(retained.map(rows))).toEqual(before);const afterAudits=await rows('audit_events');for(const event of audits)expect(afterAudits).toContainEqual(event);
 expect(await s.sql('SELECT * FROM account_activations WHERE id=?',historyActivation.id).first()).toEqual(activationBefore);
 expect(await s.sql('SELECT status FROM account_activations WHERE id=?',pending.id).first()).toEqual({status:'REVOKED'});expect(await s.sql('SELECT status FROM account_activations WHERE id=?',unaffectedPending.id).first()).toEqual({status:'PENDING'});
 expect(await s.sql('SELECT consumed_at FROM enrollment_tokens WHERE token_hash=?',enrollment).first()).toMatchObject({consumed_at:expect.any(String)});
 expect((await s.sql('SELECT * FROM auth_challenges WHERE recipient_id=?',owner.user).all()).results).toHaveLength(0);
 expect((await req(`/api/projects/${own.id}`,undefined,member.cookie)).status).toBe(200);expect((await req(`/api/proofs/${a.proof_id}`,undefined,member.cookie)).status).toBe(200);
 expect((await req(`/api/asset-versions/${a.version_id}/approve`,{},member.cookie)).status).toBe(409);expect((await req(`/api/deliveries/${deliveryId}/receive`,{},member.cookie)).status).toBe(409);expect(await Promise.all(retained.map(rows))).toEqual(before);
 expect((await req('/api/projects',undefined,other.cookie)).status).toBe(200);expect((await req('/api/v1/projects',undefined,undefined,otherKey.key)).status).toBe(200);expect(await s.sql('SELECT revoked_at FROM webauthn_credentials WHERE id=?',otherCred).first()).toEqual({revoked_at:null});
 const events=(await s.sql('SELECT * FROM audit_events WHERE target_id=?',owner.user).all()).results;for(const type of ['USER_TERMINATED','SESSION_REVOKED','PASSKEY_REVOKED','API_KEYS_REVOKED'])expect(events.filter(e=>e.event_type===type)).toHaveLength(1);
 const event=events.find(e=>e.event_type==='USER_TERMINATED')!;expect(JSON.parse(String(event.metadata_json))).toMatchObject({target_user_id:owner.user,terminated_by_admin_id:admin.user,reason:'契約期間終了',session_count:1,passkey_count:1,api_key_count:1,archived_project_count:1});
 const serialized=JSON.stringify(afterAudits);for(const secret of [owner.token,key.key,'public-test-key',pending.url.split('/').at(-1)!])expect(serialized).not.toContain(secret);
 expect((await req(`/api/admin/users/${owner.user}/terminate`,{},admin.cookie)).status).toBe(409);
 const list=await (await req('/api/admin/users',undefined,admin.cookie)).json() as {users:{id:string;status:string;terminated_at:string}[]};expect(list.users.find(u=>u.id===owner.user)).toMatchObject({status:'TERMINATED',terminated_at:expect.any(String)});
});
it('通常OWNER removeと最後の有効Passkey削除は禁止のままで、契約終了は最後のPasskeyも論理失効する',async()=>{
 const admin=await makeUser(true),owner=await makeUser(),p=await project(owner),key=await credential(owner.user);
 const member=await s.sql('SELECT id FROM project_members WHERE project_id=? AND user_id=?',p.id,owner.user).first<{id:string}>();expect((await req(`/api/projects/${p.id}/members/${member!.id}/remove`,{},owner.cookie)).status).toBe(409);
 const old=await credential(owner.user);await s.sql('UPDATE webauthn_credentials SET revoked_at=?,revoked_by_admin_id=? WHERE id=?',now(),admin.user,old).run();
 expect((await req(`/api/auth/passkeys/${key}/remove`,{},owner.cookie)).status).toBe(409);await expect(s.sql('DELETE FROM webauthn_credentials WHERE id=?',key).run()).rejects.toThrow();
 expect((await req(`/api/admin/users/${owner.user}/terminate`,{},admin.cookie)).status).toBe(200);expect((await s.sql('SELECT id FROM webauthn_credentials WHERE recipient_id=?',owner.user).all()).results).toHaveLength(2);
 expect(await s.sql('SELECT role,status FROM project_members WHERE project_id=? AND user_id=?',p.id,owner.user).first()).toEqual({role:'OWNER',status:'ACTIVE'});
 await expect(s.sql('UPDATE webauthn_credentials SET revoked_at=NULL WHERE id=?',key).run()).rejects.toThrow();await expect(s.sql('DELETE FROM users WHERE id=?',owner.user).run()).rejects.toThrow();
});
it('二重同時終了は1回だけ成功し、失敗時にはすべてロールバックする',async()=>{
 const admin=await makeUser(true),owner=await makeUser(),p=await project(owner);await credential(owner.user);
 const calls=await Promise.all([req(`/api/admin/users/${owner.user}/terminate`,{},admin.cookie),req(`/api/admin/users/${owner.user}/terminate`,{},admin.cookie)]);expect(calls.map(r=>r.status).sort()).toEqual([200,409]);
 expect(await s.sql("SELECT count(*) AS n FROM audit_events WHERE target_id=? AND event_type='USER_TERMINATED'",owner.user).first()).toEqual({n:1});
 const failed=await makeUser(),otherProject=await project(failed);await credential(failed.user);const key=await apiKey(failed),before=await rows('audit_events');
 await env.DB.exec("CREATE TRIGGER test_termination_failure BEFORE UPDATE OF revoked_at ON api_keys BEGIN SELECT RAISE(ABORT,'test failure'); END;");
 expect((await req(`/api/admin/users/${failed.user}/terminate`,{},admin.cookie)).status).toBe(500);
 await env.DB.exec('DROP TRIGGER test_termination_failure;');
 expect(await s.sql('SELECT status,terminated_at FROM users WHERE id=?',failed.user).first()).toEqual({status:'ACTIVE',terminated_at:null});expect((await req('/api/projects',undefined,failed.cookie)).status).toBe(200);expect(await s.sql('SELECT archived_at FROM projects WHERE id=?',otherProject.id).first()).toEqual({archived_at:null});expect(await s.sql('SELECT revoked_at FROM api_keys WHERE key_id=?',key.key_id).first()).toEqual({revoked_at:null});expect(await rows('audit_events')).toEqual(before);
});
it('残存Session・未失効API Keyでも利用者状態を確認し、再発行・初期設定・再開を禁止する',async()=>{
 const admin=await makeUser(true),owner=await makeUser(),key=await apiKey(owner);await credential(owner.user);expect((await req(`/api/admin/users/${owner.user}/terminate`,{},admin.cookie)).status).toBe(200);
 await expect(s.sql('INSERT INTO sessions VALUES(?,?,?)',await sha256(randomToken()),owner.user,new Date(Date.now()+60000).toISOString()).run()).rejects.toThrow();
 await expect(credential(owner.user)).rejects.toThrow();await expect(s.sql("UPDATE users SET status='ACTIVE' WHERE id=?",owner.user).run()).rejects.toThrow();
 // Simulate a legacy residual session; production issuance guard normally prevents this.
 await env.DB.exec('DROP TRIGGER session_active_user;');const token=randomToken();await s.sql('INSERT INTO sessions VALUES(?,?,?)',await sha256(token),owner.user,new Date(Date.now()+60000).toISOString()).run();
 expect((await req('/api/projects',undefined,`punka_session=${token}`)).status).toBe(403);expect(await (await req('/api/auth/session',undefined,`punka_session=${token}`)).json()).toEqual({authenticated:false});
 await s.sql('UPDATE api_keys SET revoked_at=NULL WHERE key_id=?',key.key_id).run();expect((await req('/api/v1/projects',undefined,undefined,key.key)).status).toBe(401);
 const setup=await worker.fetch(new Request(bindings.APP_ORIGIN+'/api/auth/owner-session',{method:'POST',headers:{Origin:bindings.APP_ORIGIN,Authorization:'Bearer test-operator'},body:JSON.stringify({user_id:owner.user})}),bindings);expect(setup.status).toBe(403);
});
