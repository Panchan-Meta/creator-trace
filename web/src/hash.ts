export function digest(file:File,onProgress:(percent:number)=>void=()=>{}):Promise<string>{
 return new Promise((resolve,reject)=>{const worker=new Worker(new URL('./hash.worker.ts',import.meta.url),{type:'module'});worker.onmessage=e=>{if(e.data.progress!==undefined)onProgress(e.data.progress);if(e.data.hash){worker.terminate();resolve(e.data.hash);}if(e.data.error){worker.terminate();reject(new Error(e.data.error));}};worker.onerror=()=>{worker.terminate();reject(new Error('SHA-256 Workerを開始できません'));};worker.postMessage(file);});
}
