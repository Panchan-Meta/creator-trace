// Small internal CLI. PII/outbox is written only to an explicit private output file.
const fs=require('node:fs');
const crypto=require('node:crypto');
const base=(process.env.PUNKA_API_URL||'http://localhost:8787').replace(/\/$/,'');
const [command,target,extra]=process.argv.slice(2);
async function request(path,body,human=false){
 const token=process.env[human?'PUNKA_APPROVAL_TOKEN':'OPERATOR_TOKEN'];
 if(!token)throw new Error(`${human?'PUNKA_APPROVAL_TOKEN':'OPERATOR_TOKEN'}を設定してください`);
 const res=await fetch(base+path,{headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body!==undefined?{method:'POST',body:JSON.stringify(body)}:{})});
 const data=await res.json();if(!res.ok)throw new Error(data.error);return data;
}
async function main(){
 if(command==='import'){
  if(!target||!extra)throw new Error('ops import file.csv issuer-name（PUNKA_ISSUER_IDを固定してください）');
  const issuerId=process.env.PUNKA_ISSUER_ID;if(!issuerId)throw new Error('PUNKA_ISSUER_IDをUUIDで設定してください');
  return request('/api/issuance-batches',{filename:require('node:path').basename(target),csv:fs.readFileSync(target,'utf8'),issuer:{id:issuerId,name:extra}});
 }
 if(['validate','issue','status','reject','approve'].includes(command)){
  if(!target)throw new Error('Batch IDが必要です');
  if(command==='approve' && extra!=='--compliance-reviewed')throw new Error('Punkaが同意・PII・発行条件を確認後、--compliance-reviewedを指定してください');
  return request(`/api/issuance-batches/${encodeURIComponent(target)}${command==='status'?'':'/'+command}`,command==='status'?undefined:command==='approve'?{approver:'Punka',consentConfirmed:true,issuanceConditionsConfirmed:true,piiReviewed:true}:{},['approve','reject','issue'].includes(command));
 }
 if(command==='revoke'){
  if(!target||!extra)throw new Error('ops revoke certificateId "理由"（Punka専用）');
  return request(`/api/certificates/${encodeURIComponent(target)}/revoke`,{approver:'Punka',reason:extra,revocationConditionsConfirmed:true},true);
 }
 if(command==='audit')return request('/api/internal/audit-logs');
 if(command==='outbox'){
  if(!target)throw new Error('PIIを保存する出力ファイルを指定してください');
  const data=await request('/api/internal/notifications');fs.writeFileSync(target,JSON.stringify(data,null,2),{mode:0o600,flag:'wx'});return {exported:data.length,file:target,status:'PENDING（配信済みとは扱いません）'};
 }
 if(command==='notification-sent')return request(`/api/internal/notifications/${encodeURIComponent(target)}`,{status:'SENT'});
 if(command==='uuid')return {id:crypto.randomUUID()};
 throw new Error('commands: uuid / import / validate / status / approve / reject / issue / revoke / audit / outbox / notification-sent');
}
main().then(data=>console.log(JSON.stringify(data,null,2))).catch(e=>{console.error(e.message);process.exitCode=1;});
