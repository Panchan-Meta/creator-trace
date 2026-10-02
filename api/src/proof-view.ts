import {parseReceipt} from './proof';
import {bitcoinConfigured} from './bitcoin';
import {Store,type Bindings} from './store';
export function isPublicProof(env:Bindings,id:string){return (env.PUBLIC_PROOF_IDS??'').split(',').map(value=>value.trim()).filter(Boolean).includes(id);}
const errorCodes=['OTS_CREATION_FAILED','OTS_UPGRADE_FAILED','OTS_RECEIPT_INVALID','BITCOIN_RPC_NOT_CONFIGURED','BITCOIN_VERIFICATION_FAILED','BITCOIN_API_TIMEOUT','BITCOIN_API_UNAVAILABLE','BITCOIN_API_INVALID_RESPONSE','BITCOIN_API_CONFIGURATION_INVALID','BITCOIN_WRONG_NETWORK','BITCOIN_BLOCK_MISMATCH','BITCOIN_NOT_CANONICAL','BITCOIN_INSUFFICIENT_CONFIRMATIONS','BITCOIN_ANCHOR_INVALID'];
errorCodes.push('BLOCK_HASH_LOOKUP_FAILED','BLOCK_INFO_LOOKUP_FAILED','BLOCK_MISMATCH','NETWORK_ERROR','TIMEOUT','RATE_LIMIT','INVALID_OTS','VERIFY_FAILED');
const safeError=(value:unknown)=>value?(errorCodes.includes(String(value))?value:'TIMESTAMP_PROCESSING_FAILED'):null;
// Expose a summary, never raw receipts, internal errors or configuration credentials.
export function proofVerification(p:Record<string,unknown>,env:Bindings){
 let receiptValid:boolean|null=null,anchors:{height:number;merkle_root:string}[]=[],pending=0;
 if(typeof p.ots_proof==='string'){try{const receipt=parseReceipt(p.ots_proof,String(p.sha256));receiptValid=true;anchors=receipt.attestations.map(a=>({height:a.height,merkle_root:a.merkleRoot}));pending=receipt.pending.length;}catch{receiptValid=false;}}
 let state='UNKNOWN';
 if(p.bitcoin_status==='CONFIRMED'&&p.proof_status==='CONFIRMED')state='BITCOIN_VERIFIED';
 else if(receiptValid===false)state='RECEIPT_INVALID';
 else if(anchors.length&&!bitcoinConfigured(env))state='BITCOIN_ANCHOR_FOUND';
 else if(p.error_code||p.proof_status==='FAILED'||p.bitcoin_verification_state==='VERIFY_FAILED')state='VERIFY_FAILED';
 else if(!p.ots_proof&&p.timestamp_status==='NOT_REQUESTED'&&!p.last_retry_at)state='NOT_REQUESTED';
 else if(anchors.length)state='BITCOIN_ANCHOR_FOUND';
 else if(receiptValid&&pending)state='WAITING_BITCOIN';
 else if(receiptValid)state='OTS_CREATED';
 return {state,has_ots:!!p.ots_proof,receipt_valid:receiptValid,bitcoin_attestation_count:anchors.length,anchors,api_configured:bitcoinConfigured(env),last_checked_at:p.last_retry_at??null,error_code:safeError(p.error_code)};
}
export async function proofVerificationView(p:Record<string,unknown>,env:Bindings){
 const last=await new Store(env).sql('SELECT state,provider,block_height,block_hash,block_time,confirmations,error_code,checked_at,failure_stage,error_type,http_status FROM bitcoin_verification_attempts WHERE proof_id=? ORDER BY checked_at DESC,rowid DESC LIMIT 1',String(p.id)).first<Record<string,unknown>>();
 const success=last?.state==='BITCOIN_VERIFIED'?last:await new Store(env).sql("SELECT block_height,block_hash,block_time,confirmations,checked_at FROM bitcoin_verification_attempts WHERE proof_id=? AND state='BITCOIN_VERIFIED' ORDER BY checked_at DESC,rowid DESC LIMIT 1",String(p.id)).first<Record<string,unknown>>();
 return {...proofVerification(p,env),last_checked_at:last?.checked_at??p.last_retry_at??null,failure_stage:last?.failure_stage??null,last_attempt:last?{...last,error_code:safeError(last.error_code)}:null,last_success:success?{block_height:success.block_height,block_hash:success.block_hash,block_time:success.block_time,confirmations:success.confirmations,checked_at:success.checked_at}:null};
}
export async function proofDetails(p:Record<string,unknown>,env:Bindings){
 const verification=await proofVerificationView(p,env),success=verification.last_success;
 // Supplement old confirmed records from their own immutable attempt history.
 // Never overwrite the original receipt, confirmation time or block metadata.
 return {...p,bitcoin_block_height:p.bitcoin_block_height??success?.block_height??null,bitcoin_block_hash:p.bitcoin_block_hash??success?.block_hash??null,bitcoin_block_time:p.bitcoin_block_time??success?.block_time??null,last_checked_at:verification.last_checked_at,failure_stage:verification.failure_stage,verification};
}
