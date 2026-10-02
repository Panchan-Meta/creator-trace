import {env,applyD1Migrations} from 'cloudflare:test';
import {beforeAll,it,expect,vi,afterEach} from 'vitest';
import worker from '../src/index';
import {type Bindings} from '../src/store';
import {id,now,sha256} from '../src/domain';
import {processProof,refreshProofs} from '../src/timestamps';
import {parseReceipt} from '../src/proof';
import {createHash} from 'node:crypto';
const bindings={...env,APP_ORIGIN:'http://localhost:8787',RP_ID:'localhost',SIGNUP_ENABLED:'true'} as Bindings;
const users=Object.fromEntries(['OWNER','MANAGER','CREATOR','REVIEWER','VIEWER','OUTSIDER'].map(role=>[role,id()]));
let project:string,asset:string,version:string,proof:string;
async function req(path:string,body?:unknown,role='OWNER',key?:string){return worker.fetch(new Request(bindings.APP_ORIGIN+path,{method:body===undefined?'GET':'POST',headers:{Origin:bindings.APP_ORIGIN,...(key?{Authorization:`Bearer ${key}`}:{Cookie:`punka_session=${users[role]}`})},...(body===undefined?{}:{body:JSON.stringify(body)})}),bindings);}
async function newAsset(role='OWNER',status='DRAFT',hash='d'.repeat(64)){const response=await req(`/api/projects/${project}/assets`,{filename:'song.wav',size:10,sha256:hash,status},role);expect(response.status).toBe(201);const a=await response.json() as any;return {asset:a.id,version:a.version_id,proof:a.proof_id};}
beforeAll(async()=>{
 await applyD1Migrations(env.DB,(env as unknown as {TEST_MIGRATIONS:Parameters<typeof applyD1Migrations>[1]}).TEST_MIGRATIONS);
 for(const u of Object.values(users)){await env.DB.prepare('INSERT INTO users(id,created_at) VALUES(?,?)').bind(u,now()).run();await env.DB.prepare('INSERT INTO sessions VALUES(?,?,?)').bind(await sha256(u),u,new Date(Date.now()+3600000).toISOString()).run();}
 project=(await (await req('/api/projects',{name:'Actual production'})).json() as any).id;
 for(const role of ['MANAGER','CREATOR','REVIEWER','VIEWER'])await env.DB.prepare('INSERT INTO project_members(id,project_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)').bind(id(),project,users[role],role,'ACTIVE',now()).run();
 const a=await newAsset();asset=a.asset;version=a.version;proof=a.proof;
});
afterEach(()=>vi.restoreAllMocks());
it('5役割と案件分離をAPI側で強制する',async()=>{
 for(const role of ['OWNER','MANAGER','CREATOR','REVIEWER','VIEWER'])expect((await req(`/api/projects/${project}`,undefined,role)).status).toBe(200);
 expect((await req(`/api/projects/${project}`,undefined,'OUTSIDER')).status).toBe(404);
 for(const role of ['REVIEWER','VIEWER'])expect((await req(`/api/projects/${project}/assets`,{filename:'x',size:1,sha256:'e'.repeat(64)},role)).status).toBe(403);
 const a=await newAsset('CREATOR');expect((await req(`/api/asset-versions/${a.version}/submit`,{},'CREATOR')).status).toBe(200);
 expect((await req(`/api/asset-versions/${version}/submit`,{},'CREATOR')).status).toBe(403);
 expect((await req(`/api/asset-versions/${a.version}/approve`,{},'CREATOR')).status).toBe(403);
 expect((await req(`/api/asset-versions/${a.version}/approve`,{},'REVIEWER')).status).toBe(200);
});
it('状態遷移と承認・監査の追記を保証する',async()=>{
 expect((await req(`/api/asset-versions/${version}/finalize`,{})).status).toBe(409);
 expect((await req(`/api/asset-versions/${version}/submit`,{})).status).toBe(200);
 expect((await req(`/api/asset-versions/${version}/approve`,{reason:'音源確認'},'OWNER')).status).toBe(200);
 vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('offline'));
 expect((await req(`/api/asset-versions/${version}/finalize`,{})).status).toBe(200);
 expect((await req(`/api/asset-versions/${version}/submit`,{})).status).toBe(409);
 const h=await (await req(`/api/asset-versions/${version}/history`)).json() as any;expect(h.history.map((x:any)=>x.to_status)).toEqual(['DRAFT','SUBMITTED','APPROVED','FINAL']);expect(h.approvals[0].decision).toBe('APPROVED');
 await expect(env.DB.prepare('UPDATE asset_version_states SET status=? WHERE asset_version_id=?').bind('DRAFT',version).run()).rejects.toThrow();
 await expect(env.DB.prepare('DELETE FROM approvals WHERE asset_version_id=?').bind(version).run()).rejects.toThrow();
 await expect(env.DB.prepare('UPDATE audit_events SET event_type=?').bind('fake').run()).rejects.toThrow();
 const log=await (await req(`/api/projects/${project}/audit`)).json() as any[];expect(log.some(x=>x.event_type==='VERSION_FINALIZED')).toBe(true);
 const rejected=await newAsset('OWNER','SUBMITTED');expect((await req(`/api/asset-versions/${rejected.version}/reject`,{reason:'修正依頼'},'OWNER')).status).toBe(200);expect((await req(`/api/asset-versions/${rejected.version}/submit`,{})).status).toBe(409);
});
it('受領者のみ受領でき、履歴を一度だけ追記する',async()=>{
 const created=await req(`/api/asset-versions/${version}/deliveries`,{recipient_user_id:users.CREATOR});expect(created.status).toBe(201);const d=await created.json() as any;
 expect((await req(`/api/deliveries/${d.id}/receive`,{})).status).toBe(403);expect((await req(`/api/deliveries/${d.id}/receive`,{},'CREATOR')).status).toBe(200);expect((await req(`/api/deliveries/${d.id}/reject`,{},'CREATOR')).status).toBe(409);
 const h=await env.DB.prepare('SELECT * FROM delivery_history WHERE delivery_id=?').bind(d.id).all();expect(h.results).toHaveLength(2);
});
it('全役割の案件メンバーの内部IDで納品し、表示名と所属を検証する',async()=>{
 await env.DB.prepare('UPDATE users SET display_name=? WHERE id=?').bind('Punka',users.VIEWER).run();
 const members=await (await req(`/api/projects/${project}/members`)).json() as any[];
 expect(members).toHaveLength(5);expect(members.find(m=>m.user_id===users.VIEWER).display_name).toBe('Punka');
 for(const role of ['OWNER','MANAGER','CREATOR','REVIEWER','VIEWER']){
  const response=await req(`/api/asset-versions/${version}/deliveries`,{recipient_user_id:users[role],comment:'TEST'});expect(response.status).toBe(201);
  const delivery=await response.json() as any;const saved=await env.DB.prepare('SELECT recipient_user_id,comment FROM deliveries WHERE id=?').bind(delivery.id).first();expect(saved).toEqual({recipient_user_id:users[role],comment:'TEST'});
 }
});
it('非案件メンバー・未選択・表示名の納品を具体的なエラーで拒否し履歴を変更しない',async()=>{
 const before=await env.DB.prepare('SELECT COUNT(*) AS count FROM deliveries').first();
 for(const [body,status,message] of [
  [{recipient_user_id:users.OUTSIDER},403,'選択したユーザーはこの案件のメンバーではありません'],
  [{},400,'受領者を選択してください'],
  [{recipient_user_id:''},400,'受領者を選択してください'],
  [{recipient_user_id:'Punka'},400,'受領者の指定が不正です。案件メンバーから選択してください'],
 ] as const){const response=await req(`/api/asset-versions/${version}/deliveries`,body);expect(response.status).toBe(status);expect(await response.json()).toEqual({error:message});}
 await env.DB.prepare("UPDATE project_members SET status='REVOKED' WHERE project_id=? AND user_id=?").bind(project,users.MANAGER).run();
 const revoked=await req(`/api/asset-versions/${version}/deliveries`,{recipient_user_id:users.MANAGER});expect(revoked.status).toBe(403);
 await env.DB.prepare("UPDATE project_members SET status='ACTIVE' WHERE project_id=? AND user_id=?").bind(project,users.MANAGER).run();
 expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM deliveries').first()).toEqual(before);
});
it('APIキーはhashのみ保存しscope・失効・案件境界を検証する',async()=>{
 const response=await req('/api/api-keys',{name:'integration',project_id:project,scopes:['projects:read']});expect(response.status).toBe(201);const k=await response.json() as any;
 const saved=await env.DB.prepare('SELECT key_hash FROM api_keys WHERE key_id=?').bind(k.key_id).first<{key_hash:string}>();expect(saved!.key_hash).toBe(await sha256(k.key));
 expect((await req('/api/v1/projects',undefined,'OWNER',k.key)).status).toBe(200);expect((await req(`/api/v1/assets/${asset}`,undefined,'OWNER',k.key)).status).toBe(403);
 expect((await req('/api/v1/projects',undefined,'OWNER','ct_invalid')).status).toBe(401);await req(`/api/api-keys/${k.key_id}/revoke`,{});expect((await req('/api/v1/projects',undefined,'OWNER',k.key)).status).toBe(401);
});
it('招待は期限・一回利用・Passkeyを要求し平文tokenを保存しない',async()=>{
 await env.DB.prepare('INSERT INTO webauthn_credentials(id,recipient_id,public_key,counter,transports_json,created_at) VALUES(?,?,?,?,?,?)').bind('viewer-key',users.OUTSIDER,'fake-test-key',0,'[]',now()).run();
 const response=await req(`/api/projects/${project}/invites`,{email:'external@example.com',role:'VIEWER'},'MANAGER');expect(response.status).toBe(201);const invite=await response.json() as any,token=invite.url.split('/').at(-1);
 expect((await req('/api/project-invites/accept',{token:'invalid'},'OUTSIDER')).status).toBe(400);expect((await req('/api/project-invites/accept',{token,display_name:'Outside member'},'OUTSIDER')).status).toBe(200);expect((await req('/api/project-invites/accept',{token,display_name:'Outside member'},'OUTSIDER')).status).toBe(400);
 const expired=await (await req(`/api/projects/${project}/invites`,{email:'x@example.com',role:'CREATOR'})).json() as any;await env.DB.prepare('UPDATE project_invites SET expires_at=? WHERE id=?').bind('2000-01-01',expired.id).run();expect((await req('/api/project-invites/accept',{token:expired.url.split('/').at(-1)},'OUTSIDER')).status).toBe(410);
});
it('複数Passkeyの削除と最終credential保護、既存ユーザーの登録options',async()=>{
 expect((await req('/api/auth/passkeys/viewer-key/remove',{},'OUTSIDER')).status).toBe(409);
 await env.DB.prepare('INSERT INTO webauthn_credentials(id,recipient_id,public_key,counter,transports_json,created_at) VALUES(?,?,?,?,?,?)').bind('second-key',users.OUTSIDER,'fake-test-key',0,'[]',now()).run();expect((await req('/api/auth/passkeys/second-key/remove',{},'OUTSIDER')).status).toBe(200);
 await expect(env.DB.prepare('DELETE FROM webauthn_credentials WHERE recipient_id=?').bind(users.OUTSIDER).run()).rejects.toThrow();
 const token=`punka_session=${users.OUTSIDER}`;
 const options=await worker.fetch(new Request(bindings.APP_ORIGIN+'/api/auth/passkey/register/options',{method:'POST',headers:{Origin:bindings.APP_ORIGIN,Cookie:token},body:'{}'}),bindings);expect(options.status).toBe(200);const d=await options.json() as any;expect(d.authenticatorSelection.authenticatorAttachment).toBeUndefined();expect(d.authenticatorSelection.userVerification).toBe('required');
 expect((await req('/api/auth/passkey/login/verify',{response:{}})).status).toBe(400);
});
it('OTS stamp失敗・retry・pending保存・download・Confirmedは再処理しない',async()=>{
 const a=await newAsset('OWNER','DRAFT','f'.repeat(64));vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('offline'));await processProof(bindings,a.proof);
 let p=await env.DB.prepare('SELECT * FROM proofs WHERE id=?').bind(a.proof).first<any>();expect(p.proof_status).toBe('FAILED');expect(p.retry_count).toBe(1);expect(p.error_code).toBeTruthy();
 vi.restoreAllMocks();await env.DB.prepare('UPDATE proofs SET last_retry_at=NULL WHERE id=?').bind(a.proof).run();
 const fixture=(env as unknown as {TEST_OTS:string}).TEST_OTS,tree=parseReceipt(fixture,Buffer.from(fixture,'base64').subarray(33,65).toString('hex')).bytes.slice(65);
 const fetchSpy=vi.spyOn(globalThis,'fetch').mockImplementation(async(_input,init)=>init?.method==='POST'?new Response(tree):new Response('pending',{status:404}));await processProof(bindings,a.proof);expect(fetchSpy.mock.calls.some(([url])=>String(url).startsWith('https://alice.btc.calendar.opentimestamps.org/timestamp/'))).toBe(true);p=await env.DB.prepare('SELECT * FROM proofs WHERE id=?').bind(a.proof).first<any>();expect(p.proof_status).toBe('WAITING_BITCOIN');expect(p.retry_count).toBe(2);expect(parseReceipt(p.ots_proof,'f'.repeat(64)).attestations).toEqual([]);
 const download=await req(`/api/proofs/${a.proof}/ots`);expect(download.status).toBe(200);expect(download.headers.get('Content-Disposition')).toContain('.ots');expect(Buffer.from(await download.arrayBuffer()).toString('base64')).toBe(p.ots_proof);
 await env.DB.prepare("UPDATE proofs SET proof_status='CONFIRMED' WHERE id=?").bind(a.proof).run();const spy=vi.spyOn(globalThis,'fetch');spy.mockClear();await processProof(bindings,a.proof);expect(spy).not.toHaveBeenCalled();
});
it('Bitcoin mainnetと6確認をRPC検証した場合だけConfirmedにする',async()=>{
 const a=await newAsset('OWNER','DRAFT','1'.repeat(64));let root='';
 vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
  if(String(input).includes('/digest')){root=Buffer.from(init!.body as Uint8Array).reverse().toString('hex');return new Response(Buffer.from('000588960d73d719010101','hex'));}
  const call=JSON.parse(init!.body as string);const result=call.method==='getblockhash'?(call.params[0]===0?'000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f':'b'.repeat(64)):{height:1,confirmations:6,merkleroot:root,time:1700000000};return Response.json({result,error:null});
 });
 await processProof({...bindings,BITCOIN_RPC_URL:'http://localhost:8332'},a.proof);
 const p=await env.DB.prepare('SELECT * FROM proofs WHERE id=?').bind(a.proof).first<any>();expect(p.proof_status).toBe('CONFIRMED');expect(p.bitcoin_confirmed_at).toBeTruthy();expect(p.timestamp_created_at).toBeTruthy();expect(p.bitcoin_block).toBe(1);
 const log=await env.DB.prepare("SELECT * FROM audit_events WHERE target_id=? AND event_type='BITCOIN_CONFIRMED'").bind(a.proof).all();expect(log.results).toHaveLength(1);
 await expect(env.DB.prepare('UPDATE proofs SET ots_proof=? WHERE id=?').bind('invalid',a.proof).run()).rejects.toThrow();
});
it('保存済みpending OTSをupgradeし、同hashの別Proofでは再stampしない',async()=>{
 const a=await newAsset('OWNER','DRAFT','2'.repeat(64));const fixture=(env as unknown as {TEST_OTS:string}).TEST_OTS,tree=Buffer.from(fixture,'base64').subarray(65);
 vi.spyOn(globalThis,'fetch').mockImplementation(async(_input,init)=>init?.method==='POST'?new Response(tree):new Response('pending',{status:404}));await processProof(bindings,a.proof);
 let p=await env.DB.prepare('SELECT * FROM proofs WHERE id=?').bind(a.proof).first<any>();const parsed=parseReceipt(p.ots_proof,'2'.repeat(64));const root=createHash('sha256').update(Buffer.from(parsed.pending[0].message,'hex')).digest().reverse().toString('hex');await env.DB.prepare('UPDATE proofs SET last_retry_at=NULL WHERE id=?').bind(a.proof).run();vi.restoreAllMocks();
 const pending=parsed.pending[0],upgraded=Buffer.concat([parsed.bytes.slice(0,pending.lastEntryStart),Buffer.from([255]),parsed.bytes.slice(pending.lastEntryStart,pending.treeEnd),Buffer.from('08000588960d73d719010101','hex'),parsed.bytes.slice(pending.treeEnd)]);
 expect(parseReceipt(upgraded.toString('base64'),'2'.repeat(64)).attestations).toEqual([{height:1,merkleRoot:root}]);
 const calls=vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
  if(String(input).includes('/timestamp/'))return new Response(Buffer.from('08000588960d73d719010101','hex'));
  if(String(input).includes('/digest'))throw new Error('must reuse saved OTS');
  const call=JSON.parse(init!.body as string);return Response.json({error:null,result:call.method==='getblockhash'?(call.params[0]===0?'000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f':'b'.repeat(64)):{height:1,confirmations:6,merkleroot:root,time:1700000000}});
 });
 await processProof({...bindings,BITCOIN_RPC_URL:'http://localhost:8332'},a.proof);p=await env.DB.prepare('SELECT * FROM proofs WHERE id=?').bind(a.proof).first<any>();expect(p.proof_status,JSON.stringify({calls:calls.mock.calls.map(([url])=>String(url)),error:p.error_code,attestations:parseReceipt(p.ots_proof,'2'.repeat(64)).attestations})).toBe('CONFIRMED');expect(parseReceipt(p.ots_proof,'2'.repeat(64)).attestations).toHaveLength(1);
 const b=await newAsset('OWNER','DRAFT','2'.repeat(64));calls.mockClear();await processProof({...bindings,BITCOIN_RPC_URL:'http://localhost:8332'},b.proof);expect(calls.mock.calls.every(([url])=>!String(url).includes('/digest')&&!String(url).includes('/timestamp/'))).toBe(true);const reused=await env.DB.prepare('SELECT * FROM proofs WHERE id=?').bind(b.proof).first<any>();expect(reused.proof_status).toBe('CONFIRMED');expect(reused.timestamp_created_at).toBe(p.timestamp_created_at);
});

it('Calendarの取得失敗とBitcoin接続未設定を区別して保持する',async()=>{
 const a=await newAsset('OWNER','DRAFT','5'.repeat(64)),fixture=(env as unknown as {TEST_OTS:string}).TEST_OTS,tree=Buffer.from(fixture,'base64').subarray(65);
 vi.spyOn(globalThis,'fetch').mockImplementation(async(_input,init)=>init?.method==='POST'?new Response(tree):new Response('unavailable',{status:503}));await processProof(bindings,a.proof);
 let proof=await env.DB.prepare('SELECT * FROM proofs WHERE id=?').bind(a.proof).first<any>();expect(proof.proof_status).toBe('WAITING_BITCOIN');expect(proof.error_code).toBe('OTS_UPGRADE_FAILED');expect(proof.timestamp_created_at).toBeTruthy();expect(proof.bitcoin_confirmed_at).toBeNull();
 vi.restoreAllMocks();const b=await newAsset('OWNER','DRAFT','6'.repeat(64));vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(Buffer.from('000588960d73d719010101','hex')));await processProof(bindings,b.proof);
 proof=await env.DB.prepare('SELECT * FROM proofs WHERE id=?').bind(b.proof).first<any>();expect(proof.error_code).toBeNull();expect(proof.bitcoin_verification_state).toBe('BITCOIN_ANCHOR_FOUND');expect(proof.proof_status).toBe('WAITING_BITCOIN');expect(proof.bitcoin_confirmed_at).toBeNull();expect(parseReceipt(proof.ots_proof,proof.sha256).attestations).toHaveLength(1);
});

async function anchoredProof(){
 const a=await newAsset('OWNER','DRAFT','7'.repeat(64));
 const receipt=Buffer.concat([Buffer.from('004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e892940108','hex'),Buffer.from('7'.repeat(64),'hex'),Buffer.from('000588960d73d719010164','hex')]).toString('base64');
 await env.DB.prepare("UPDATE proofs SET ots_proof=?,timestamp_created_at=?,proof_status='WAITING_BITCOIN',timestamp_status='PENDING',bitcoin_status='PENDING' WHERE id=?").bind(receipt,'2026-01-01T00:00:00.000Z',a.proof).run();return {...a,receipt};
}
function esploraMock(root='7'.repeat(64),timeout=false){
 const header=Buffer.alloc(80);Buffer.from(root,'hex').reverse().copy(header,36);header.writeUInt32LE(1700000000,68);const hash=createHash('sha256').update(createHash('sha256').update(header).digest()).digest().reverse().toString('hex');
 const responses:Record<string,unknown>={'/block-height/0':'000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f','/block-height/100':hash,[`/block/${hash}/header`]:header.toString('hex'),[`/block/${hash}`]:{id:hash,height:100,timestamp:1700000000,merkle_root:root},[`/block/${hash}/status`]:{in_best_chain:true},'/blocks/tip/height':'105'};
 vi.spyOn(globalThis,'fetch').mockImplementation(async input=>{if(timeout)throw new DOMException('timeout','TimeoutError');const value=responses[new URL(String(input)).pathname.replace('/api','')];if(value===undefined)throw new Error('Unexpected call');return typeof value==='string'?new Response(value):Response.json(value);});return hash;
}
it('OTSアンカー検出・API未設定・保存証跡保持・認可・二重実行409',async()=>{
 const a=await anchoredProof(),fetch=vi.spyOn(globalThis,'fetch');
 const versionBefore=await env.DB.prepare('SELECT * FROM asset_versions WHERE id=?').bind(a.version).first();
 for(const role of ['CREATOR','REVIEWER','VIEWER'])expect((await req(`/api/proofs/${a.proof}/bitcoin-recheck`,{},role)).status).toBe(403);
 expect((await worker.fetch(new Request(bindings.APP_ORIGIN+`/api/proofs/${a.proof}/bitcoin-recheck`,{method:'POST',headers:{Origin:bindings.APP_ORIGIN},body:'{}'}),bindings)).status).toBe(401);
 expect((await req(`/api/proofs/${a.proof}/bitcoin-recheck`,{})).status).toBe(200);expect(fetch).not.toHaveBeenCalled();
 const p=await (await req(`/api/proofs/${a.proof}`)).json() as any;expect(p.verification.state).toBe('BITCOIN_ANCHOR_FOUND');expect(p.verification.anchors).toEqual([{height:100,merkle_root:'7'.repeat(64)}]);expect(p.ots_proof).toBe(a.receipt);expect(p.timestamp_created_at).toBe('2026-01-01T00:00:00.000Z');expect(p.verification.last_attempt.state).toBe('BITCOIN_ANCHOR_FOUND');expect(p.bitcoin_confirmed_at).toBeNull();expect((await req(`/api/proofs/${a.proof}/bitcoin-recheck`,{})).status).toBe(409);
 expect(await env.DB.prepare('SELECT * FROM asset_versions WHERE id=?').bind(a.version).first()).toEqual(versionBefore);
});
it('Esplora検証失敗→retry成功→CONFIRMED後再検証成功/timeoutでも元記録不変・履歴は追記',async()=>{
 const a=await anchoredProof(),configured={...bindings,BITCOIN_API_BASE_URL:'https://bitcoin.test/api'};
 esploraMock('8'.repeat(64));await processProof(configured,a.proof);
 let p=await env.DB.prepare('SELECT * FROM proofs WHERE id=?').bind(a.proof).first<any>();expect(p.bitcoin_verification_state).toBe('VERIFY_FAILED');expect(p.error_code).toBe('BLOCK_MISMATCH');expect(p.ots_proof).toBe(a.receipt);expect(p.proof_status).toBe('WAITING_BITCOIN');expect(p.bitcoin_confirmed_at).toBeNull();
 vi.restoreAllMocks();const hash=esploraMock();await env.DB.prepare('UPDATE proofs SET last_retry_at=NULL WHERE id=?').bind(a.proof).run();await processProof(configured,a.proof);
 p=await env.DB.prepare('SELECT * FROM proofs WHERE id=?').bind(a.proof).first<any>();expect(p.bitcoin_status).toBe('CONFIRMED');expect(p.bitcoin_verification_state).toBe('BITCOIN_VERIFIED');expect(p.bitcoin_block_height).toBe(100);expect(p.bitcoin_block_hash).toBe(hash);expect(p.bitcoin_block_time).toBe('2023-11-14T22:13:20.000Z');expect(p.bitcoin_confirmed_at).not.toBe(p.bitcoin_block_time);expect(p.timestamp_created_at).toBe('2026-01-01T00:00:00.000Z');
 const immutableKeys=['ots_proof','sha256','bitcoin_status','proof_status','timestamp_created_at','bitcoin_confirmed_at','bitcoin_block_height','bitcoin_block_hash','bitcoin_block_time','bitcoin_verification_state'];
 await env.DB.prepare('UPDATE proofs SET last_retry_at=NULL WHERE id=?').bind(a.proof).run();await processProof(configured,a.proof,null,true);
 vi.restoreAllMocks();esploraMock('7'.repeat(64),true);await env.DB.prepare('UPDATE proofs SET last_retry_at=NULL WHERE id=?').bind(a.proof).run();await processProof(configured,a.proof,null,true);
 const after=await env.DB.prepare('SELECT * FROM proofs WHERE id=?').bind(a.proof).first<any>();for(const key of immutableKeys)expect(after[key]).toEqual(p[key]);
 const attempts=await env.DB.prepare('SELECT * FROM bitcoin_verification_attempts WHERE proof_id=? ORDER BY rowid').bind(a.proof).all<any>();expect(attempts.results.map(x=>x.state)).toEqual(['VERIFY_FAILED','BITCOIN_VERIFIED','BITCOIN_VERIFIED','VERIFY_FAILED']);expect(attempts.results.at(-1)?.error_code).toBe('TIMEOUT');
 const view=await (await req(`/api/proofs/${a.proof}`)).json() as any;expect(view.verification.state).toBe('BITCOIN_VERIFIED');expect(view.verification.last_attempt.state).toBe('VERIFY_FAILED');
 await expect(env.DB.prepare('DELETE FROM bitcoin_verification_attempts WHERE proof_id=?').bind(a.proof).run()).rejects.toThrow();await expect(env.DB.prepare('UPDATE proofs SET bitcoin_block_hash=? WHERE id=?').bind('f'.repeat(64),a.proof).run()).rejects.toThrow();
});

it('Cronは確認済み証跡を1日経過後に再検証し履歴だけ追加する',async()=>{
 await env.DB.prepare('UPDATE proofs SET last_retry_at=?').bind(now()).run();
 const a=await anchoredProof(),configured={...bindings,BITCOIN_API_BASE_URL:'https://bitcoin.test/api'};esploraMock();await processProof(configured,a.proof);
 const before=await env.DB.prepare('SELECT bitcoin_confirmed_at,ots_proof FROM proofs WHERE id=?').bind(a.proof).first();
 await env.DB.prepare('UPDATE proofs SET last_retry_at=? WHERE id=?').bind(new Date(Date.now()-2*86400000).toISOString(),a.proof).run();await refreshProofs(configured);
 expect(await env.DB.prepare('SELECT bitcoin_confirmed_at,ots_proof FROM proofs WHERE id=?').bind(a.proof).first()).toEqual(before);
 expect((await env.DB.prepare('SELECT * FROM bitcoin_verification_attempts WHERE proof_id=?').bind(a.proof).all()).results).toHaveLength(2);await refreshProofs(configured);expect((await env.DB.prepare('SELECT * FROM bitcoin_verification_attempts WHERE proof_id=?').bind(a.proof).all()).results).toHaveLength(2);
});

async function recheck(proofId:string,configured:Bindings){return worker.fetch(new Request(bindings.APP_ORIGIN+`/api/proofs/${proofId}/bitcoin-recheck`,{method:'POST',headers:{Origin:bindings.APP_ORIGIN,Cookie:`punka_session=${users.OWNER}`},body:'{}'}),configured);}
it('recheckのHTTP成功と検証失敗/CONFIRMEDを区別し、保存証跡を保持',async()=>{
 const a=await anchoredProof(),configured={...bindings,BITCOIN_API_BASE_URL:'https://bitcoin.test/api'};
 const before=await env.DB.prepare('SELECT sha256,ots_proof,timestamp_created_at FROM proofs WHERE id=?').bind(a.proof).first();
 vi.spyOn(globalThis,'fetch').mockImplementation(async input=>String(input).endsWith('/block-height/0')?new Response('000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f'):new Response('private upstream error',{status:404}));
 const failed=await recheck(a.proof,configured);expect(failed.status).toBe(200);
 expect(await failed.json()).toEqual({ok:true,verificationStatus:'VERIFY_FAILED',blockHeight:100,failureStage:'BLOCK_HASH_LOOKUP',errorCode:'BLOCK_HASH_LOOKUP_FAILED'});
 expect(await env.DB.prepare('SELECT sha256,ots_proof,timestamp_created_at FROM proofs WHERE id=?').bind(a.proof).first()).toEqual(before);
 const attempt=await env.DB.prepare('SELECT failure_stage,error_type,http_status FROM bitcoin_verification_attempts WHERE proof_id=?').bind(a.proof).first();
 expect(attempt).toEqual({failure_stage:'BLOCK_HASH_LOOKUP',error_type:'BLOCK_HASH_LOOKUP_FAILED',http_status:404});
 vi.restoreAllMocks();const hash=esploraMock();await env.DB.prepare('UPDATE proofs SET last_retry_at=NULL WHERE id=?').bind(a.proof).run();
 const confirmed=await recheck(a.proof,configured);expect(confirmed.status).toBe(200);
 const result=await confirmed.json() as any;expect(result).toMatchObject({ok:true,verificationStatus:'CONFIRMED',blockHeight:100,blockHash:hash,blockTime:'2023-11-14T22:13:20.000Z'});expect(result.confirmedAt).toBeTruthy();
 const saved=await env.DB.prepare('SELECT bitcoin_confirmed_at,bitcoin_block_height,bitcoin_block_hash,bitcoin_block_time FROM proofs WHERE id=?').bind(a.proof).first<any>();
 expect(saved).toEqual({bitcoin_confirmed_at:result.confirmedAt,bitcoin_block_height:100,bitcoin_block_hash:hash,bitcoin_block_time:result.blockTime});
 const protectedBefore=await env.DB.prepare('SELECT * FROM proofs WHERE id=?').bind(a.proof).first<any>();
 vi.restoreAllMocks();vi.spyOn(globalThis,'fetch').mockRejectedValue(new DOMException('private','TimeoutError'));await env.DB.prepare('UPDATE proofs SET last_retry_at=NULL WHERE id=?').bind(a.proof).run();
 const latest=await recheck(a.proof,configured);expect(await latest.json()).toMatchObject({ok:true,verificationStatus:'VERIFY_FAILED',failureStage:'NETWORK_CHECK',errorCode:'TIMEOUT'});
 const after=await env.DB.prepare('SELECT * FROM proofs WHERE id=?').bind(a.proof).first<any>();
 for(const key of ['sha256','ots_proof','timestamp_created_at','bitcoin_status','bitcoin_block_height','bitcoin_block_hash','bitcoin_block_time','bitcoin_confirmed_at'])expect(after[key]).toBe(protectedBefore[key]);
 expect((await env.DB.prepare('SELECT * FROM bitcoin_verification_attempts WHERE proof_id=?').bind(a.proof).all()).results).toHaveLength(3);
});
it('不正OTSはINVALID_OTS/OTS_PARSEを返してfetchせず既存OTSを保持',async()=>{
 const a=await anchoredProof();await env.DB.prepare('UPDATE proofs SET ots_proof=? WHERE id=?').bind('invalid',a.proof).run();
 const spy=vi.spyOn(globalThis,'fetch'),response=await recheck(a.proof,{...bindings,BITCOIN_API_BASE_URL:'https://bitcoin.test/api'});
 expect(response.status).toBe(200);expect(await response.json()).toMatchObject({verificationStatus:'VERIFY_FAILED',failureStage:'OTS_PARSE',errorCode:'INVALID_OTS'});
 expect(spy).not.toHaveBeenCalled();expect((await env.DB.prepare('SELECT ots_proof FROM proofs WHERE id=?').bind(a.proof).first<any>()).ots_proof).toBe('invalid');
});
it('Calendar upgrade後にBitcoin検証が失敗しても元のOTSを上書きしない',async()=>{
 const receipt=(env as unknown as {TEST_OTS:string}).TEST_OTS,digest=Buffer.from(receipt,'base64').subarray(33,65).toString('hex');
 const a=await newAsset('OWNER','DRAFT',digest);
 await env.DB.prepare("UPDATE proofs SET ots_proof=?,timestamp_created_at=?,proof_status='WAITING_BITCOIN' WHERE id=?").bind(receipt,'2026-01-01T00:00:00.000Z',a.proof).run();
 const calls=vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
  if(String(input).includes('/timestamp/'))return new Response(Buffer.from('08000588960d73d719010101','hex'));
  const call=JSON.parse(init!.body as string);return Response.json({error:null,result:call.method==='getblockhash'?(call.params[0]===0?'000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f':'b'.repeat(64)):{height:1,confirmations:6,time:1700000000,merkleroot:'0'.repeat(64)}});
 });
 expect(await processProof({...bindings,BITCOIN_RPC_URL:'http://localhost:8332'},a.proof)).toMatchObject({verificationStatus:'VERIFY_FAILED',blockHeight:1,errorCode:'BLOCK_MISMATCH'});
 expect(calls.mock.calls.some(([url])=>String(url).includes('/timestamp/'))).toBe(true);
 expect(await env.DB.prepare('SELECT sha256,ots_proof,timestamp_created_at,bitcoin_confirmed_at FROM proofs WHERE id=?').bind(a.proof).first()).toEqual({sha256:digest,ots_proof:receipt,timestamp_created_at:'2026-01-01T00:00:00.000Z',bitcoin_confirmed_at:null});
});

function detachedReceipt(hash:string,tree:Buffer){return Buffer.concat([Buffer.from('004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e892940108','hex'),Buffer.from(hash,'hex'),tree]).toString('base64');}
function pendingTree(uri='https://alice.btc.calendar.opentimestamps.org'){const payload=Buffer.concat([Buffer.from([uri.length]),Buffer.from(uri)]);return Buffer.concat([Buffer.from('0083dfe30d2ef90c8e','hex'),Buffer.from([payload.length]),payload]);}
it('FINALの旧Version 1をupgradeしてもVersion 2を変更せず、Version 2の再確認もVersion 1を変更しない',async()=>{
 const v1=await newAsset('OWNER','SUBMITTED','7'.repeat(64));
 const v2=await (await req(`/api/assets/${v1.asset}/versions`,{filename:'version-two.wav',size:2,sha256:'8'.repeat(64),status:'DRAFT'})).json() as any;
 const receipt1=detachedReceipt('7'.repeat(64),pendingTree()),receipt2=detachedReceipt('8'.repeat(64),Buffer.from('000588960d73d719010164','hex'));
 for(const [proof,receipt] of [[v1.proof,receipt1],[v2.proof_id,receipt2]])await env.DB.prepare("UPDATE proofs SET ots_proof=?,timestamp_created_at=?,proof_status='WAITING_BITCOIN',timestamp_status='PENDING',bitcoin_status='PENDING' WHERE id=?").bind(receipt,'2026-01-01T00:00:00.000Z',proof).run();
 vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('pending',{status:404}));expect((await req(`/api/asset-versions/${v1.version}/approve`,{})).status).toBe(200);expect((await req(`/api/asset-versions/${v1.version}/finalize`,{})).status).toBe(200);
 expect((await env.DB.prepare('SELECT status FROM asset_version_states WHERE asset_version_id=?').bind(v1.version).first<any>()).status).toBe('FINAL');
 const version1=await env.DB.prepare('SELECT * FROM asset_versions WHERE id=?').bind(v1.version).first();
 const configured={...bindings,BITCOIN_API_BASE_URL:'https://bitcoin.test/api'};vi.restoreAllMocks();const hash2=esploraMock('8'.repeat(64));
 const pendingBefore1=await env.DB.prepare('SELECT * FROM proofs WHERE id=?').bind(v1.proof).first();
 expect(await (await recheck(v2.proof_id,configured)).json()).toMatchObject({verificationStatus:'CONFIRMED',blockHash:hash2});
 expect(await env.DB.prepare('SELECT * FROM proofs WHERE id=?').bind(v1.proof).first()).toEqual(pendingBefore1);
 const before2=await env.DB.prepare('SELECT * FROM proofs WHERE id=?').bind(v2.proof_id).first<any>();expect(before2.bitcoin_status).toBe('CONFIRMED');
 vi.restoreAllMocks();const hash1=esploraMock();
 const logs=vi.spyOn(console,'info').mockImplementation(()=>{});
 const spy=vi.mocked(globalThis.fetch),original=spy.getMockImplementation()!;spy.mockImplementation(async(input,init)=>String(input).includes('/timestamp/')?new Response(Buffer.from('000588960d73d719010164','hex')):original(input,init));
 await env.DB.prepare('UPDATE proofs SET last_retry_at=NULL WHERE id=?').bind(v1.proof).run();
 expect(await (await recheck(v1.proof,configured)).json()).toMatchObject({verificationStatus:'CONFIRMED',blockHeight:100,blockHash:hash1});
 expect(spy.mock.calls.some(([url])=>String(url).includes('/digest'))).toBe(false);
 const after1=await env.DB.prepare('SELECT * FROM proofs WHERE id=?').bind(v1.proof).first<any>();
 expect(after1).toMatchObject({id:v1.proof,asset_version_id:v1.version,sha256:'7'.repeat(64),timestamp_created_at:'2026-01-01T00:00:00.000Z',bitcoin_status:'CONFIRMED'});
 const events=logs.mock.calls.map(([entry])=>JSON.parse(String(entry)));expect(events).toContainEqual(expect.objectContaining({event:'BITCOIN_RECHECK_START',proof_id:v1.proof,asset_version_id:v1.version,version:1}));expect(events).toContainEqual(expect.objectContaining({event:'OTS_LOAD',storage:'D1',r2_key:null,success:true}));expect(events).toContainEqual(expect.objectContaining({event:'OTS_UPGRADE',status:'bitcoin_attestation_found'}));
 expect(parseReceipt(after1.ots_proof,after1.sha256).pending[0].uri).toBe('https://alice.btc.calendar.opentimestamps.org');
 expect(await env.DB.prepare('SELECT * FROM proofs WHERE id=?').bind(v2.proof_id).first()).toEqual(before2);
 expect(await env.DB.prepare('SELECT * FROM asset_versions WHERE id=?').bind(v1.version).first()).toEqual(version1);
 vi.restoreAllMocks();esploraMock('8'.repeat(64));await env.DB.prepare('UPDATE proofs SET last_retry_at=NULL WHERE id=?').bind(v2.proof_id).run();expect(await (await recheck(v2.proof_id,configured)).json()).toMatchObject({verificationStatus:'CONFIRMED',blockHash:hash2});
 expect(await env.DB.prepare('SELECT * FROM proofs WHERE id=?').bind(v1.proof).first()).toEqual(after1);
 const after2=await env.DB.prepare('SELECT * FROM proofs WHERE id=?').bind(v2.proof_id).first<any>();expect(after2).toMatchObject({asset_version_id:v2.id,sha256:'8'.repeat(64),ots_proof:receipt2,timestamp_created_at:'2026-01-01T00:00:00.000Z'});
 for(const [version,proof] of [[v1.version,v1.proof],[v2.id,v2.proof_id]])expect(await (await req(`/api/assets/${v1.asset}/versions/${version}`)).json()).toMatchObject({id:version,proof_id:proof});
});
it('旧VersionのCalendar 404はOTSと元日時を保持してWAITING_BITCOINを返す',async()=>{
 const a=await newAsset(),receipt=detachedReceipt('d'.repeat(64),pendingTree());await env.DB.prepare("UPDATE proofs SET ots_proof=?,timestamp_created_at=?,proof_status='WAITING_BITCOIN' WHERE id=?").bind(receipt,'2026-10-02T02:46:47.385Z',a.proof).run();
 const spy=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('pending',{status:404}));
 expect(await (await recheck(a.proof,{...bindings,BITCOIN_API_BASE_URL:'https://bitcoin.test/api'})).json()).toMatchObject({verificationStatus:'WAITING_BITCOIN',blockHeight:null});
 const p=await env.DB.prepare('SELECT * FROM proofs WHERE id=?').bind(a.proof).first<any>();expect(p).toMatchObject({ots_proof:receipt,timestamp_created_at:'2026-10-02T02:46:47.385Z',bitcoin_status:'PENDING',error_code:null});expect(spy.mock.calls).toHaveLength(1);
});
it('VersionのhashはDBで保護され、異なるVersionのOTSならINVALID_OTSで外部通信しない',async()=>{
 const a=await newAsset('OWNER','DRAFT','d'.repeat(64)),receipt=detachedReceipt('e'.repeat(64),pendingTree());
 await expect(env.DB.prepare('UPDATE proofs SET sha256=? WHERE id=?').bind('e'.repeat(64),a.proof).run()).rejects.toThrow('proof identity is immutable');
 await env.DB.prepare("UPDATE proofs SET ots_proof=?,timestamp_created_at=?,proof_status='WAITING_BITCOIN' WHERE id=?").bind(receipt,'2026-01-01T00:00:00.000Z',a.proof).run();
 const spy=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('must not fetch'));
 expect(await (await recheck(a.proof,bindings)).json()).toMatchObject({verificationStatus:'VERIFY_FAILED',failureStage:'OTS_PARSE',errorCode:'INVALID_OTS'});
 expect(spy).not.toHaveBeenCalled();
 expect(await env.DB.prepare('SELECT id,ots_proof,timestamp_created_at FROM proofs WHERE id=?').bind(a.proof).first()).toEqual({id:a.proof,ots_proof:receipt,timestamp_created_at:'2026-01-01T00:00:00.000Z'});
 expect((await env.DB.prepare('SELECT sha256 FROM asset_versions WHERE id=?').bind(a.version).first<any>()).sha256).toBe('d'.repeat(64));
});
it('確認済み旧Proofの不足ブロック情報は自分の検証履歴から補い、元の証跡を上書きしない',async()=>{
 const a=await anchoredProof();await env.DB.prepare('UPDATE proofs SET ots_proof=? WHERE id=?').bind(detachedReceipt('7'.repeat(64),pendingTree()),a.proof).run();await env.DB.prepare("UPDATE proofs SET proof_status='CONFIRMED',bitcoin_status='CONFIRMED',timestamp_status='CONFIRMED',bitcoin_confirmed_at=? WHERE id=?").bind('2026-01-02T00:00:00.000Z',a.proof).run();
 const before=await env.DB.prepare('SELECT * FROM proofs WHERE id=?').bind(a.proof).first<any>(),hash=esploraMock(),configured={...bindings,BITCOIN_API_BASE_URL:'https://bitcoin.test/api'};
 const spy=vi.mocked(globalThis.fetch),original=spy.getMockImplementation()!;spy.mockImplementation(async(input,init)=>String(input).includes('/timestamp/')?new Response(Buffer.from('000588960d73d719010164','hex')):original(input,init));
 expect(await (await recheck(a.proof,configured)).json()).toMatchObject({verificationStatus:'CONFIRMED',blockHash:hash,confirmedAt:before.bitcoin_confirmed_at});
 const view=await (await req(`/api/proofs/${a.proof}`)).json() as any;expect(view).toMatchObject({bitcoin_block_height:100,bitcoin_block_hash:hash,bitcoin_block_time:'2023-11-14T22:13:20.000Z',failure_stage:null});expect(view.last_checked_at).toBeTruthy();
 const raw=await env.DB.prepare('SELECT * FROM proofs WHERE id=?').bind(a.proof).first<any>();for(const key of ['ots_proof','timestamp_created_at','bitcoin_confirmed_at','bitcoin_block_height','bitcoin_block_hash','bitcoin_block_time'])expect(raw[key]).toBe(before[key]);
 vi.restoreAllMocks();vi.spyOn(globalThis,'fetch').mockImplementation(async input=>{if(String(input).includes('/timestamp/'))return new Response(Buffer.from('000588960d73d719010164','hex'));throw new DOMException('timeout','TimeoutError');});await env.DB.prepare('UPDATE proofs SET last_retry_at=NULL WHERE id=?').bind(a.proof).run();await recheck(a.proof,configured);
 expect(await (await req(`/api/proofs/${a.proof}`)).json()).toMatchObject({bitcoin_block_hash:hash,failure_stage:'NETWORK_CHECK'});
});
it('複数Calendarの最初が失敗しても次のCalendarで既存OTSをupgradeする',async()=>{
 const a=await newAsset(),tree=Buffer.concat([Buffer.from([255]),pendingTree(),pendingTree('https://bob.btc.calendar.opentimestamps.org')]),receipt=detachedReceipt('d'.repeat(64),tree);
 await env.DB.prepare("UPDATE proofs SET ots_proof=?,timestamp_created_at=?,proof_status='WAITING_BITCOIN' WHERE id=?").bind(receipt,'2026-01-01T00:00:00.000Z',a.proof).run();
 const spy=vi.spyOn(globalThis,'fetch').mockImplementation(async input=>{if(String(input).startsWith('https://alice.'))throw new TypeError('offline');if(String(input).startsWith('https://bob.'))return new Response(Buffer.from('000588960d73d719010164','hex'));throw new Error('must not restamp');});
 expect(await processProof(bindings,a.proof)).toMatchObject({verificationStatus:'BITCOIN_ANCHOR_FOUND',blockHeight:100});expect(spy.mock.calls).toHaveLength(2);
 const p=await env.DB.prepare('SELECT * FROM proofs WHERE id=?').bind(a.proof).first<any>();expect(p.timestamp_created_at).toBe('2026-01-01T00:00:00.000Z');expect(parseReceipt(p.ots_proof,p.sha256).attestations[0].height).toBe(100);
});
it('OTSがない旧Versionに作る証跡は現在の作成日時を持ち、最新Versionを変更しない',async()=>{
 const a=await newAsset('OWNER','DRAFT','9'.repeat(64)),v2=await (await req(`/api/assets/${a.asset}/versions`,{filename:'latest.wav',size:2,sha256:'a'.repeat(64)})).json() as any;
 const before2=await env.DB.prepare('SELECT * FROM proofs WHERE id=?').bind(v2.proof_id).first(),versionBefore=await env.DB.prepare('SELECT * FROM asset_versions WHERE id=?').bind(a.version).first();let root='';
 const spy=vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
  if(String(input).endsWith('/digest')){root=Buffer.from(init!.body as Uint8Array).reverse().toString('hex');return new Response(Buffer.from('000588960d73d719010164','hex'));}
  const call=JSON.parse(init!.body as string);return Response.json({error:null,result:call.method==='getblockhash'?(call.params[0]===0?'000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f':'b'.repeat(64)):{height:100,confirmations:6,time:1700000000,merkleroot:root}});
 });
 const started=Date.now();expect(await processProof({...bindings,BITCOIN_RPC_URL:'http://localhost:8332'},a.proof)).toMatchObject({verificationStatus:'CONFIRMED'});
 const p=await env.DB.prepare('SELECT * FROM proofs WHERE id=?').bind(a.proof).first<any>();expect(Date.parse(p.timestamp_created_at)).toBeGreaterThanOrEqual(started);expect(p.asset_version_id).toBe(a.version);expect(p.sha256).toBe('9'.repeat(64));expect(spy.mock.calls.filter(([url])=>String(url).endsWith('/digest'))).toHaveLength(1);
 expect(await env.DB.prepare('SELECT * FROM proofs WHERE id=?').bind(v2.proof_id).first()).toEqual(before2);expect(await env.DB.prepare('SELECT * FROM asset_versions WHERE id=?').bind(a.version).first()).toEqual(versionBefore);
});
