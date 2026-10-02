import {env,applyD1Migrations} from 'cloudflare:test';
import {beforeAll,it,expect} from 'vitest';
import worker from '../src/index';
import {id,now,sha256} from '../src/domain';
import {type Bindings} from '../src/store';
const bindings={...env,APP_ORIGIN:'http://localhost:8787',RP_ID:'localhost',SIGNUP_ENABLED:'true'} as Bindings;
const admin=id(),users=Object.fromEntries(['OWNER','MANAGER','CREATOR','REVIEWER','VIEWER'].map(role=>[role,id()]));
const content={name:'問い合わせ者',company:'制作会社',email:'contact@example.com',team_size:'5人',current_tools:'Drive / Discord',problem:'納品履歴の管理',message:'導入を相談したい'};
async function req(path:string,method='GET',body?:unknown,user:string|null=admin,origin=bindings.APP_ORIGIN){return worker.fetch(new Request(bindings.APP_ORIGIN+path,{method,headers:{Origin:origin,...(user?{Cookie:`punka_session=${user}`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})}),bindings);}
beforeAll(async()=>{
 await applyD1Migrations(env.DB,(env as unknown as {TEST_MIGRATIONS:Parameters<typeof applyD1Migrations>[1]}).TEST_MIGRATIONS);
 for(const user of [admin,...Object.values(users)]){await env.DB.prepare('INSERT INTO users(id,display_name,created_at) VALUES(?,?,?)').bind(user,'Punka',now()).run();await env.DB.prepare('INSERT INTO sessions VALUES(?,?,?)').bind(await sha256(user),user,new Date(Date.now()+3600000).toISOString()).run();}
 await env.DB.prepare('INSERT INTO site_admins VALUES(?,?)').bind(admin,now()).run();
 const project=(await (await req('/api/projects','POST',{name:'Role boundary'},users.OWNER)).json() as any).id;
 for(const role of ['MANAGER','CREATOR','REVIEWER','VIEWER'])await env.DB.prepare('INSERT INTO project_members(id,project_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)').bind(id(),project,users[role],role,'ACTIVE',now()).run();
});
it('匿名問い合わせ登録と管理者一覧・詳細、ステータス変更後も受付内容を保持する',async()=>{
 const created=await req('/api/business/inquiries','POST',content,null);expect(created.status).toBe(201);const inquiry=(await created.json() as any).id;
 const detail=await req(`/api/admin/inquiries/${inquiry}`);expect(detail.status).toBe(200);const original=await detail.json() as any;expect(original).toMatchObject({...content,status:'NEW',archived_at:null});
 const list=await req('/api/admin/inquiries');expect(list.status).toBe(200);expect(await list.json()).toEqual([expect.objectContaining({id:inquiry,status:'NEW',name:content.name})]);
 for(const status of ['IN_PROGRESS','COMPLETED']){const changed=await req(`/api/admin/inquiries/${inquiry}/status`,'PATCH',{status});expect(changed.status).toBe(200);expect(await (await req(`/api/admin/inquiries/${inquiry}`)).json()).toEqual({...original,status});}
 const tampered=await req(`/api/admin/inquiries/${inquiry}/status`,'PATCH',{status:'NEW',message:'書き換え'});expect(tampered.status).toBe(400);
 for(const column of ['id','name','company','email','team_size','current_tools','problem','message','created_at'])await expect(env.DB.prepare(`UPDATE business_inquiries SET ${column}=? WHERE id=?`).bind('tampered',inquiry).run()).rejects.toThrow();
 await expect(env.DB.prepare('DELETE FROM business_inquiries WHERE id=?').bind(inquiry).run()).rejects.toThrow();
 await expect(env.DB.prepare("UPDATE business_inquiries SET status='INVALID' WHERE id=?").bind(inquiry).run()).rejects.toThrow();
 expect(await (await req(`/api/admin/inquiries/${inquiry}`)).json()).toEqual({...original,status:'COMPLETED'});
});
it('同名Punkaや全案件役割でも管理権限がなければ全管理APIを403にする',async()=>{
 for(const user of Object.values(users))for(const [path,method,body] of [['/api/admin/access','GET',undefined],['/api/admin/inquiries','GET',undefined],[`/api/admin/inquiries/${id()}`,'GET',undefined],[`/api/admin/inquiries/${id()}/status`,'PATCH',{status:'COMPLETED'}]] as const)expect((await req(path,method,body,user)).status).toBe(403);
 expect((await req('/api/admin/inquiries','GET',undefined,null)).status).toBe(401);
 const signup=await req('/api/auth/signup','POST',{name:'Punka',project_name:'Self service',is_admin:true},null);expect(signup.status).toBe(410);
});
it('NEW優先・受付日時降順、アーカイブ除外、PATCHのOriginと入力を検証する',async()=>{
 const records=[['old-new','NEW','2026-01-01'],['recent-done','COMPLETED','2026-10-01'],['recent-new','NEW','2026-09-01'],['archived','NEW','2026-10-02']];
 for(const [key,status,date]of records)await env.DB.prepare('INSERT INTO business_inquiries(id,name,company,email,team_size,current_tools,problem,message,created_at,status,archived_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(key,...Object.values(content),date,status,key==='archived'?now():null).run();
 const list=await (await req('/api/admin/inquiries')).json() as any[];const subset=list.filter(r=>records.some(([key])=>key===r.id));expect(subset.map(r=>r.id)).toEqual(['recent-new','old-new','recent-done']);
 expect((await req('/api/admin/inquiries/archived')).status).toBe(404);expect((await req('/api/admin/inquiries/archived/status','PATCH',{status:'COMPLETED'})).status).toBe(404);
 expect((await req('/api/admin/inquiries/missing')).status).toBe(404);
 expect((await req('/api/admin/inquiries/old-new/status','PATCH',{status:'INVALID'})).status).toBe(400);
 expect((await req('/api/admin/inquiries/old-new/status','PATCH',{status:'COMPLETED'},admin,'https://evil.example')).status).toBe(403);
 expect((await req('/api/admin/inquiries/old-new/status','PATCH',{status:'COMPLETED',message:'x'.repeat(65000)})).status).toBe(413);
});

it.each(['OWNER','MANAGER','CREATOR','REVIEWER','VIEWER'])('%sでも非ADMINなら管理画面と管理APIは403',async role=>{
 const user=users[role];for(const path of ['/admin/inquiries','/admin/inquiries/detail','/api/admin/inquiries','/api/admin/inquiries/detail'])expect((await req(path,'GET',undefined,user)).status).toBe(403);
});
it('未ログインは管理画面・一覧・詳細・ステータスAPIすべて401',async()=>{
 for(const path of ['/admin/inquiries','/admin/inquiries/detail','/api/admin/access','/api/admin/inquiries','/api/admin/inquiries/detail'])expect((await req(path,'GET',undefined,null)).status).toBe(401);
 expect((await req('/api/admin/inquiries/detail/status','PATCH',{status:'IN_PROGRESS'},null)).status).toBe(401);
});
it('Punka ADMINは管理画面200で既存ID・Passkeyを維持したまま付与できる',async()=>{
 const user=id(),credential='admin-preserved-passkey';await env.DB.prepare('INSERT INTO users(id,display_name,created_at) VALUES(?,?,?)').bind(user,'Punka',now()).run();
 await env.DB.prepare('INSERT INTO sessions VALUES(?,?,?)').bind(await sha256(user),user,new Date(Date.now()+3600000).toISOString()).run();
 await env.DB.prepare('INSERT INTO webauthn_credentials(id,recipient_id,public_key,counter,transports_json,created_at) VALUES(?,?,?,?,?,?)').bind(credential,user,'existing-public-key',0,'[]',now()).run();
 const before=await env.DB.prepare('SELECT * FROM webauthn_credentials WHERE recipient_id=?').bind(user).all();
 expect((await req('/admin/inquiries','GET',undefined,user)).status).toBe(403);
 for(let i=0;i<2;i++)await env.DB.prepare("INSERT INTO site_admins(user_id,created_at) VALUES(?,?) ON CONFLICT(user_id) DO NOTHING").bind(user,now()).run();
 expect((await req('/admin/inquiries','GET',undefined,user)).status).toBe(200);expect((await req('/admin/inquiries/detail','GET',undefined,user)).status).toBe(200);
 expect(await (await req('/api/admin/access','GET',undefined,user)).json()).toEqual({is_admin:true,system_role:'ADMIN'});
 expect((await req('/api/admin/inquiries','GET',undefined,user)).status).toBe(200);
 const created=await req('/api/business/inquiries','POST',content,null),inquiry=(await created.json() as any).id;
 expect((await req(`/api/admin/inquiries/${inquiry}`,'GET',undefined,user)).status).toBe(200);
 for(const status of ['IN_PROGRESS','COMPLETED'])expect((await req(`/api/admin/inquiries/${inquiry}/status`,'PATCH',{status},user)).status).toBe(200);
 expect((await env.DB.prepare('SELECT * FROM webauthn_credentials WHERE recipient_id=?').bind(user).all()).results).toEqual(before.results);
 expect(await env.DB.prepare('SELECT id,display_name FROM users WHERE id=?').bind(user).first()).toEqual({id:user,display_name:'Punka'});
});
