import {env,applyD1Migrations} from 'cloudflare:test';
import {beforeAll,it,expect} from 'vitest';
import worker from '../src/index';
import {id,now,sha256} from '../src/domain';
import {type Bindings} from '../src/store';
const bindings={...env,APP_ORIGIN:'http://localhost:8787',RP_ID:'localhost',SIGNUP_ENABLED:'true'} as Bindings;
const users=Object.fromEntries(['OWNER','MANAGER','CREATOR','REVIEWER','VIEWER','NEW','RETURNING'].map(role=>[role,id()]));let project:string,asset:string,version:string,proof:string;
async function req(path:string,body?:unknown,role='OWNER'){return worker.fetch(new Request(bindings.APP_ORIGIN+path,{method:body===undefined?'GET':'POST',headers:{Origin:bindings.APP_ORIGIN,Cookie:`punka_session=${users[role]}`},...(body===undefined?{}:{body:JSON.stringify(body)})}),bindings);}
async function invite(email=`creator-${id()}@example.com`){const r=await req(`/api/projects/${project}/invites`,{email,role:'CREATOR'});expect(r.status).toBe(201);return await r.json() as any;}
beforeAll(async()=>{
 await applyD1Migrations(env.DB,(env as unknown as {TEST_MIGRATIONS:Parameters<typeof applyD1Migrations>[1]}).TEST_MIGRATIONS);
 for(const user of Object.values(users)){await env.DB.prepare('INSERT INTO users(id,display_name,created_at) VALUES(?,?,?)').bind(user,'Punka',now()).run();await env.DB.prepare('INSERT INTO sessions VALUES(?,?,?)').bind(await sha256(user),user,new Date(Date.now()+3600000).toISOString()).run();}
 project=(await (await req('/api/projects',{name:'Invite and breadcrumbs'})).json() as any).id;
 for(const role of ['MANAGER','CREATOR','REVIEWER','VIEWER'])await env.DB.prepare('INSERT INTO project_members(id,project_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)').bind(id(),project,users[role],role,'ACTIVE',now()).run();
 const a=await (await req(`/api/projects/${project}/assets`,{filename:'old.wav',size:1,sha256:'d'.repeat(64),status:'SUBMITTED'})).json() as any;asset=a.id;version=a.version_id;proof=a.proof_id;
 for(const role of ['NEW','RETURNING'])await env.DB.prepare('INSERT INTO webauthn_credentials(id,recipient_id,public_key,counter,transports_json,created_at) VALUES(?,?,?,?,?,?)').bind(role+'-key',users[role],'test-key',0,'[]',now()).run();
});
it('Proofから所属Versionを特定し、単独Versionをページ位置に関係なく取得する',async()=>{
 const p=await (await req(`/api/proofs/${proof}`)).json() as any;expect(p).toMatchObject({asset_version_id:version,asset_id:asset,project_id:project,version:1});
 expect((await req(`/api/assets/${asset}/versions/${version}`)).status).toBe(200);expect((await req(`/api/assets/${asset}/versions/${version}`,undefined,'NEW')).status).toBe(404);
 expect((await req(`/api/assets/${asset}/versions/${id()}`)).status).toBe(404);
 const p2=(await (await req('/api/projects',{name:'Other'})).json() as any).id,a2=(await (await req(`/api/projects/${p2}/assets`,{filename:'other',size:1,sha256:'e'.repeat(64)})).json() as any).id;expect((await req(`/api/assets/${a2}/versions/${version}`)).status).toBe(404);
});
it.each(['CREATOR','REVIEWER','VIEWER'])('%sは招待作成・一覧・取消APIを403で拒否する',async role=>{
 expect((await req(`/api/projects/${project}/invites`,{email:'x@example.com',role:'VIEWER'},role)).status).toBe(403);
 expect((await req(`/api/projects/${project}/invites`,undefined,role)).status).toBe(403);
 expect((await req(`/api/projects/${project}/invites/${id()}/revoke`,{},role)).status).toBe(403);
});
it('招待結果は詳細を返し一覧は秘密tokenを返さない、OWNER追加不可',async()=>{
 const i=await invite();expect(i).toMatchObject({email:i.email,role:'CREATOR',status:'PENDING'});expect(i.id).toEqual(expect.any(String));expect(i.url).toMatch(/^http:\/\/localhost:8787\/invite\/[a-f0-9]{64}$/);expect(i.created_at).toBeTruthy();const token=i.url.split('/').at(-1);expect(token).toHaveLength(64);
 const stored=await env.DB.prepare('SELECT token_hash FROM project_invites WHERE id=?').bind(i.id).first<any>();expect(stored.token_hash).toBe(await sha256(token));
 const list=await (await req(`/api/projects/${project}/invites`)).json() as any[];expect(list.find(x=>x.id===i.id).status).toBe('PENDING');expect(JSON.stringify(list)).not.toContain(token);expect(JSON.stringify(list)).not.toContain(stored.token_hash);
 expect((await req(`/api/projects/${project}/invites`,{email:'x@example.com',role:'OWNER'})).status).toBe(400);
 expect((await req(`/api/projects/${project}/invites`,{email:'manager@example.com',role:'REVIEWER'},'MANAGER')).status).toBe(201);
});
it('内容確認後に参加しメンバー追加とACCEPTEDを一括確定、再利用不可',async()=>{
 const i=await invite(),token=i.url.split('/').at(-1);const preview=await req('/api/project-invites/preview',{token},'NEW');expect(preview.status).toBe(200);expect(await preview.json()).toMatchObject({project_name:'Invite and breadcrumbs',email:i.email,role:'CREATOR',status:'PENDING'});
 expect((await req('/api/project-invites/accept',{token},'NEW')).status).toBe(200);expect((await req('/api/project-invites/accept',{token},'RETURNING')).status).toBe(400);
 const members=await (await req(`/api/projects/${project}/members`)).json() as any[];expect(members.find(m=>m.user_id===users.NEW)).toMatchObject({role:'CREATOR',status:'ACTIVE',joined_at:expect.any(String)});
 const list=await (await req(`/api/projects/${project}/invites`)).json() as any[];expect(list.find(x=>x.id===i.id).status).toBe('ACCEPTED');
});
it('失効・取消を表示し受諾不可、既存メンバーのroleを上書きしない',async()=>{
 const expired=await invite();await env.DB.prepare('UPDATE project_invites SET expires_at=? WHERE id=?').bind('2000-01-01',expired.id).run();expect((await req('/api/project-invites/accept',{token:expired.url.split('/').at(-1)},'RETURNING')).status).toBe(410);
 const revoked=await invite();expect((await req(`/api/projects/${project}/invites/${revoked.id}/revoke`,{})).status).toBe(200);expect((await req('/api/project-invites/accept',{token:revoked.url.split('/').at(-1)},'RETURNING')).status).toBe(400);
 const same=await invite();expect((await req('/api/project-invites/accept',{token:same.url.split('/').at(-1)})).status).toBe(409);expect((await env.DB.prepare('SELECT role FROM project_members WHERE project_id=? AND user_id=?').bind(project,users.OWNER).first<any>())!.role).toBe('OWNER');
 const list=await (await req(`/api/projects/${project}/invites`)).json() as any[];expect(list.find(i=>i.id===expired.id).status).toBe('EXPIRED');expect(list.find(i=>i.id===revoked.id).status).toBe('REVOKED');expect(list.find(i=>i.id===same.id).status).toBe('PENDING');
});
it('無効化された旧メンバーは新しい招待で復帰可能',async()=>{
 await env.DB.prepare('INSERT INTO project_members(id,project_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)').bind(id(),project,users.RETURNING,'VIEWER','REVOKED',now()).run();const i=await invite();expect((await req('/api/project-invites/accept',{token:i.url.split('/').at(-1)},'RETURNING')).status).toBe(200);expect(await env.DB.prepare('SELECT role,status FROM project_members WHERE project_id=? AND user_id=?').bind(project,users.RETURNING).first()).toEqual({role:'CREATOR',status:'ACTIVE'});
});

it('同じメールの大文字小文字・前後空白をDB制約でも重複拒否し、期限切れ後は再招待可能',async()=>{
 const i=await invite('duplicate@example.com');const response=await req(`/api/projects/${project}/invites`,{email:'DUPLICATE@example.com',role:'VIEWER'});expect(response.status).toBe(409);expect(await response.json()).toMatchObject({error:'このメールアドレスには既に招待を送っています'});
 await expect(env.DB.prepare('INSERT INTO project_invites(id,project_id,token_hash,email,role,created_by,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(id(),project,await sha256('another-token'),' duplicate@example.com ','VIEWER',users.OWNER,new Date(Date.now()+86400000).toISOString(),now()).run()).rejects.toThrow('duplicate pending invitation');
 expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM project_invites WHERE project_id=? AND email='duplicate@example.com'").bind(project).first<any>())!.n).toBe(1);
 await env.DB.prepare('UPDATE project_invites SET expires_at=? WHERE id=?').bind('2000-01-01',i.id).run();await invite('duplicate@example.com');await req(`/api/projects/${project}/invites`);await req(`/api/projects/${project}/invites`);
 expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type='INVITE_EXPIRED' AND target_id=?").bind(i.id).first<any>())!.n).toBe(1);
});
it('同時招待は1件のみ作成し、監査ログはtokenを保存しない',async()=>{
 const responses=await Promise.all([req(`/api/projects/${project}/invites`,{email:'race@example.com',role:'CREATOR'}),req(`/api/projects/${project}/invites`,{email:'race@example.com',role:'CREATOR'})]);expect(responses.map(r=>r.status).sort()).toEqual([201,409]);
 const i=await responses.find(r=>r.status===201)!.json() as any;await req(`/api/projects/${project}/invites/${i.id}/revoke`,{});const events=(await env.DB.prepare('SELECT event_type,metadata_json FROM audit_events WHERE target_id=?').bind(i.id).all()).results;
 expect(events.map(e=>e.event_type)).toEqual(['MEMBER_INVITED','INVITE_REVOKED']);expect(JSON.stringify(events)).not.toContain(i.url.split('/').at(-1));
});
it('ログイン前もtokenで案件・Role・招待先を確認でき、受諾は未認証401',async()=>{
 const i=await invite(),body={token:i.url.split('/').at(-1)};
 const preview=await req('/api/project-invites/preview',body,'ANONYMOUS');expect(preview.status).toBe(200);expect(await preview.json()).toMatchObject({project_name:'Invite and breadcrumbs',email:i.email,role:'CREATOR'});expect((await req('/api/project-invites/accept',body,'ANONYMOUS')).status).toBe(401);
});

it('招待専用登録は期限切れ・取消・不正tokenを拒否し、project_nameやroleを受け付けない',async()=>{
 const expired=await invite();await env.DB.prepare('UPDATE project_invites SET expires_at=? WHERE id=?').bind('2000-01-01',expired.id).run();expect((await req('/api/auth/invite-signup',{name:'Rahab',token:expired.url.split('/').at(-1)},'ANONYMOUS')).status).toBe(410);
 const revoked=await invite();await req(`/api/projects/${project}/invites/${revoked.id}/revoke`,{});expect((await req('/api/auth/invite-signup',{name:'Rahab',token:revoked.url.split('/').at(-1)},'ANONYMOUS')).status).toBe(400);
 expect((await req('/api/auth/invite-signup',{name:'Rahab',token:'invalid'.repeat(8)},'ANONYMOUS')).status).toBe(400);
 const valid=await invite();expect((await req('/api/auth/invite-signup',{name:'Rahab',token:valid.url.split('/').at(-1),project_name:'Unexpected',role:'OWNER'},'ANONYMOUS')).status).toBe(400);
});
