import {env,applyD1Migrations} from 'cloudflare:test';
import {beforeAll,it,expect,vi,afterEach} from 'vitest';
import worker from '../src/index';
import {id,now,sha256} from '../src/domain';
import {type Bindings} from '../src/store';
const bindings={...env,APP_ORIGIN:'http://localhost:8787',RP_ID:'localhost'} as Bindings;
const users=Object.fromEntries(['OWNER','MANAGER','CREATOR','REVIEWER','VIEWER','APPROVER','OTHER'].map(role=>[role,id()]));
const members:Record<string,string>={};let project:string,asset:string,v1:string,v2:string;
async function req(path:string,body?:unknown,role='OWNER',origin=bindings.APP_ORIGIN){return worker.fetch(new Request(bindings.APP_ORIGIN+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,...(role==='ANON'?{}:{Cookie:`punka_session=${users[role]}`})},...(body===undefined?{}:{body:JSON.stringify(body)})}),bindings);}
async function makeAsset(){const r=await req(`/api/projects/${project}/assets`,{filename:'review.wav',size:4,sha256:'7'.repeat(64),status:'SUBMITTED'},'CREATOR');expect(r.status).toBe(201);return await r.json() as any;}
beforeAll(async()=>{
 await applyD1Migrations(env.DB,(env as unknown as {TEST_MIGRATIONS:Parameters<typeof applyD1Migrations>[1]}).TEST_MIGRATIONS);
 for(const [role,user] of Object.entries(users)){await env.DB.prepare('INSERT INTO users(id,display_name,created_at) VALUES(?,?,?)').bind(user,role==='REVIEWER'?'Rahab':role,now()).run();await env.DB.prepare('INSERT INTO sessions VALUES(?,?,?)').bind(await sha256(user),user,new Date(Date.now()+86400000).toISOString()).run();}
 project=(await (await req('/api/projects',{name:'Reviewer project'})).json() as any).id;
 for(const role of ['MANAGER','CREATOR','REVIEWER','VIEWER','APPROVER']){members[role]=id();await env.DB.prepare('INSERT INTO project_members(id,project_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)').bind(members[role],project,users[role],role==='APPROVER'?'VIEWER':role,'ACTIVE',now()).run();}
 await env.DB.prepare('INSERT INTO project_approvers(id,project_id,user_id,granted_by,created_at) VALUES(?,?,?,?,?)').bind(id(),project,users.APPROVER,users.OWNER,now()).run();const a=await makeAsset();asset=a.id;v1=a.version_id;
});
afterEach(()=>vi.restoreAllMocks());
it('Reviewerコメントをtrimして保存し、v2でもv1・v2を時系列表示、承認とは別証跡',async()=>{
 expect((await req(`/api/assets/${asset}/review-comments`,{version_id:v1,comment:' 歌詞部分の表記を確認してください '},'REVIEWER')).status).toBe(201);
 const r=await req(`/api/assets/${asset}/versions`,{filename:'review-v2.wav',size:5,sha256:'8'.repeat(64),status:'SUBMITTED'},'CREATOR');expect(r.status).toBe(201);v2=(await r.json() as any).id;
 expect((await req(`/api/assets/${asset}/review-comments`,{version_id:v2,comment:'修正版を確認しました'},'REVIEWER')).status).toBe(201);
 for(const role of ['OWNER','APPROVER','CREATOR','REVIEWER','VIEWER']){const rows=await (await req(`/api/assets/${asset}/review-comments`,undefined,role)).json() as any[];expect(rows.map(c=>[c.version,c.comment,c.reviewer_name])).toEqual([[1,'歌詞部分の表記を確認してください','Rahab'],[2,'修正版を確認しました','Rahab']]);expect(rows[0]).toMatchObject({artifact_id:asset,version_id:v1,reviewer_id:users.REVIEWER});}
 expect((await env.DB.prepare('SELECT * FROM approvals WHERE asset_version_id IN (?,?)').bind(v1,v2).all()).results).toHaveLength(0);
 const log=(await env.DB.prepare("SELECT * FROM audit_events WHERE event_type='REVIEW_COMMENT_ADDED'").all()).results;expect(log).toHaveLength(2);expect(JSON.parse(String(log[0].metadata_json))).toMatchObject({artifact_id:asset,version_id:v1});
 await env.DB.prepare('UPDATE users SET display_name=? WHERE id=?').bind('Changed name',users.REVIEWER).run();expect((await (await req(`/api/assets/${asset}/review-comments`)).json() as any[])[0].reviewer_name).toBe('Rahab');
 await expect(env.DB.prepare('UPDATE review_comments SET comment=?').bind('tamper').run()).rejects.toThrow();await expect(env.DB.prepare('DELETE FROM review_comments').run()).rejects.toThrow();
});
it.each(['finalize'])('Reviewerの%s APIは403で状態不変',async action=>{expect((await req(`/api/asset-versions/${v2}/${action}`,{reason:'forbidden'},'REVIEWER')).status).toBe(403);expect((await env.DB.prepare('SELECT status FROM asset_version_states WHERE asset_version_id=?').bind(v2).first<any>()).status).toBe('SUBMITTED');});
it.each(['OWNER','MANAGER','REVIEWER'])('%sは承認・差戻しが可能、FINALはOWNERだけ',async role=>{const a=await makeAsset(),b=await makeAsset();expect((await req(`/api/asset-versions/${a.version_id}/approve`,{reason:'確認済み'},role)).status).toBe(200);vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('offline'));expect((await req(`/api/asset-versions/${a.version_id}/finalize`,{},role)).status).toBe(role==='OWNER'?200:403);expect((await req(`/api/asset-versions/${b.version_id}/reject`,{reason:'修正お願いします'},role)).status).toBe(200);const rows=(await env.DB.prepare('SELECT * FROM approvals WHERE approver_id=?').bind(users[role]).all()).results;expect(rows.map(r=>r.status)).toContain('APPROVED');expect(rows.map(r=>r.status)).toContain('REJECTED');});
it('CREATOR・VIEWERには最終判断を許可しない',async()=>{for(const role of ['CREATOR','VIEWER'])for(const action of ['approve','reject','finalize'])expect((await req(`/api/asset-versions/${v2}/${action}`,{},role)).status).toBe(403);});
it('コメントの認証・所属・入力・Version整合性・CSRFを検証する',async()=>{
 const path=`/api/assets/${asset}/review-comments`;expect((await req(path,undefined,'ANON')).status).toBe(401);expect((await req(path,undefined,'OTHER')).status).toBe(404);
 for(const role of ['OWNER','MANAGER','CREATOR','VIEWER','APPROVER'])expect((await req(path,{version_id:v1,comment:'x'},role)).status).toBe(403);
 for(const comment of ['', '  ','x'.repeat(4001)])expect((await req(path,{version_id:v1,comment},'REVIEWER')).status).toBe(400);
 const other=await makeAsset();expect((await req(path,{version_id:other.version_id,comment:'wrong asset'},'REVIEWER')).status).toBe(400);
 expect((await req(path,{version_id:v1,comment:'csrf'},'REVIEWER','https://evil.example')).status).toBe(403);
});
it('旧承認担当設定APIは終了し、VIEWERの個別付与履歴は権限に使わない',async()=>{
 for(const role of ['MANAGER','CREATOR','REVIEWER','VIEWER','APPROVER'])expect((await req(`/api/projects/${project}/members/${members.VIEWER}/approver`,{enabled:true},role)).status).toBe(403);
 expect((await req(`/api/projects/${project}/members/${members.VIEWER}/approver`,{enabled:true})).status).toBe(410);
 const session=await (await req('/api/auth/session',undefined,'APPROVER')).json() as any;expect(session.memberships[0].role).toBe('VIEWER');expect((await req(`/api/asset-versions/${v2}/approve`,{},'APPROVER')).status).toBe(403);expect((await env.DB.prepare('SELECT * FROM project_approvers').all()).results).toHaveLength(1);
});
it('メンバー取消後コメント403・閲覧403、過去コメントは残り、再招待時に承認担当は自動復活しない',async()=>{
 expect((await req(`/api/projects/${project}/members/${members.REVIEWER}/remove`,{})).status).toBe(200);expect((await req(`/api/assets/${asset}/review-comments`,{version_id:v1,comment:'x'},'REVIEWER')).status).toBe(403);expect((await req(`/api/assets/${asset}/review-comments`,undefined,'REVIEWER')).status).toBe(403);
 expect((await (await req(`/api/assets/${asset}/review-comments`)).json() as any[]).every(c=>c.reviewer_removed===1)).toBe(true);
 expect((await req(`/api/projects/${project}/members/${members.APPROVER}/remove`,{})).status).toBe(200);expect((await env.DB.prepare('SELECT revoked_at FROM project_approvers WHERE project_id=? AND user_id=? ORDER BY created_at DESC').bind(project,users.APPROVER).first<any>()).revoked_at).toBeTruthy();await env.DB.prepare('INSERT INTO webauthn_credentials(id,recipient_id,public_key,counter,transports_json,created_at) VALUES(?,?,?,?,?,?)').bind(id(),users.APPROVER,'test-key',0,'[]',now()).run();const invite=await (await req(`/api/projects/${project}/invites`,{email:'reinvited-approver@example.com',role:'VIEWER'})).json() as any;const token=invite.url.split('/').pop();expect((await req('/api/project-invites/accept',{token,display_name:'Returning approver'},'APPROVER')).status).toBe(200);expect((await req(`/api/asset-versions/${v2}/approve`,{},'APPROVER')).status).toBe(403);const session=await (await req('/api/auth/session',undefined,'APPROVER')).json() as any;expect(session.memberships[0].role).toBe('VIEWER');
});
