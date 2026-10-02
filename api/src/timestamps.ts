import {createHash} from 'node:crypto';
import {parseReceipt} from './proof';
import {bitcoinConfigured,verifyBitcoinChain,BitcoinError,bitcoinLog,type BitcoinResult,type FailureStage} from './bitcoin';
import {Store,type Bindings} from './store';
import {HttpError,id,now} from './domain';
const calendars=['https://a.pool.opentimestamps.org','https://b.pool.opentimestamps.org'];
// Pool submission can return a canonical calendar URI rather than the pool URI.
const upgradeCalendars=[...calendars,'https://alice.btc.calendar.opentimestamps.org','https://bob.btc.calendar.opentimestamps.org','https://finney.calendar.eternitywall.com'];
const encode=(bytes:Uint8Array)=>Buffer.from(bytes).toString('base64');
export type VerificationOutcome={verificationStatus:string;blockHeight:number|null;blockHash?:string;blockTime?:string|null;confirmedAt?:string|null;failureStage?:FailureStage;errorCode?:string};
async function calendar(url:string,body?:Uint8Array):Promise<Uint8Array>{
 const response=await fetch(url,{method:body?'POST':'GET',headers:{Accept:'application/vnd.opentimestamps.v1','Content-Type':'application/octet-stream'},...(body?{body:body as unknown as BodyInit}:{}),signal:AbortSignal.timeout(15000)});
 if(!response.ok)throw new HttpError(response.status===404?404:503,'Calendar unavailable');
 if(Number(response.headers.get('content-length'))>1000000)throw new HttpError(503,'Calendar response too large');
 const reader=response.body!.getReader(),parts:Uint8Array[]=[];let total=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>1000000)throw new HttpError(503,'Calendar response too large');parts.push(value);}}finally{await reader.cancel();}
 return Buffer.concat(parts);
}
async function upgradeReceipt(receipt:string,sha256:string,proofId:string){
 let parsed=parseReceipt(receipt,sha256);
 if(parsed.attestations.length)return {receipt,parsed};
 const targets=parsed.pending.filter(p=>upgradeCalendars.includes(p.uri)).slice(0,3).map(p=>({uri:p.uri,message:p.message}));
 let reachable=false,lastError:unknown;
 for(const target of targets){
  const pending=parsed.pending.find(p=>p.uri===target.uri&&p.message===target.message);if(!pending)continue;
  try{
   const tree=await calendar(`${pending.uri}/timestamp/${pending.message}`);
   const candidate=encode(Buffer.concat([parsed.bytes.slice(0,pending.lastEntryStart),Buffer.from([255]),parsed.bytes.slice(pending.lastEntryStart,pending.treeEnd),tree,parsed.bytes.slice(pending.treeEnd)]));
   const upgraded=parseReceipt(candidate,sha256);receipt=candidate;parsed=upgraded;reachable=true;
   bitcoinLog('OTS_UPGRADE',{proof_id:proofId,calendar:pending.uri,status:parsed.attestations.length?'bitcoin_attestation_found':'upgraded',http_status:200});
   if(parsed.attestations.length)break;
  }catch(error){if(error instanceof HttpError&&error.status===404){bitcoinLog('OTS_UPGRADE',{proof_id:proofId,calendar:pending.uri,status:'pending',http_status:404});reachable=true;continue;}bitcoinLog('OTS_UPGRADE',{proof_id:proofId,calendar:pending.uri,status:'failed',error_type:error instanceof Error?error.name:'UNKNOWN'});lastError=error;}
 }
 // Calendar 404 means this existing receipt has not anchored yet, not failure.
 if(lastError&&!reachable&&!parsed.attestations.length)throw lastError;
 return {receipt,parsed};
}
export async function processProof(env:Bindings,proofId:string,actor:string|null=null,reverify=false):Promise<VerificationOutcome|undefined>{
 const s=new Store(env),time=now(),lease=new Date(Date.now()+120000).toISOString();
 const proof=await s.sql("UPDATE proofs SET lease_until=?,retry_count=retry_count+1,last_retry_at=?,updated_at=? WHERE id=? AND (proof_status!='CONFIRMED' OR ?=1) AND (lease_until IS NULL OR lease_until<?) AND (last_retry_at IS NULL OR last_retry_at<?) RETURNING *",lease,time,time,proofId,reverify?1:0,time,new Date(Date.now()-60000).toISOString()).first<{id:string;asset_version_id:string;sha256:string;ots_proof:string|null;timestamp_created_at:string|null;proof_status:string}>();
 if(!proof){const item=await s.sql('SELECT proof_status FROM proofs WHERE id=?',proofId).first<{proof_status:string}>();if(!item)throw new HttpError(404,'証跡が見つかりません');if(item.proof_status==='CONFIRMED'&&!reverify)return;throw new HttpError(409,'処理中、または再試行間隔が短すぎます');}
 let failureCode='TIMESTAMP_PROCESSING_FAILED';
 try{
  const version=await s.sql('SELECT version,sha256 FROM asset_versions WHERE id=?',proof.asset_version_id).first<{version:number;sha256:string}>();
  bitcoinLog('BITCOIN_RECHECK_START',{proof_id:proofId,asset_version_id:proof.asset_version_id,version:version?.version??null});
  // The selected proof must commit to its own version, even if both OTS and
  // proof.sha256 were accidentally changed to another version's digest.
  failureCode='INVALID_OTS';
  if(!version||version.sha256!==proof.sha256)throw new Error('Version digest mismatch');
  bitcoinLog('OTS_LOAD',{proof_id:proofId,storage:'D1',r2_key:null,success:!!proof.ots_proof});
  if(proof.ots_proof){try{const parsed=parseReceipt(proof.ots_proof,version.sha256);bitcoinLog('OTS_PARSE',{proof_id:proofId,success:true,pending_count:parsed.pending.length,bitcoin_attestation_count:parsed.attestations.length});}catch(error){bitcoinLog('OTS_PARSE',{proof_id:proofId,success:false,error_type:'INVALID_OTS'});throw error;}}
  failureCode='TIMESTAMP_PROCESSING_FAILED';
  const acquired=await s.sql('INSERT INTO timestamp_leases VALUES(?,?,?) ON CONFLICT(sha256) DO UPDATE SET lease_until=excluded.lease_until,owner=excluded.owner WHERE timestamp_leases.lease_until<? RETURNING owner',proof.sha256,lease,proofId,time).first();
  if(!acquired)throw new HttpError(409,'同じSHA-256の証跡を処理中です');
  if(proof.proof_status==='CONFIRMED'){failureCode='INVALID_OTS';if(!proof.ots_proof)throw new Error('Missing receipt');parseReceipt(proof.ots_proof,proof.sha256);failureCode='OTS_UPGRADE_FAILED';const {parsed}=await upgradeReceipt(proof.ots_proof,proof.sha256,proofId);failureCode='VERIFY_FAILED';return await verifyAndRecord(env,proofId,parsed,actor,true);}
  let receipt=proof.ots_proof;
  if(!receipt){
   const existing=await s.sql('SELECT ots_proof,timestamp_created_at FROM proofs WHERE sha256=? AND ots_proof IS NOT NULL ORDER BY timestamp_created_at LIMIT 1',proof.sha256).first<{ots_proof:string;timestamp_created_at:string}>();
   if(existing){receipt=existing.ots_proof;await s.sql('UPDATE proofs SET ots_proof=?,timestamp_created_at=? WHERE id=?',receipt,existing.timestamp_created_at,proofId).run();}
   else{
    failureCode='OTS_CREATION_FAILED';
    // Serialize a detached SHA-256 receipt with a random nonce before submitting.
    const nonce=crypto.getRandomValues(new Uint8Array(16));
    const commitment=new Uint8Array(createHash('sha256').update(Buffer.concat([Buffer.from(proof.sha256,'hex'),nonce])).digest());
    let tree:Uint8Array|null=null;
    for(const uri of calendars){try{tree=await calendar(`${uri}/digest`,commitment);break;}catch{}}
    if(!tree)throw new HttpError(503,'Timestamp作成に失敗しました');
    receipt=encode(Buffer.concat([Buffer.from('004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e892940108','hex'),Buffer.from(proof.sha256,'hex'),Buffer.from([0xf0,16]),nonce,Buffer.from([8]),tree]));
    parseReceipt(receipt,proof.sha256);
    await env.DB.batch([s.sql("UPDATE proofs SET ots_proof=?,timestamp_created_at=?,proof_status='STAMPED',timestamp_status='PENDING',bitcoin_status='PENDING' WHERE id=?",receipt,now(),proofId),audit('OTS_CREATED')]);
   }
  }
  failureCode='INVALID_OTS';
  parseReceipt(receipt,proof.sha256);failureCode='OTS_UPGRADE_FAILED';
  const upgraded=await upgradeReceipt(receipt,proof.sha256,proofId);receipt=upgraded.receipt;const parsed=upgraded.parsed;
  failureCode='VERIFY_FAILED';
  const outcome=await verifyAndRecord(env,proofId,parsed,actor,false,receipt);
  // Only persist a Calendar upgrade after a successful or pending check.
  // A failed Bitcoin check must leave the stored receipt byte-for-byte intact.
  if(outcome.verificationStatus!=='VERIFY_FAILED'&&receipt!==proof.ots_proof)await s.sql("UPDATE proofs SET ots_proof=?,updated_at=? WHERE id=? AND proof_status!='CONFIRMED'",receipt,now(),proofId).run();
  return outcome;

 }catch(error){
  if(error instanceof HttpError&&error.status===409)throw error;
  const stage:FailureStage=failureCode==='INVALID_OTS'?'OTS_PARSE':failureCode==='OTS_CREATION_FAILED'?'OTS_CREATE':failureCode==='OTS_UPGRADE_FAILED'?'OTS_UPGRADE':'VERIFY';
  bitcoinLog('BITCOIN_VERIFY_FAILED',{proof_id:proofId,block_height:null,failure_stage:stage,error_type:failureCode});
  return await recordVerification(env,proofId,actor,'VERIFY_FAILED',null,failureCode,proof.proof_status==='CONFIRMED',null,new BitcoinError(failureCode,'検証に失敗しました',stage));
 }finally{await env.DB.batch([s.sql('UPDATE proofs SET lease_until=NULL WHERE id=? AND lease_until=?',proofId,lease),s.sql('UPDATE timestamp_leases SET lease_until=? WHERE sha256=? AND owner=?','1970-01-01T00:00:00.000Z',proof.sha256,proofId)]);}
 function audit(event:string){return s.sql('INSERT INTO audit_events(project_id,actor_user_id,event_type,target_type,target_id,created_at) SELECT a.project_id,?,?,?,pr.id,? FROM proofs pr JOIN asset_versions v ON v.id=pr.asset_version_id JOIN assets a ON a.id=v.asset_id WHERE pr.id=?',actor,event,'proof',now(),proofId);}
}
export async function refreshProofs(env:Bindings){
 const rows=await new Store(env).sql("SELECT id,proof_status FROM proofs WHERE (proof_status IN ('WAITING_BITCOIN','STAMPED') OR (proof_status='FAILED' AND retry_count<10) OR (proof_status='CONFIRMED' AND (last_retry_at IS NULL OR last_retry_at<strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')))) AND (last_retry_at IS NULL OR last_retry_at<?) ORDER BY last_retry_at LIMIT 3",new Date(Date.now()-3600000).toISOString()).all<{id:string;proof_status:string}>();
 for(const row of rows.results)try{await processProof(env,row.id,null,row.proof_status==='CONFIRMED');}catch{}
}

type VerificationState='OTS_CREATED'|'WAITING_BITCOIN'|'BITCOIN_ANCHOR_FOUND'|'BITCOIN_VERIFIED'|'VERIFY_FAILED';
async function recordVerification(env:Bindings,proofId:string,actor:string|null,state:VerificationState,result:BitcoinResult|null,error:string|null,immutable:boolean,anchorHeight:number|null=null,failure:BitcoinError|null=null,receipt?:string):Promise<VerificationOutcome>{
 const s=new Store(env),time=now(),statements=[s.sql('INSERT INTO bitcoin_verification_attempts(id,proof_id,actor_user_id,state,provider,block_height,block_hash,block_time,confirmations,error_code,checked_at,failure_stage,error_type,http_status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',id(),proofId,actor,state,result?.provider??(env.BITCOIN_API_BASE_URL?'ESPLORA':env.BITCOIN_RPC_URL?'RPC':null),result?.height??anchorHeight,result?.hash??null,result?.blockTime??null,result?.confirmations??null,error,time,failure?.failureStage??null,error,failure?.httpStatus??null)];
 if(!immutable){
  if(result){if(receipt)statements.push(s.sql("UPDATE proofs SET ots_proof=? WHERE id=? AND proof_status!='CONFIRMED'",receipt,proofId));statements.push(s.sql("UPDATE proofs SET proof_status='CONFIRMED',timestamp_status='CONFIRMED',bitcoin_status='CONFIRMED',bitcoin_verification_state='BITCOIN_VERIFIED',bitcoin_confirmed_at=?,bitcoin_block=?,bitcoin_block_height=?,bitcoin_block_hash=?,bitcoin_block_time=?,timestamp=?,updated_at=?,error_code=NULL,error_message=NULL WHERE id=? AND proof_status!='CONFIRMED'",time,result.height,result.height,result.hash,result.blockTime,time,time,proofId));}
  else statements.push(s.sql("UPDATE proofs SET proof_status=CASE WHEN ots_proof IS NULL THEN 'FAILED' ELSE 'WAITING_BITCOIN' END,bitcoin_verification_state=?,bitcoin_status=CASE WHEN ?='VERIFY_FAILED' THEN 'FAILED' ELSE 'PENDING' END,error_code=?,error_message=?,updated_at=? WHERE id=? AND proof_status!='CONFIRMED'",state,state,error,error?'Bitcoinの再確認に失敗しました。作成済みの証跡は保持しています。':null,time,proofId));
 }
 const event=result?(immutable?'BITCOIN_REVERIFIED':'BITCOIN_CONFIRMED'):state==='VERIFY_FAILED'?'BITCOIN_VERIFY_FAILED':state==='BITCOIN_ANCHOR_FOUND'?'BITCOIN_ANCHOR_FOUND':'BITCOIN_VERIFICATION_PENDING';
 statements.push(s.sql('INSERT INTO audit_events(project_id,actor_user_id,event_type,target_type,target_id,metadata_json,created_at) SELECT a.project_id,?,?,?,pr.id,?,? FROM proofs pr JOIN asset_versions v ON v.id=pr.asset_version_id JOIN assets a ON a.id=v.asset_id WHERE pr.id=?',actor,event,'proof',JSON.stringify({state,block_height:result?.height??anchorHeight,block_hash:result?.hash??null,error_code:error}),time,proofId));
 await env.DB.batch(statements);
 if(result){bitcoinLog('BITCOIN_VERIFY_SUCCESS',{proof_id:proofId,block_height:result.height});const original=immutable?await s.sql('SELECT bitcoin_confirmed_at FROM proofs WHERE id=?',proofId).first<{bitcoin_confirmed_at:string|null}>():null;return {verificationStatus:'CONFIRMED',blockHeight:result.height,blockHash:result.hash,blockTime:result.blockTime,confirmedAt:immutable?original?.bitcoin_confirmed_at??null:time};}
 return {verificationStatus:state,blockHeight:anchorHeight,...(error?{failureStage:failure?.failureStage??'VERIFY',errorCode:error}:{})};
}
async function verifyAndRecord(env:Bindings,proofId:string,parsed:ReturnType<typeof parseReceipt>,actor:string|null,immutable:boolean,receipt?:string):Promise<VerificationOutcome>{
 if(!parsed.attestations.length)return recordVerification(env,proofId,actor,parsed.pending.length?'WAITING_BITCOIN':'OTS_CREATED',null,null,immutable);
 const anchors=parsed.attestations.slice(0,2);
 if(!bitcoinConfigured(env))return recordVerification(env,proofId,actor,'BITCOIN_ANCHOR_FOUND',null,null,immutable,anchors[0].height);
 let failure=new BitcoinError('VERIFY_FAILED','検証に失敗しました'),failedHeight=anchors[0].height;
 for(const anchor of anchors){
  let result:BitcoinResult;
  try{result=await verifyBitcoinChain(anchor,env,proofId);}catch(error){failure=error instanceof BitcoinError?error:new BitcoinError('VERIFY_FAILED','検証に失敗しました');failedHeight=anchor.height;continue;}
  return recordVerification(env,proofId,actor,'BITCOIN_VERIFIED',result,null,immutable,null,null,receipt);
 }
 return recordVerification(env,proofId,actor,'VERIFY_FAILED',null,failure.code,immutable,failedHeight,failure);
}
