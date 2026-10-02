import {createHash} from 'node:crypto';
import {HttpError} from './domain';
const hex=(b:Uint8Array)=>Buffer.from(b).toString('hex');
class Reader {
 offset=0; constructor(public data:Uint8Array){}
 read(n:number){if(n<0||this.offset+n>this.data.length)throw new HttpError(400,'OTSが不正です');const v=this.data.slice(this.offset,this.offset+n);this.offset+=n;return v;}
 byte(){return this.read(1)[0];}
 uint(){let value=0;for(let n=0;n<5;n++){const b=this.byte();value+=(b&127)*2**(n*7);if(!(b&128))return value;}throw new HttpError(400,'OTS整数が不正です');}
 variable(max:number){const n=this.uint();if(n>max)throw new HttpError(400,'OTS長が不正です');return this.read(n);}
}
export function parseReceipt(receipt:string,expected:string){
 let bytes:Uint8Array;try{bytes=Uint8Array.from(atob(receipt),c=>c.charCodeAt(0));}catch{throw new HttpError(400,'OTSが不正です');}
 if(bytes.length>1_000_000)throw new HttpError(400,'OTSが大きすぎます');
 const r=new Reader(bytes),magic='004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294';
 if(hex(r.read(31))!==magic || r.uint()!==1 || r.byte()!==8 || hex(r.read(32))!==expected)throw new HttpError(400,'OTSの対象hashが一致しません');
 const attestations:{height:number;merkleRoot:string}[]=[];
 const pending:{uri:string;message:string;start:number;end:number;treeStart:number;treeEnd:number;lastEntryStart:number}[]=[];let nodes=0;
 function tree(message:Uint8Array,depth:number){
  const treeStart=r.offset,localPending:typeof pending=[];
  if(depth>128||++nodes>20000||message.length>4096)throw new HttpError(400,'OTSが複雑すぎます');
  function entry(tag:number){
   if(tag===0){const start=r.offset-1,kind=hex(r.read(8)),payload=r.variable(8192);if(kind==='0588960d73d71901'){const p=new Reader(payload),height=p.uint();if(p.offset!==payload.length||message.length!==32)throw new HttpError(400,'Bitcoin attestationが不正です');attestations.push({height,merkleRoot:hex(message.slice().reverse())});}else if(kind==='83dfe30d2ef90c8e'){const p=new Reader(payload),uri=new TextDecoder().decode(p.variable(2048));if(p.offset!==payload.length)throw new HttpError(400,'Calendar attestationが不正です');const item={uri,message:hex(message),start,end:r.offset,treeStart,treeEnd:0,lastEntryStart:0};pending.push(item);localPending.push(item);}return;}
   let result:Uint8Array;
   if(tag===0xf0||tag===0xf1){const arg=r.variable(4096);if(!arg.length)throw new HttpError(400,'OTS操作が不正です');result=tag===0xf0?new Uint8Array([...message,...arg]):new Uint8Array([...arg,...message]);}
   else if(tag===0xf2)result=message.slice().reverse();
   else if(tag===0xf3)result=new TextEncoder().encode(hex(message));
   else if([2,3,8].includes(tag))result=new Uint8Array(createHash(tag===8?'sha256':tag===3?'ripemd160':'sha1').update(message).digest());
   else throw new HttpError(400,'未対応のOTS操作です');
   tree(result,depth+1);
  }
  let tag=r.byte();while(tag===255){entry(r.byte());tag=r.byte();}const lastEntryStart=r.offset-1;entry(tag);
  for(const item of localPending){item.treeEnd=r.offset;item.lastEntryStart=lastEntryStart;}
 }
 tree(Buffer.from(expected,'hex'),0);
 if(r.offset!==bytes.length)throw new HttpError(400,'OTS末尾が不正です');return {bytes,attestations,pending};
}
export async function verifyBitcoin(attestations:{height:number;merkleRoot:string}[],height:number,rpcURL?:string){
 if(!rpcURL)throw new HttpError(503,'Bitcoin検証用RPCを設定してください');
 const target=attestations.find(a=>a.height===height);if(!target)throw new HttpError(400,'Bitcoin確認前のOTSはconfirmedにできません');
 const {verifyBitcoinChain}=await import('./bitcoin');
 return verifyBitcoinChain(target,{BITCOIN_RPC_URL:rpcURL} as import('./store').Bindings);
}
