import {env,applyD1Migrations} from 'cloudflare:test';
import {beforeAll,afterEach,it,expect,vi} from 'vitest';
import worker from '../src/index';
import {id,now,sha256} from '../src/domain';
import {type Bindings} from '../src/store';
import {reviewBots} from '../src/bot-reviews';
const user=id(),outsider=id(),key='test-xai-key-never-store';
const bindings={...env,APP_ORIGIN:'http://localhost:8787',RP_ID:'localhost',XAI_API_KEY:key,XAI_BASE_URL:'https://api.x.ai/v1',XAI_MODEL:'test-grok'} as Bindings;
let project:string,asset:string,version:string,otherProject:string,otherVersion:string;
async function req(path:string,body?:unknown,actor:string|null=user,config=bindings){return worker.fetch(new Request(bindings.APP_ORIGIN+path,{method:body===undefined?'GET':'POST',headers:{Origin:bindings.APP_ORIGIN,...(actor?{Cookie:`punka_session=${actor}`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})}),config);}
const path=()=>`/api/projects/${project}/bot-reviews`;
const history=()=>req(`${path()}?assetVersionId=${version}`);
async function production(){return Promise.all(['projects','assets','asset_versions','asset_version_states','asset_version_state_history','approvals','deliveries','delivery_history','proofs','project_members'].map(async table=>({table,rows:(await env.DB.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results})));}
function answer(content:string){return Response.json({choices:[{finish_reason:'stop',message:{content}}]});}
function mock(){return vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,init)=>{const body=JSON.parse(init!.body as string);const bot=reviewBots.find(b=>body.messages[0].content.includes(b.name))!;return answer(`${bot.name}：実データを確認、不足情報は未確認。`);});}
beforeAll(async()=>{
 await applyD1Migrations(env.DB,(env as unknown as {TEST_MIGRATIONS:Parameters<typeof applyD1Migrations>[1]}).TEST_MIGRATIONS);
 for(const actor of [user,outsider]){await env.DB.prepare('INSERT INTO users(id,display_name,created_at) VALUES(?,?,?)').bind(actor,'Punka',now()).run();await env.DB.prepare('INSERT INTO sessions VALUES(?,?,?)').bind(await sha256(actor),actor,new Date(Date.now()+3600000).toISOString()).run();}
 project=(await (await req('/api/projects',{name:'AI production',client_name:'Client'})).json() as any).id;
 const c=(await (await req(`/api/projects/${project}/creators`,{name:'Mix creator',role:'Mix'})).json() as any).id;
 const a=await (await req(`/api/projects/${project}/assets`,{filename:'version2.wav',mime_type:'audio/wav',size:10,sha256:'a'.repeat(64),status:'SUBMITTED',creator_id:c,comment:'音量調整'})).json() as any;asset=a.id;version=a.version_id;
 otherProject=(await (await req('/api/projects',{name:'Other'})).json() as any).id;
 otherVersion=(await (await req(`/api/projects/${otherProject}/assets`,{filename:'other',size:1,sha256:'b'.repeat(64)})).json() as any).version_id;
});
afterEach(()=>vi.restoreAllMocks());
it('4専門Botを並列に開始し橘に実データと4回答を渡し5件保存・監査・履歴再取得・制作状態不変',async()=>{
 const before=await production();let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),called:string[]=[];
 const spy=vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
  expect(new Request(String(input),init).redirect).toBe('manual');expect(String(input)).toBe('https://api.x.ai/v1/chat/completions');expect(new Headers(init!.headers).get('Authorization')).toBe(`Bearer ${key}`);
  const body=JSON.parse(init!.body as string),bot=reviewBots.find(b=>body.messages[0].content.includes(b.name))!;called.push(bot.key);expect(body.model).toBe('test-grok');expect(body.tools).toBeUndefined();expect(body.store).toBe(false);expect(body.messages[0].content).toContain('平易で丁寧な日本語');expect(body.messages[0].content).toContain('お客様へのご提案');expect(body.messages[0].content).not.toContain('人間');
  const data=JSON.parse(body.messages[1].content);expect(JSON.stringify(data)).not.toContain(key);expect(data.target.asset_version).toMatchObject({id:version,sha256:'a'.repeat(64),status:'SUBMITTED',comment:'音量調整'});expect(data.target.creator.name).toBe('Mix creator');expect(data.target.approvals.records).toEqual([]);expect(data.target.proof.bitcoin_status).toBe('NOT_REQUESTED');
  if(bot.key==='tachibana'){expect(called.slice(0,4)).toEqual(['sanada','mido','shiraishi','mizuki']);expect(data.specialist_reviews).toHaveLength(4);expect(data.specialist_reviews.map((r:any)=>r.bot_key)).toEqual(called.slice(0,4));}else await gate;
  return answer(`${bot.key} review`);
 });
 const pending=req(path(),{assetVersionId:version});await vi.waitFor(()=>expect(called).toHaveLength(4));release();const response=await pending;expect(response.status).toBe(201);const result=await response.json() as any;expect(result.status).toBe('COMPLETED');expect(result.messages.map((m:any)=>m.bot_key)).toEqual(reviewBots.map(b=>b.key));expect(spy).toHaveBeenCalledTimes(5);
 expect((await (await history()).json() as any[]).find(r=>r.id===result.id)).toEqual(result);expect(await production()).toEqual(before);
 const audits=await env.DB.prepare("SELECT event_type FROM audit_events WHERE target_id=? ORDER BY id").bind(result.id).all();expect(audits.results.map(r=>r.event_type)).toEqual(['BOT_REVIEW_STARTED','BOT_REVIEW_COMPLETED']);
 const saved=await env.DB.prepare('SELECT * FROM bot_review_runs WHERE id=?').bind(result.id).first<any>();expect(saved.context_json).toContain('音量調整');expect(JSON.stringify(saved)).not.toContain(key);
 await expect(env.DB.prepare('UPDATE bot_review_messages SET content=? WHERE run_id=?').bind('tamper',result.id).run()).rejects.toThrow();await expect(env.DB.prepare('DELETE FROM bot_review_runs WHERE id=?').bind(result.id).run()).rejects.toThrow();
});
it('再実行は過去のレビューを上書きしない',async()=>{mock();const response=await req(path(),{assetVersionId:version});expect(response.status).toBe(201);const runs=await (await history()).json() as any[];expect(runs.filter(r=>r.status==='COMPLETED')).toHaveLength(2);expect(runs.filter(r=>r.status==='COMPLETED').every(r=>r.messages.length===5)).toBe(true);});
it('未認証401・非案件ユーザー403・他案件Version403・不正body400',async()=>{
 const spy=mock();expect((await req(path(),{assetVersionId:version},null)).status).toBe(401);expect((await req(path(),{assetVersionId:version},outsider)).status).toBe(403);expect((await req(`${path()}?assetVersionId=${version}`,undefined,outsider)).status).toBe(403);
 expect((await req(path(),{assetVersionId:otherVersion})).status).toBe(403);expect((await req(path(),{assetVersionId:'Punka'})).status).toBe(400);expect((await req(path(),{assetVersionId:version,model:'injected'})).status).toBe(400);expect(spy).not.toHaveBeenCalled();
});
it('同一Versionの同時リクエストは一方だけ実行し409を返す',async()=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);const spy=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{await gate;return answer('review');});
 const first=req(path(),{assetVersionId:version});await vi.waitFor(()=>expect(spy).toHaveBeenCalledTimes(4));const second=await req(path(),{assetVersionId:version});expect(second.status).toBe(409);release();expect((await first).status).toBe(201);
});
it.each(['specialist','chair','invalid','truncated','network'])('xAIの%s失敗はFAILEDと監査のみ保存し制作データを変えず秘密を返さない',async mode=>{
 const before=await production();vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,init)=>{const chair=JSON.parse(init!.body as string).messages[0].content.includes('橘 司');if(mode==='network')throw new Error(key);if(mode==='invalid')return Response.json({choices:[]});if(mode==='truncated')return Response.json({choices:[{finish_reason:'length',message:{content:'partial'}}]});if(mode==='specialist'||chair)return new Response(key,{status:503});return answer('specialist review');});
 const response=await req(path(),{assetVersionId:version});expect(response.status).toBe(502);const result=await response.json() as any;expect(result.error).toBe('AIレビューに失敗しました。制作データには変更ありません。');expect(JSON.stringify(result)).not.toContain(key);const run=await env.DB.prepare('SELECT * FROM bot_review_runs WHERE id=?').bind(result.id).first<any>();expect(run.status).toBe('FAILED');expect(JSON.stringify(run)).not.toContain(key);expect(await production()).toEqual(before);
 const events=await env.DB.prepare('SELECT event_type FROM audit_events WHERE target_id=? ORDER BY id').bind(result.id).all();expect(events.results.map(r=>r.event_type)).toEqual(['BOT_REVIEW_STARTED','BOT_REVIEW_FAILED']);
});
it('設定未登録・外部送信先設定は503で秘密を外部に送信しない',async()=>{const spy=mock();expect((await req(path(),{assetVersionId:version},user,{...bindings,XAI_API_KEY:undefined})).status).toBe(503);expect((await req(path(),{assetVersionId:version},user,{...bindings,XAI_BASE_URL:'https://evil.example/v1'})).status).toBe(503);expect(spy).not.toHaveBeenCalled();});
it('Bot応答に秘密が含まれてもDBとAPIでは伏せる',async()=>{vi.spyOn(globalThis,'fetch').mockImplementation(async()=>answer(`review ${key}`));const response=await req(path(),{assetVersionId:version});expect(response.status).toBe(201);const result=await response.json() as any;expect(JSON.stringify(result)).not.toContain(key);expect(result.messages.every((m:any)=>m.content.includes('[REDACTED]'))).toBe(true);});

it('180秒のタイムアウトはFAILEDにして制作データを維持する',async()=>{
 const before=await production();vi.spyOn(globalThis,'fetch').mockImplementation(async(_input,init)=>new Promise<Response>((_resolve,reject)=>{init!.signal!.addEventListener('abort',()=>reject(new Error('timeout')),{once:true});}));
 const timer=vi.spyOn(globalThis,'setTimeout');const pending=req(path(),{assetVersionId:version});await vi.waitFor(()=>expect(timer.mock.calls.some(([,delay])=>delay===180000)).toBe(true));
 const callback=timer.mock.calls.find(([,delay])=>delay===180000)![0];(callback as ()=>void)();expect((await pending).status).toBe(502);expect(await production()).toEqual(before);
});
it('5分以上中断したRUNNINGは履歴取得でFAILEDになり再実行できる',async()=>{
 const run=id(),time=new Date(Date.now()-360000).toISOString();await env.DB.prepare("INSERT INTO bot_review_runs(id,project_id,asset_version_id,status,model,created_by,started_at,created_at,context_json) VALUES(?,?,?,'RUNNING',?,?,?,?,?)").bind(run,project,version,'test-grok',user,time,time,'{}').run();
 const runs=await (await history()).json() as any[];expect(runs.find(r=>r.id===run).status).toBe('FAILED');mock();expect((await req(path(),{assetVersionId:version})).status).toBe(201);
});

it('xAIのリダイレクトは追従せず失敗にし秘密を転送しない',async()=>{
 const spy=vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,init)=>{expect(init?.redirect).toBe('manual');return new Response('',{status:302,headers:{Location:'https://other.example'}});});
 const response=await req(path(),{assetVersionId:version});expect(response.status).toBe(502);expect(await response.json()).toMatchObject({status:'FAILED',code:'XAI_HTTP_302_REQUEST'});expect(spy).toHaveBeenCalledTimes(4);
});
