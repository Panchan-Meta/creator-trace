import {env,applyD1Migrations} from 'cloudflare:test';
import {beforeAll,expect,it} from 'vitest';
import worker from '../src/index';
import {id,now,sha256} from '../src/domain';
import type {Bindings} from '../src/store';
const bindings={...env,APP_ORIGIN:'http://localhost:8787',RP_ID:'localhost'} as Bindings;
const owner=id(),token=id();
async function req(path:string,body?:unknown){return worker.fetch(new Request(bindings.APP_ORIGIN+path,{method:body===undefined?'GET':'POST',headers:{Origin:bindings.APP_ORIGIN,Cookie:`punka_session=${token}`},...(body===undefined?{}:{body:JSON.stringify(body)})}),bindings);}
beforeAll(async()=>{await applyD1Migrations(env.DB,(env as any).TEST_MIGRATIONS);await env.DB.prepare('INSERT INTO users(id,created_at) VALUES(?,?)').bind(owner,now()).run();await env.DB.prepare('INSERT INTO sessions VALUES(?,?,?)').bind(await sha256(token),owner,new Date(Date.now()+3600000).toISOString()).run();});
it.each(['projects','assets'])('%sの0件・1件・limitちょうど・次ページ・最終ページを判定',async kind=>{
 const q=id();let project:string|undefined;
 async function add(){if(kind==='projects')return (await (await req('/api/projects',{name:q})).json() as any).id;
  project??=(await (await req('/api/projects',{name:'Asset pagination'})).json() as any).id;
  return (await (await req(`/api/projects/${project}/assets`,{name:q,filename:`${q}.wav`,size:1,sha256:'a'.repeat(64)})).json() as any).id;
 }
 async function page(n:number,limit=1){const r=await req(`/api/${kind}?pagination=1&q=${q}&page=${n}&limit=${limit}`);expect(r.status).toBe(200);return r.json() as Promise<any>;}
 expect(await page(1)).toMatchObject({items:[],page:1,limit:1,hasNext:false});
 await add();expect(await page(1)).toMatchObject({page:1,hasNext:false});expect((await page(1)).items).toHaveLength(1);
 await add();expect(await page(1,2)).toMatchObject({hasNext:false});expect((await page(1,2)).items).toHaveLength(2);
 await add();const first=await page(1),second=await page(2),last=await page(3);
 expect(first).toMatchObject({page:1,hasNext:true});expect(second).toMatchObject({page:2,hasNext:true});expect(last).toMatchObject({page:3,hasNext:false});
 expect(new Set([...first.items,...second.items,...last.items].map(x=>x.id)).size).toBe(3);
 const legacy=await (await req(`/api/${kind}?q=${q}&limit=2`)).json();expect(Array.isArray(legacy)).toBe(true);expect(legacy).toHaveLength(2);
 if(project){const detail=await (await req(`/api/projects/${project}?q=${q}&limit=2`)).json() as any;expect(detail.assets).toHaveLength(2);expect(detail.assets_pagination.hasNext).toBe(true);}
});
it('作成者だけがOWNERとして自動参加し、担当者データの追加はメンバー追加にならない',async()=>{
 const project=(await (await req('/api/projects',{name:'Owner membership'})).json() as any).id;
 const before=await (await req(`/api/projects/${project}/members`)).json() as any[];expect(before).toHaveLength(1);expect(before[0]).toMatchObject({user_id:owner,role:'OWNER',status:'ACTIVE'});
 expect((await req(`/api/projects/${project}/creators`,{name:'Legacy credit',email:'legacy@example.com',role:'Mix'})).status).toBe(201);
 expect(await (await req(`/api/projects/${project}/members`)).json()).toEqual(before);
});
