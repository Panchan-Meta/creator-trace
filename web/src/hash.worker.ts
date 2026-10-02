import {sha256} from '@noble/hashes/sha2.js';
self.onmessage=async(event:MessageEvent<File>)=>{
 const file=event.data,hash=sha256.create(),chunkSize=4*1024*1024;
 try{for(let offset=0;offset<file.size;offset+=chunkSize){hash.update(new Uint8Array(await file.slice(offset,offset+chunkSize).arrayBuffer()));self.postMessage({progress:Math.min(100,Math.floor((offset+chunkSize)/file.size*100))});}self.postMessage({hash:Array.from(hash.digest(),b=>b.toString(16).padStart(2,'0')).join(''),progress:100});}catch{self.postMessage({error:'SHA-256計算に失敗しました'});}finally{hash.destroy();}
};
