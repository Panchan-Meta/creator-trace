import type { BotSecrets } from './mcp-policy';
import { z } from 'zod';
import {parseReceipt,verifyBitcoin} from './proof';
import { canonicalPayload, HttpError, id, now, parseCSV, randomToken, sha256, displayStatus } from './domain';
export interface Bindings extends BotSecrets { DB:D1Database; PROOFS:R2Bucket; ASSETS?:Fetcher; APP_ORIGIN:string; RP_ID:string; PUNKA_APPROVAL_TOKEN?:string; OPERATOR_TOKEN?:string; PROOF_VERIFIER_TOKEN?:string; BITCOIN_RPC_URL?:string; }
export type Certificate = {id:string;certificate_id:string;issuer_id:string;course_id:string;recipient_id:string;completed_at:string;issued_at:string;status:'PENDING'|'ACTIVE'|'REVOKED';document_hash:string;issuer:string;course:string;revoked_at:string|null;revocation_reason:string|null;updated_at:string};
export class ProofService {
 constructor(public env:Bindings){}
 sql(query:string,...args:(string|number|null)[]) { return this.env.DB.prepare(query).bind(...args); }
 audit(actor:string,action:string,targetType:string,target:string,metadata:object={}) { return this.sql('INSERT INTO audit_logs VALUES(?,?,?,?,?,?,?,?)',id(),actor==='Punka'?'HUMAN':actor==='recipient'?'USER':'SYSTEM',actor==='recipient'?target:actor,action,targetType,target,JSON.stringify(metadata),now()); }
 async import(input:unknown) {
  const data=z.object({filename:z.string().min(1).max(200),csv:z.string(),issuer:z.object({id:z.string().uuid(),name:z.string().min(1).max(200)})}).parse(input);
  const rows=parseCSV(data.csv), hash=await sha256(data.csv), batchId=id(), time=now();
  if(await this.sql('SELECT id FROM issuance_batches WHERE source_hash=?',hash).first()) throw new HttpError(409,'同じCSVは登録済みです');
  const statements=[this.sql('INSERT INTO issuers VALUES(?,?,?) ON CONFLICT(id) DO NOTHING',data.issuer.id,data.issuer.name,time),this.sql('INSERT INTO issuance_batches(id,issuer_id,source_filename,source_hash,row_count,status,created_at) VALUES(?,?,?,?,?,?,?)',batchId,data.issuer.id,data.filename,hash,rows.length,'UPLOADED',time)];
  for(const row of rows) statements.push(this.sql('INSERT INTO issuance_rows VALUES(?,?,?,?,?,?,?,?)',id(),batchId,row.row_number,row.name,row.email,row.course,row.completed_at,JSON.stringify(row.errors)));
  statements.push(this.audit('operator','CSV_UPLOADED','batch',batchId,{rowCount:rows.length,sourceHash:hash}));
  try { await this.env.DB.batch(statements); } catch { throw new HttpError(409,'CSV登録が競合しました'); }
  return this.batch(batchId);
 }
 async batch(batchId:string) {
  const batch=await this.sql('SELECT * FROM issuance_batches WHERE id=?',batchId).first<{id:string;status:string;issuer_id:string;source_hash:string}>();
  if(!batch) throw new HttpError(404,'Batchが見つかりません');
  const rows=await this.sql('SELECT row_number,errors_json FROM issuance_rows WHERE batch_id=? ORDER BY row_number',batchId).all();
  const certificates=await this.sql('SELECT certificate_id,status FROM certificates WHERE batch_id=?',batchId).all();
  return {...batch,rows:rows.results,certificates:certificates.results};
 }
 async validate(batchId:string) {
  const locked=await this.sql("UPDATE issuance_batches SET status='VALIDATING' WHERE id=? AND status IN ('UPLOADED','FAILED') RETURNING issuer_id",batchId).first<{issuer_id:string}>();
  if(!locked) throw new HttpError(409,'検査可能なBatchではありません');
  try {
   const {results}=await this.sql('SELECT * FROM issuance_rows WHERE batch_id=? ORDER BY row_number',batchId).all<{id:string;email:string;course:string;errors_json:string}>();
   let invalid=0; const statements:D1PreparedStatement[]=[];
   for(const row of results) {
    const errors:string[]=JSON.parse(row.errors_json);
    if(await this.sql('SELECT c.id FROM certificates c JOIN users u ON u.id=c.recipient_id JOIN courses co ON co.id=c.course_id WHERE u.email=? AND co.name=? AND co.issuer_id=?',row.email,row.course,locked.issuer_id).first()) errors.push('既存の修了証があります');
    if(errors.length) invalid++;
    statements.push(this.sql('UPDATE issuance_rows SET errors_json=? WHERE id=?',JSON.stringify(errors),row.id));
   }
   statements.push(this.sql('UPDATE issuance_batches SET valid_count=?,invalid_count=?,status=? WHERE id=? AND status=?',results.length-invalid,invalid,invalid?'FAILED':'READY_FOR_APPROVAL',batchId,'VALIDATING'),this.audit('bot','CSV_VALIDATED','batch',batchId,{invalidCount:invalid}));
   await this.env.DB.batch(statements);
  } catch(error) { await this.sql("UPDATE issuance_batches SET status='FAILED' WHERE id=? AND status='VALIDATING'",batchId).run(); throw error; }
  return this.batch(batchId);
 }
 async approve(batchId:string,input:unknown) {
  const data=z.object({approver:z.literal('Punka'),consentConfirmed:z.literal(true),issuanceConditionsConfirmed:z.literal(true),piiReviewed:z.literal(true)}).parse(input);
  const result=await this.env.DB.batch([this.sql("UPDATE issuance_batches SET status='APPROVED',approved_at=?,approved_by='Punka',compliance_json=? WHERE id=? AND status='READY_FOR_APPROVAL' AND invalid_count=0 RETURNING id",now(),JSON.stringify(data),batchId)]);
  if(!result[0].results.length) throw new HttpError(409,'検査済みのBatchだけ承認できます');
  return this.batch(batchId);
 }
 async reject(batchId:string) {
  const result=await this.sql("UPDATE issuance_batches SET status='REJECTED' WHERE id=? AND status IN ('UPLOADED','READY_FOR_APPROVAL','FAILED') RETURNING id",batchId).first();
  if(!result) throw new HttpError(409,'却下できない状態です');
  return this.batch(batchId);
 }
 async proofStatement(c:Pick<Certificate,'id'|'certificate_id'|'issuer_id'|'course_id'|'issued_at'|'document_hash'>,status:'ACTIVE'|'REVOKED') {
  const payload=canonicalPayload(c,status), proofId=id();
  return {proofId,statement:this.sql('INSERT INTO timestamp_proofs(id,certificate_id,status,created_at,payload_json,payload_hash,certificate_status) VALUES(?,?,?,?,?,?,?)',proofId,c.id,'pending',now(),payload,await sha256(payload),status)};
 }
 async issue(batchId:string) {
  const batch=await this.sql("UPDATE issuance_batches SET status='ISSUING' WHERE id=? AND status='APPROVED' AND approved_by='Punka' RETURNING issuer_id",batchId).first<{issuer_id:string}>();
  if(!batch) {
   const existing=await this.batch(batchId);
   if(existing.status==='COMPLETED') return existing;
   throw new HttpError(409,'Punka承認後だけ発行できます');
  }
  try {
   const {results:rows}=await this.sql('SELECT * FROM issuance_rows WHERE batch_id=? ORDER BY row_number',batchId).all<{name:string;email:string;course:string;completed_at:string;errors_json:string}>();
   const statements:D1PreparedStatement[]=[];
   const recipients=new Map<string,string>(), courses=new Map<string,string>();
   for(const row of rows) {
    if(JSON.parse(row.errors_json).length) throw new HttpError(409,'不正行があります');
    let recipientId=recipients.get(row.email);
    if(!recipientId) { recipientId=(await this.sql('SELECT id FROM users WHERE email=?',row.email).first<{id:string}>())?.id??id(); recipients.set(row.email,recipientId); statements.push(this.sql('INSERT INTO users(id,display_name,email,created_at) VALUES(?,?,?,?) ON CONFLICT(email) WHERE email IS NOT NULL DO NOTHING',recipientId,row.name,row.email,now())); }
    let courseId=courses.get(row.course);
    if(!courseId) { courseId=(await this.sql('SELECT id FROM courses WHERE issuer_id=? AND name=?',batch.issuer_id,row.course).first<{id:string}>())?.id??id(); courses.set(row.course,courseId); statements.push(this.sql('INSERT INTO courses VALUES(?,?,?,?) ON CONFLICT(issuer_id,name) DO NOTHING',courseId,batch.issuer_id,row.course,now())); }
    const cert={id:id(),certificate_id:id(),issuer_id:batch.issuer_id,course_id:courseId,recipient_id:recipientId,issued_at:now(),document_hash:''};
    // Salted private document commitment: name/email never leave D1, dictionary attacks cannot recover them from the hash.
    const salt=randomToken();
    const document=JSON.stringify({certificateId:cert.certificate_id,recipientId,recipientName:row.name,email:row.email,issuerId:batch.issuer_id,courseId,courseName:row.course,completedAt:row.completed_at,issuedAt:cert.issued_at,salt});
    cert.document_hash=await sha256(document);
    statements.push(this.sql("INSERT INTO certificates(id,user_id,title,certificate_type,sha256,created_at,certificate_id,issuer_id,course_id,recipient_id,batch_id,completed_at,issued_at,status,document_hash,updated_at,document_json) VALUES(?,?,?,'completion',?,?,?,?,?,?,?,?,?,'PENDING',?,?,?)",cert.id,recipientId,row.course,cert.document_hash,cert.issued_at,cert.certificate_id,cert.issuer_id,courseId,recipientId,batchId,row.completed_at,cert.issued_at,cert.document_hash,cert.issued_at,document));
    const proof=await this.proofStatement(cert,'ACTIVE'); statements.push(proof.statement,this.audit('bot','PROOF_CREATED','proof',proof.proofId),this.audit('bot','CERTIFICATE_CREATED','certificate',cert.certificate_id));
    const token=randomToken();
    statements.push(this.sql('INSERT INTO enrollment_tokens VALUES(?,?,?,NULL)',await sha256(token),recipientId,new Date(Date.now()+7*86400000).toISOString()));
    statements.push(this.sql("INSERT INTO notifications(id,recipient_id,notification_type,certificate_id,verify_url,registration_url,status,created_at) VALUES(?,?,'CERTIFICATE_ISSUED',?,?,?,'PENDING',?)",id(),recipientId,cert.id,`${this.env.APP_ORIGIN}/verify/${cert.certificate_id}`,`${this.env.APP_ORIGIN}/login#invite=${token}`,now()));
   }
   statements.push(this.sql("UPDATE issuance_batches SET status='COMPLETED',completed_at=? WHERE id=? AND status='ISSUING'",now(),batchId));
   await this.env.DB.batch(statements);
  } catch(error) { await this.sql("UPDATE issuance_batches SET status='FAILED' WHERE id=? AND status='ISSUING'",batchId).run(); throw new HttpError(409,'発行に失敗しました。重複・整合性を確認してください（証明書は削除していません）'); }
  return this.batch(batchId);
 }
 async certificate(publicId:string,recipient?:string) {
  const result=await this.sql(`SELECT c.*,i.name AS issuer,co.name AS course FROM certificates c JOIN issuers i ON i.id=c.issuer_id JOIN courses co ON co.id=c.course_id WHERE c.certificate_id=?${recipient?' AND c.recipient_id=?':''}`,publicId,...(recipient?[recipient]:[])).first<Certificate>();
  if(!result) throw new HttpError(404,'修了証が見つかりません'); return result;
 }
 async publicCertificate(publicId:string,recipient?:string) {
  const c=await this.certificate(publicId,recipient);
  const proofs=await this.sql('SELECT id,status,payload_hash,certificate_status,bitcoin_block,created_at,verified_at FROM timestamp_proofs WHERE certificate_id=? ORDER BY created_at DESC,id DESC',c.id).all();
  const current=proofs.results.find(p=>p.certificate_status===(c.status==='REVOKED'?'REVOKED':'ACTIVE'));
  return {certificate_id:c.certificate_id,issuer:c.issuer,course:c.course,completed_at:c.completed_at,issued_at:c.issued_at,status:c.status,display:displayStatus(c.status),document_hash:c.document_hash,revoked_at:c.revoked_at,proof_status:current?.status??'pending',proofs:proofs.results,last_checked_at:now(),verify_url:`${this.env.APP_ORIGIN}/verify/${c.certificate_id}`};
 }
 async revoke(publicId:string,input:unknown) {
  const {reason}=z.object({approver:z.literal('Punka'),reason:z.string().trim().min(1).max(500),revocationConditionsConfirmed:z.literal(true)}).parse(input);
  const c=await this.certificate(publicId); if(c.status==='REVOKED') return this.publicCertificate(publicId);
  const proof=await this.proofStatement(c,'REVOKED');
  // An optimistic state guard causes the whole transaction to roll back on competing revocations.
  await this.env.DB.batch([
   this.sql("UPDATE certificates SET status='REVOKED',revoked_at=?,revocation_reason=?,updated_at=? WHERE id=? AND status!='REVOKED'",now(),reason,now(),c.id),
   proof.statement,this.audit('Punka','CERTIFICATE_REVOKED','certificate',publicId),this.audit('bot','PROOF_CREATED','proof',proof.proofId)
  ]);
  return this.publicCertificate(publicId);
 }
 async recordProof(proofId:string,input:unknown) {
  const data=z.object({status:z.enum(['pending','confirmed','failed']),receipt:z.string().max(1_500_000).optional(),bitcoinBlock:z.number().int().positive().optional()}).parse(input);
  const proof=await this.sql('SELECT * FROM timestamp_proofs WHERE id=?',proofId).first<{certificate_id:string;certificate_status:string;status:string;r2_key:string|null;payload_hash:string}>();
  if(!proof) throw new HttpError(404,'証明記録が見つかりません');
  if(proof.status==='confirmed') return {status:'confirmed'};
  if(data.status==='confirmed' && (!data.receipt || !data.bitcoinBlock)) throw new HttpError(400,'検証済みOTSとBitcoinブロックが必要です');
  const parsed=data.receipt?parseReceipt(data.receipt,proof.payload_hash):null;
  if(data.status==='confirmed') await verifyBitcoin(parsed!.attestations,data.bitcoinBlock!,this.env.BITCOIN_RPC_URL);
  const key=data.receipt?`punka/${proofId}/${id()}.ots`:proof.r2_key;
  if(data.receipt) await this.env.PROOFS.put(key!,parsed!.bytes);
  const statements=[this.sql("UPDATE timestamp_proofs SET status=?,r2_key=?,bitcoin_block=?,verified_at=?,error_code=? WHERE id=? AND status!='confirmed'",data.status,key,data.bitcoinBlock??null,data.status==='confirmed'?now():null,data.status==='failed'?'OTS_PROCESSING_FAILED':null,proofId)];
  if(data.status==='confirmed' && proof.certificate_status==='ACTIVE') {
   const cert=await this.sql("SELECT certificate_id FROM certificates WHERE id=? AND status='PENDING'",proof.certificate_id).first<{certificate_id:string}>();
   if(cert) statements.push(this.sql("UPDATE certificates SET status='ACTIVE',updated_at=? WHERE id=? AND status='PENDING'",now(),proof.certificate_id));
  }
  await this.env.DB.batch(statements); return {status:data.status};
 }
}
