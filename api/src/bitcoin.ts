import {createHash} from 'node:crypto';
import type {Bindings} from './store';
export const MAINNET_GENESIS='000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';
export type BitcoinAnchor={height:number;merkleRoot:string};
export type BitcoinResult={height:number;hash:string;blockTime:string|null;confirmations:number;provider:'ESPLORA'|'RPC'};
export type FailureStage='NETWORK_CHECK'|'BLOCK_HASH_LOOKUP'|'BLOCK_HEADER_LOOKUP'|'BLOCK_INFO_LOOKUP'|'CANONICAL_CHECK'|'CONFIRMATIONS_CHECK'|'REORG_CHECK'|'OTS_PARSE'|'OTS_CREATE'|'OTS_UPGRADE'|'VERIFY';
export class BitcoinError extends Error {constructor(public code:string,message:string,public failureStage:FailureStage='VERIFY',public httpStatus:number|null=null){super(message);}}
export function bitcoinLog(event:string,fields:Record<string,string|number|boolean|null>){console.info(JSON.stringify({event,...fields}));}
const fail=(code:string):never=>{throw new BitcoinError(code,'Bitcoinチェーンを検証できませんでした');};
const hash=(value:unknown)=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);
export function bitcoinConfigured(env:Bindings){return !!(env.BITCOIN_API_BASE_URL||env.BITCOIN_RPC_URL);}
async function text(response:Response){
 if(!response.ok)fail('BITCOIN_API_UNAVAILABLE');
 if(Number(response.headers.get('content-length'))>16384)fail('BITCOIN_API_INVALID_RESPONSE');
 const reader=response.body?.getReader();if(!reader)return fail('BITCOIN_API_INVALID_RESPONSE');
 const chunks:Uint8Array[]=[];let length=0;
 try{while(true){const part=await reader.read();if(part.done)break;length+=part.value.length;if(length>16384)fail('BITCOIN_API_INVALID_RESPONSE');chunks.push(part.value);}}finally{await reader.cancel();}
 return Buffer.concat(chunks).toString('utf8').trim();
}
function endpoint(value:string,rpc=false){
 let u:URL;try{u=new URL(value);}catch{return fail('BITCOIN_API_CONFIGURATION_INVALID');}
 if(u.protocol!=='https:'&&!(['localhost','127.0.0.1'].includes(u.hostname)&&u.protocol==='http:'))fail('BITCOIN_API_CONFIGURATION_INVALID');
 if(u.search||u.hash||(!rpc&&(u.username||u.password)))fail('BITCOIN_API_CONFIGURATION_INVALID');
 return u;
}
// The API supplies canonical chain membership. Header hashing and the OTS Merkle root
// are checked locally; this MVP does not independently validate the entire chain.
export async function verifyBitcoinChain(anchor:BitcoinAnchor,env:Bindings,proofId:string|null=null):Promise<BitcoinResult>{
 bitcoinLog('BITCOIN_VERIFY_START',{proof_id:proofId,block_height:anchor.height});
 let stage:FailureStage='VERIFY',httpStatus:number|null=null;
 const signal=AbortSignal.timeout(15000);
 try{
  if(!Number.isSafeInteger(anchor.height)||anchor.height<0||!hash(anchor.merkleRoot))fail('BITCOIN_ANCHOR_INVALID');
  if(env.BITCOIN_API_BASE_URL){
   const base=endpoint(env.BITCOIN_API_BASE_URL).href.replace(/\/$/,'');
   const get=async(path:string)=>{
    httpStatus=null;
    const event=stage==='BLOCK_HASH_LOOKUP'?'BITCOIN_BLOCK_HASH_LOOKUP':stage==='BLOCK_INFO_LOOKUP'?'BITCOIN_BLOCK_INFO_LOOKUP':null;
    try{
     // Workers does not implement redirect:'error'. Do not follow redirects.
     const response=await fetch(base+path,{signal,redirect:'manual',headers:{Accept:'application/json, text/plain'},cache:'no-store'});httpStatus=response.status;
     if(!response.ok){await response.body?.cancel();fail(response.status===429?'RATE_LIMIT':stage==='BLOCK_HASH_LOOKUP'?'BLOCK_HASH_LOOKUP_FAILED':stage==='BLOCK_INFO_LOOKUP'?'BLOCK_INFO_LOOKUP_FAILED':'VERIFY_FAILED');}
     const value=await text(response);
     if(event)bitcoinLog(event,{proof_id:proofId,block_height:anchor.height,http_status:httpStatus,success:true});
     return value;
    }catch(error){if(event)bitcoinLog(event,{proof_id:proofId,block_height:anchor.height,http_status:httpStatus,success:false});throw error;}
   };
   stage='NETWORK_CHECK';
   if(await get('/block-height/0')!==MAINNET_GENESIS)fail('BITCOIN_WRONG_NETWORK');
   stage='BLOCK_HASH_LOOKUP';
   const blockHash=await get(`/block-height/${anchor.height}`);if(!hash(blockHash))fail('BITCOIN_API_INVALID_RESPONSE');
   stage='BLOCK_HEADER_LOOKUP';
   const headerHex=await get(`/block/${blockHash}/header`);if(!/^[0-9a-f]{160}$/.test(headerHex))fail('BITCOIN_API_INVALID_RESPONSE');
   const header=Buffer.from(headerHex,'hex');
   const digest=createHash('sha256').update(createHash('sha256').update(header).digest()).digest().reverse().toString('hex');
   if(digest!==blockHash||header.subarray(36,68).reverse().toString('hex')!==anchor.merkleRoot)fail('BITCOIN_BLOCK_MISMATCH');
   stage='BLOCK_INFO_LOOKUP';
   const block=JSON.parse(await get(`/block/${blockHash}`)) as {id:string;height:number;timestamp:number;merkle_root:string};
   if(!Number.isSafeInteger(block.timestamp)||block.timestamp<0||block.timestamp>8640000000000)fail('BITCOIN_API_INVALID_RESPONSE');
   if(block.id!==blockHash||block.height!==anchor.height||block.merkle_root!==anchor.merkleRoot||block.timestamp!==header.readUInt32LE(68))fail('BITCOIN_BLOCK_MISMATCH');
   stage='CANONICAL_CHECK';
   const status=JSON.parse(await get(`/block/${blockHash}/status`)) as {in_best_chain:boolean};
   if(status.in_best_chain!==true)fail('BITCOIN_NOT_CANONICAL');
   stage='CONFIRMATIONS_CHECK';
   const tipText=await get('/blocks/tip/height');if(!/^\d{1,10}$/.test(tipText))fail('BITCOIN_API_INVALID_RESPONSE');
   const confirmations=Number(tipText)-anchor.height+1;if(confirmations<6)fail('BITCOIN_INSUFFICIENT_CONFIRMATIONS');
   // Detect a reorg while reading the separate endpoints.
   stage='REORG_CHECK';
   if(await get(`/block-height/${anchor.height}`)!==blockHash)fail('BITCOIN_NOT_CANONICAL');
   return {height:anchor.height,hash:blockHash,blockTime:new Date(block.timestamp*1000).toISOString(),confirmations,provider:'ESPLORA'};
  }
  if(!env.BITCOIN_RPC_URL)fail('BITCOIN_API_NOT_CONFIGURED');
  const url=endpoint(env.BITCOIN_RPC_URL!,true),authorization=`Basic ${btoa(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`)}`;url.username='';url.password='';
  async function rpc<T>(method:string,params:unknown[]=[]):Promise<T>{
   httpStatus=null;const event=stage==='BLOCK_HASH_LOOKUP'?'BITCOIN_BLOCK_HASH_LOOKUP':stage==='BLOCK_INFO_LOOKUP'?'BITCOIN_BLOCK_INFO_LOOKUP':null;
   try{const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:authorization},body:JSON.stringify({jsonrpc:'1.0',id:'creator-trace',method,params}),signal,redirect:'manual'});httpStatus=response.status;
    if(!response.ok){await response.body?.cancel();fail(response.status===429?'RATE_LIMIT':stage==='BLOCK_HASH_LOOKUP'?'BLOCK_HASH_LOOKUP_FAILED':stage==='BLOCK_INFO_LOOKUP'?'BLOCK_INFO_LOOKUP_FAILED':'VERIFY_FAILED');}
    const data=JSON.parse(await text(response));if(data.error)fail(stage==='BLOCK_HASH_LOOKUP'?'BLOCK_HASH_LOOKUP_FAILED':stage==='BLOCK_INFO_LOOKUP'?'BLOCK_INFO_LOOKUP_FAILED':'VERIFY_FAILED');
    if(event)bitcoinLog(event,{proof_id:proofId,block_height:anchor.height,http_status:httpStatus,success:true});return data.result;
   }catch(error){if(event)bitcoinLog(event,{proof_id:proofId,block_height:anchor.height,http_status:httpStatus,success:false});throw error;}
  }
  stage='NETWORK_CHECK';
  if(await rpc<string>('getblockhash',[0])!==MAINNET_GENESIS)fail('BITCOIN_WRONG_NETWORK');
  stage='BLOCK_HASH_LOOKUP';
  const blockHash=await rpc<string>('getblockhash',[anchor.height]);if(!hash(blockHash))fail('BITCOIN_API_INVALID_RESPONSE');
  stage='BLOCK_INFO_LOOKUP';
  const block=await rpc<{merkleroot:string;confirmations:number;height:number;time?:number}>('getblockheader',[blockHash,true]);
  if(block.height!==anchor.height||block.merkleroot!==anchor.merkleRoot)fail('BITCOIN_BLOCK_MISMATCH');
  if(!Number.isSafeInteger(block.confirmations)||block.confirmations<6)fail('BITCOIN_INSUFFICIENT_CONFIRMATIONS');
  if(!Number.isSafeInteger(block.time)||block.time!<0||block.time!>8640000000000)fail('BITCOIN_API_INVALID_RESPONSE');
  stage='REORG_CHECK';
  if(await rpc<string>('getblockhash',[anchor.height])!==blockHash)fail('BITCOIN_NOT_CANONICAL');
  return {height:anchor.height,hash:blockHash,blockTime:new Date(block.time!*1000).toISOString(),confirmations:block.confirmations,provider:'RPC'};
 }catch(error){
  const failure=error instanceof BitcoinError?error:new BitcoinError(signal.aborted||(error instanceof Error&&['TimeoutError','AbortError'].includes(error.name))?'TIMEOUT':error instanceof SyntaxError?'VERIFY_FAILED':'NETWORK_ERROR','Bitcoinチェーンを検証できませんでした');
  if(failure.code==='BITCOIN_BLOCK_MISMATCH')failure.code='BLOCK_MISMATCH';
  failure.failureStage=stage;failure.httpStatus=httpStatus;
  bitcoinLog('BITCOIN_VERIFY_FAILED',{proof_id:proofId,block_height:anchor.height,failure_stage:stage,error_type:failure.code,http_status:httpStatus});
  throw failure;
 }
}
