import {env,applyD1Migrations} from 'cloudflare:test';
import {beforeAll,it,expect,vi,afterEach} from 'vitest';
import worker from '../src/index';
import {id,now,sha256} from '../src/domain';
import {type Bindings} from '../src/store';
const bindings={...env,APP_ORIGIN:'http://localhost:8787',RP_ID:'localhost',SIGNUP_ENABLED:'true'} as Bindings;
const roles=['OWNER','MANAGER','CREATOR','REVIEWER','VIEWER'] as const;
const users=Object.fromEntries([...roles,'NEW'].map(role=>[role,id()]));let project:string,asset:string,version:string,proof:string,delivery:string;
const members:Record<string,string>={};
async function req(path:string,body?:unknown,role='OWNER',origin=bindings.APP_ORIGIN){return worker.fetch(new Request(bindings.APP_ORIGIN+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,Cookie:`punka_session=${users[role]}`,'CF-Connecting-IP':'member-management-tests'},...(body===undefined?{}:{body:JSON.stringify(body)})}),bindings);}
const remove=(role:string,actor='OWNER')=>req(`/api/projects/${project}/members/${members[role]}/remove`,{},actor);
async function snapshot(){return Promise.all(['asset_versions','asset_version_states','asset_version_state_history','approvals','deliveries','delivery_history','proofs'].map(async table=>({table,rows:(await env.DB.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results})));}
beforeAll(async()=>{
 await applyD1Migrations(env.DB,(env as unknown as {TEST_MIGRATIONS:Parameters<typeof applyD1Migrations>[1]}).TEST_MIGRATIONS);
 for(const [role,user] of Object.entries(users)){await env.DB.prepare('INSERT INTO users(id,display_name,email,created_at) VALUES(?,?,?,?)').bind(user,role==='CREATOR'?'Rahab':role,`${role.toLowerCase()}@example.com`,now()).run();await env.DB.prepare('INSERT INTO sessions VALUES(?,?,?)').bind(await sha256(user),user,new Date(Date.now()+86400000).toISOString()).run();await env.DB.prepare('INSERT INTO webauthn_credentials(id,recipient_id,public_key,counter,transports_json,created_at) VALUES(?,?,?,?,?,?)').bind(id(),user,'test-key',0,'[]',now()).run();}
 project=(await (await req('/api/projects',{name:"Rahab's mission"})).json() as any).id;
 for(const role of roles.filter(r=>r!=='OWNER'))await env.DB.prepare('INSERT INTO project_members(id,project_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)').bind(id(),project,users[role],role,'ACTIVE',now()).run();
 for(const m of await (await req(`/api/projects/${project}/members`)).json() as any[])members[roles.find(r=>users[r]===m.user_id)!]=m.id;
 const a=await (await req(`/api/projects/${project}/assets`,{filename:'song.wav',sha256:'1'.repeat(64),size:3,status:'SUBMITTED'},'CREATOR')).json() as any;asset=a.id;version=a.version_id;proof=a.proof_id;
 expect((await req(`/api/asset-versions/${version}/approve`,{reason:'Verified'},'OWNER')).status).toBe(200);vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('offline'));expect((await req(`/api/asset-versions/${version}/finalize`,{})).status).toBe(200);vi.restoreAllMocks();delivery=(await (await req(`/api/asset-versions/${version}/deliveries`,{recipient_user_id:users.CREATOR,comment:'TEST'})).json() as any).id;
});
afterEach(()=>vi.restoreAllMocks());
it.each(['MANAGER','CREATOR','REVIEWER','VIEWER'])('%sは取消403、OWNER自身も409、他案件member_idとCSRFを拒否',async role=>{
 expect((await remove('CREATOR',role)).status).toBe(403);
 expect((await remove('OWNER')).status).toBe(409);
 const other=(await (await req('/api/projects',{name:'Other project'})).json() as any).id;
 expect((await req(`/api/projects/${other}/members/${members.CREATOR}/remove`,{})).status).toBe(404);
 expect((await req(`/api/projects/${project}/members/${members.CREATOR}/remove`,{},'OWNER','https://evil.example')).status).toBe(403);
});
it('OWNERがCREATOR・REVIEWERを取り消し、全制作・承認・納品・証跡・監査を保持する',async()=>{
 const before=await snapshot(),oldAudit=(await env.DB.prepare('SELECT * FROM audit_events ORDER BY id').all()).results;
 for(const role of ['CREATOR','REVIEWER']){const r=await remove(role);expect(r.status).toBe(200);expect(await r.json()).toMatchObject({status:'REMOVED',removed_by:users.OWNER,removed_at:expect.any(String)});expect((await remove(role)).status).toBe(409);}
 expect(await snapshot()).toEqual(before);const afterAudit=(await env.DB.prepare('SELECT * FROM audit_events ORDER BY id').all()).results;for(const event of oldAudit)expect(afterAudit).toContainEqual(event);
 const removed=afterAudit.filter(e=>e.event_type==='MEMBER_REMOVED');expect(removed).toHaveLength(2);expect(JSON.parse(String(removed[0].metadata_json))).toMatchObject({project_id:project,member_user_id:users.CREATOR,removed_by:users.OWNER,role:'CREATOR',timestamp:expect.any(String)});
 await expect(env.DB.prepare('DELETE FROM project_members WHERE id=?').bind(members.CREATOR).run()).rejects.toThrow('membership is permanent');
});
it('取消後は既存session/API keyでも全案件操作403、別案件の利用は維持',async()=>{
 const calls:[string,unknown?][]=[
 [`/api/projects/${project}`],[`/api/projects/${project}/members`],[`/api/assets/${asset}`],[`/api/assets/${asset}/versions/${version}`],[`/api/assets/${asset}/versions`,{filename:'v2',sha256:'2'.repeat(64),size:3}],
 [`/api/asset-versions/${version}/submit`,{}],[`/api/asset-versions/${version}/approve`,{}],[`/api/asset-versions/${version}/deliveries`,{recipient_user_id:users.OWNER}],[`/api/deliveries/${delivery}/receive`,{}],[`/api/proofs/${proof}`],[`/api/proofs/${proof}/ots`],[`/api/projects/${project}/bot-reviews`,{assetVersionId:version}],[`/api/projects/${project}/bot-reviews?assetVersionId=${version}`]
 ];for(const [path,body] of calls)expect((await req(path,body,'CREATOR')).status,path).toBe(403);
 expect((await req(`/api/asset-versions/${version}/approve`,{},'REVIEWER')).status).toBe(403);
 const key='ct_removed-test-key';await env.DB.prepare('INSERT INTO api_keys(key_id,key_hash,user_id,project_id,name,scopes,created_at) VALUES(?,?,?,?,?,?,?)').bind(id(),await sha256(key),users.CREATOR,project,'Test','["projects:read"]',now()).run();const api=await worker.fetch(new Request(`${bindings.APP_ORIGIN}/api/v1/projects/${project}`,{headers:{Authorization:`Bearer ${key}`}}),bindings);expect(api.status).toBe(403);
 expect((await req('/api/auth/session',undefined,'CREATOR')).status).toBe(200);expect((await req('/api/projects',{name:'Own other project'},'CREATOR')).status).toBe(201);
});
it('再招待で同じmembershipをACTIVEへ戻し、以前の取消日時・取消者と監査を保持',async()=>{
 const invitation=await (await req(`/api/projects/${project}/invites`,{email:'creator@example.com',role:'CREATOR'})).json() as any;
 const joined=await req('/api/project-invites/accept',{token:invitation.url.split('/').at(-1),display_name:'  Rahab  '},'CREATOR');expect(joined.status).toBe(200);expect(await joined.json()).toMatchObject({display_name:'Rahab',role:'CREATOR'});
 const list=await (await req(`/api/projects/${project}/members`)).json() as any[],member=list.find(m=>m.user_id===users.CREATOR);expect(member.id).toBe(members.CREATOR);expect(member.status).toBe('ACTIVE');expect(member.history.find((h:any)=>h.status==='REMOVED')).toMatchObject({removed_at:expect.any(String),removed_by:users.OWNER});
 const log=await (await req(`/api/projects/${project}/audit`)).json() as any[];expect(log.some(e=>e.event_type==='MEMBER_REINVITED')).toBe(true);expect(log.some(e=>e.event_type==='MEMBER_JOINED'&&e.target_id===invitation.id)).toBe(true);
 await expect(env.DB.prepare('DELETE FROM project_member_history WHERE member_id=?').bind(member.id).run()).rejects.toThrow();
});
it('表示名は必須・trim・最大50、同名許可、受諾失敗時は既存表示名を変更しない',async()=>{
 const invitation=await (await req(`/api/projects/${project}/invites`,{email:'new@example.com',role:'VIEWER'})).json() as any,token=invitation.url.split('/').at(-1);
 for(const name of ['', '   ', 'x'.repeat(51)]){expect((await req('/api/auth/invite-signup',{token,name},'NEW')).status).toBe(400);expect((await req('/api/project-invites/accept',{token,display_name:name},'NEW')).status).toBe(400);}
 const accepted=await req('/api/project-invites/accept',{token,display_name:'  Rahab  '},'NEW');expect(accepted.status).toBe(200);expect(await env.DB.prepare('SELECT display_name FROM users WHERE id=?').bind(users.NEW).first()).toEqual({display_name:'Rahab'});
 expect((await req('/api/project-invites/accept',{token,display_name:'Changed'},'NEW')).status).toBe(400);expect(await env.DB.prepare('SELECT display_name FROM users WHERE id=?').bind(users.NEW).first()).toEqual({display_name:'Rahab'});
});

it.each(['MANAGER','VIEWER'])('OWNERは%sも取り消せる',async role=>{expect((await remove(role)).status).toBe(200);expect((await req(`/api/projects/${project}`,undefined,role)).status).toBe(403);});
it('再招待の監査と権限はメールや表示名ではなく本人user_idで確定する',async()=>{
 expect((await remove('CREATOR')).status).toBe(200);
 const invitation=await (await req(`/api/projects/${project}/invites`,{email:'different-invitation@example.com',role:'REVIEWER'})).json() as any;
 expect((await req('/api/project-invites/accept',{token:invitation.url.split('/').at(-1)},'CREATOR')).status).toBe(200);
 const event=await env.DB.prepare("SELECT metadata_json FROM audit_events WHERE event_type='MEMBER_REINVITED' AND target_id=?").bind(invitation.id).first<any>();expect(JSON.parse(event.metadata_json)).toEqual({member_user_id:users.CREATOR,role:'REVIEWER'});
});
