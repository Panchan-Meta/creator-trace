import { z } from 'zod';
import { HttpError, id, now, sha256 } from './domain';
import { ProofService, type Bindings } from './service';
import { bots, allowedTools, type Bot } from './mcp-policy';
const versions = ['2025-11-25','2025-06-18','2025-03-26'];
const uuid = z.string().uuid();
const batchInput = z.object({batch_id:uuid}).strict();
const certificateInput = z.object({certificate_id:uuid}).strict();
// Controlled vocabulary: reviews cannot carry names, emails or raw CSV to other bots.
const reviewInput = batchInput.extend({
 result:z.enum(['pass','concern','needs_human_review']),risk_level:z.enum(['low','medium','high']),
 recommendation:z.enum(['continue_review','hold','escalate_to_punka']),
 summary:z.enum(['checks_passed','issues_detected','insufficient_evidence','human_decision_required']),
 issues:z.array(z.enum(['validation','duplicate','authentication','consent','pii_exposure','notification','proof_pending','workflow'])).max(8),
 model:z.string().regex(/^[a-zA-Z0-9._-]{1,80}$/),prompt_version:z.string().regex(/^[a-zA-Z0-9._-]{1,40}$/)
}).strict();
function audit(s:ProofService,agent:string|null,action:string,tool?:string) {
 return s.sql('INSERT INTO audit_logs VALUES(?,?,?,?,?,?,?,?)',id(),'SYSTEM',agent,action,'mcp','mcp',JSON.stringify(tool?{tool}:{}),now());
}
async function authenticate(request:Request,env:Bindings,path:string,s:ProofService):Promise<Bot> {
 const header=request.headers.get('Authorization');
 const digest=await sha256(header??'');
 const matches=await Promise.all(bots.map(async bot=>({bot,match:!!env[bot.secret] && !!header && digest===await sha256(`Bearer ${env[bot.secret]}`)})));
 const matched=matches.filter(x=>x.match);
 if(matched.length!==1) {await audit(s,null,'MCP_AUTH_FAILED').run();throw new HttpError(401,'Authentication required');}
 const bot=matched[0].bot;
 const reserved=[env.OPERATOR_TOKEN,env.PUNKA_APPROVAL_TOKEN,env.PROOF_VERIFIER_TOKEN];
 if(reserved.some(token=>token && token===env[bot.secret])) {await audit(s,null,'MCP_AUTH_FAILED').run();throw new HttpError(401,'Separate bot credentials required');}
 const binding=await s.sql('SELECT internal_agent_id,role,credential_key_id,enabled FROM bot_bindings WHERE credential_key_id=?',bot.secret).first<{internal_agent_id:string;role:string;credential_key_id:string;enabled:number}>();
 if(!binding || !binding.enabled || binding.internal_agent_id!==bot.id || binding.role!==bot.role || path!==`/mcp/${bot.path}`) {
  await audit(s,bot.id,'MCP_AUTH_FAILED').run();throw new HttpError(403,'Bot binding denied');
 }
 await audit(s,bot.id,'MCP_AUTH_SUCCEEDED').run();return bot;
}
async function execute(s:ProofService,bot:Bot,tool:string,input:unknown):Promise<unknown> {
 if(['get_certificate_status','get_proof_status','get_certificate_proof_status','get_verify_preview'].includes(tool)) {
  const {certificate_id}=certificateInput.parse(input);
  const c=await s.sql('SELECT id,certificate_id,status,issued_at,revoked_at,document_hash FROM certificates WHERE certificate_id=?',certificate_id).first<{id:string;certificate_id:string;status:string;issued_at:string;revoked_at:string|null;document_hash:string}>();
  if(!c)throw new HttpError(404,'Certificate not found');
  const proofs=await s.sql('SELECT status,certificate_status,verified_at FROM timestamp_proofs WHERE certificate_id=? ORDER BY created_at DESC LIMIT 20',c.id).all();
  return {certificate_id:c.certificate_id,status:c.status,issued_at:c.issued_at,revoked_at:c.revoked_at,document_hash:c.document_hash,proofs:proofs.results};
 }
 const args=tool.startsWith('submit_')?reviewInput.parse(input):batchInput.parse(input);
 const batch=await s.sql('SELECT id,status,row_count,valid_count,invalid_count,approved_at,completed_at FROM issuance_batches WHERE id=?',args.batch_id).first<{id:string;status:string;row_count:number;valid_count:number;invalid_count:number;approved_at:string|null;completed_at:string|null}>();
 if(!batch)throw new HttpError(404,'Batch not found');
 if(tool.startsWith('submit_')) {
  const review=reviewInput.parse(args),time=now(),reviewId=id();
  await s.env.DB.batch([
   s.sql("INSERT INTO workflow_runs VALUES(?,?,'bot_review','IN_PROGRESS',?,NULL,?) ON CONFLICT(batch_id,workflow_type) DO NOTHING",id(),batch.id,time,time),
   s.sql("INSERT INTO bot_reviews SELECT ?,id,?, ?,?,?,?,?,?,?,?,?,? FROM workflow_runs WHERE batch_id=? AND workflow_type='bot_review'",reviewId,batch.id,bot.id,bot.role,review.result,review.risk_level,review.recommendation,review.summary,JSON.stringify(review.issues),review.model,review.prompt_version,time,batch.id),
   audit(s,bot.id,'BOT_REVIEW_SUBMITTED'),
   s.sql("UPDATE workflow_runs SET status='COMPLETED',completed_at=? WHERE batch_id=? AND (SELECT count(DISTINCT role) FROM bot_reviews WHERE workflow_run_id=workflow_runs.id)=5",time,batch.id)
  ]);
  return {review_id:reviewId,batch_id:batch.id,agent_id:bot.id,role:bot.role,approval_boundary:'Punka only'};
 }
 if(tool==='get_all_reviews') return {reviews:(await s.sql('SELECT id,workflow_run_id,batch_id,agent_id,role,result,risk_level,recommendation,summary,issues_json,created_at FROM bot_reviews WHERE batch_id=? ORDER BY created_at LIMIT 100',batch.id).all()).results};
 if(tool==='get_workflow_status')return {workflows:(await s.sql('SELECT id,batch_id,workflow_type,status,started_at,completed_at FROM workflow_runs WHERE batch_id=?',batch.id).all()).results};
 if(tool==='get_notification_summary')return {counts:(await s.sql('SELECT n.status,count(*) AS count FROM notifications n JOIN certificates c ON c.id=n.certificate_id WHERE c.batch_id=? GROUP BY n.status',batch.id).all()).results};
 if(tool==='get_consent_summary'||tool==='get_compliance_summary') {
  const counts=await s.sql('SELECT count(DISTINCT u.id) AS registered_recipients,count(DISTINCT CASE WHEN u.consent_at IS NOT NULL THEN u.id END) AS consented_recipients FROM issuance_rows r JOIN users u ON u.email=lower(r.email) WHERE r.batch_id=?',batch.id).first();
  return {batch_id:batch.id,counts,unregistered_consent:'unknown',approval_recorded:batch.approved_at!==null,approval_boundary:'Punka only'};
 }
 if(tool==='check_duplicate_summary')return {batch_id:batch.id,duplicate_groups:(await s.sql('SELECT count(*) AS count FROM (SELECT lower(email),course FROM issuance_rows WHERE batch_id=? GROUP BY lower(email),course HAVING count(*)>1)',batch.id).first()),existing_certificate_matches:(await s.sql('SELECT count(*) AS count FROM issuance_rows r JOIN issuance_batches b ON b.id=r.batch_id JOIN users u ON u.email=lower(r.email) JOIN courses co ON co.name=r.course AND co.issuer_id=b.issuer_id JOIN certificates c ON c.recipient_id=u.id AND c.course_id=co.id WHERE r.batch_id=?',batch.id).first())};
 if(tool==='get_validation_summary'||tool==='get_security_summary') {
  const rows=await s.sql("SELECT count(*) AS total_rows,sum(CASE WHEN errors_json!='[]' THEN 1 ELSE 0 END) AS rows_with_errors FROM issuance_rows WHERE batch_id=?",batch.id).first();
  return {batch_id:batch.id,status:batch.status,valid_count:batch.valid_count,invalid_count:batch.invalid_count,rows,validation_completed:['READY_FOR_APPROVAL','APPROVED','ISSUING','COMPLETED'].includes(batch.status),admin_approval:'Punka only'};
 }
 if(tool==='get_technical_summary')return {batch_id:batch.id,status:batch.status,certificate_count:(await s.sql('SELECT count(*) AS count FROM certificates WHERE batch_id=?',batch.id).first()),proof_counts:(await s.sql('SELECT p.status,count(*) AS count FROM timestamp_proofs p JOIN certificates c ON c.id=p.certificate_id WHERE c.batch_id=? GROUP BY p.status',batch.id).all()).results};
 if(tool==='get_pii_exposure_summary')return {batch_id:batch.id,raw_csv_exposed:false,recipient_fields_exposed:false,review_fields:'controlled vocabulary',logs:'IDs and tool names only'};
 if(tool==='get_auth_security_status')return {batch_id:batch.id,bearer_required:true,role_bound:true,passkey_user_verification_required:true,admin_approval:'Punka only',assessment:'configuration summary; not a security certification'};
 return {batch_id:batch.id,status:batch.status,row_count:batch.row_count,valid_count:batch.valid_count,invalid_count:batch.invalid_count,approval_recorded:batch.approved_at!==null,completed_at:batch.completed_at};
}
function rpcError(rpcId:string|number|null,code:number,message:string) {return Response.json({jsonrpc:'2.0',id:rpcId,error:{code,message}});}
export async function mcp(request:Request,env:Bindings):Promise<Response> {
 const path=new URL(request.url).pathname;
 if(path==='/mcp/health' && request.method==='GET')return Response.json({status:'ok',service:'punka-proof-mcp'});
 const s=new ProofService(env);
 const bot=await authenticate(request,env,path,s);
 const epoch=Math.floor(Date.now()/60000);
 const rate=await s.sql('INSERT INTO rate_limits(key,count,reset_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN reset_at=excluded.reset_at THEN count+1 ELSE 1 END,reset_at=excluded.reset_at RETURNING count',await sha256(`mcp:${bot.id}`),epoch).first<{count:number}>();
 if(rate && rate.count>240)throw new HttpError(429,'Rate limit exceeded');
 const origin=request.headers.get('Origin');if(origin && origin!==env.APP_ORIGIN)throw new HttpError(403,'Origin denied');
 if(request.method!=='POST')return new Response(null,{status:405,headers:{Allow:'POST'}});
 const version=request.headers.get('MCP-Protocol-Version');if(version && !versions.includes(version))throw new HttpError(400,'Unsupported protocol version');
 const accept=request.headers.get('Accept')??'';if(!accept.includes('application/json')||!accept.includes('text/event-stream'))throw new HttpError(406,'Accept JSON and event-stream');
 if(request.headers.get('Content-Type')?.split(';')[0].trim()!=='application/json')throw new HttpError(415,'JSON required');
 const reader=request.body?.getReader();if(!reader)throw new HttpError(400,'Body required');
 let size=0;const chunks:Uint8Array[]=[];
 while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>16384){await reader.cancel();throw new HttpError(413,'Request too large');}chunks.push(value);}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 let body:unknown;try{body=JSON.parse(new TextDecoder().decode(bytes));}catch{return rpcError(null,-32700,'Parse error');}
 const parsed=z.object({jsonrpc:z.literal('2.0'),id:z.union([z.string().max(100),z.number().finite()]).optional(),method:z.string().max(100),params:z.record(z.string(),z.unknown()).optional()}).strict().safeParse(body);
 if(!parsed.success)return rpcError(null,-32600,'Invalid request');
 const message=parsed.data;
 if(message.id===undefined){if(message.method==='notifications/initialized'||message.method==='notifications/cancelled')return new Response(null,{status:202});return new Response(null,{status:400});}
 const reply=(result:unknown)=>Response.json({jsonrpc:'2.0',id:message.id,result});
 if(message.method==='initialize') {
  const init=z.object({protocolVersion:z.string(),capabilities:z.record(z.string(),z.unknown()),clientInfo:z.object({name:z.string(),version:z.string()})}).passthrough().safeParse(message.params);
  if(!init.success)return rpcError(message.id,-32602,'Invalid initialize params');
  return reply({protocolVersion:versions.includes(init.data.protocolVersion)?init.data.protocolVersion:versions[0],capabilities:{tools:{listChanged:false}},serverInfo:{name:'punka-proof-mcp',version:'1.0.0'},instructions:'Reviews are advisory. Only Punka may approve, issue or revoke.'});
 }
 if(message.method==='ping')return reply({});
 if(message.method==='tools/list')return reply({tools:allowedTools(bot).map(name=>({name,description:name.replaceAll('_',' '),inputSchema:z.toJSONSchema(name.startsWith('submit_')?reviewInput:['get_certificate_status','get_proof_status','get_certificate_proof_status','get_verify_preview'].includes(name)?certificateInput:batchInput),annotations:{readOnlyHint:!name.startsWith('submit_'),destructiveHint:false,openWorldHint:false}}))});
 if(message.method!=='tools/call')return rpcError(message.id,-32601,'Method not found');
 const params=z.object({name:z.string().max(80),arguments:z.unknown().optional()}).strict().safeParse(message.params);
 if(!params.success)return rpcError(message.id,-32602,'Invalid tool params');
 const {name}=params.data;
 if(!allowedTools(bot).includes(name)){await audit(s,bot.id,'MCP_TOOL_DENIED').run();return rpcError(message.id,-32602,'Tool denied');}
 await audit(s,bot.id,'MCP_TOOL_CALLED',name).run();
 try {
  const result=await execute(s,bot,name,params.data.arguments??{});
  return reply({content:[{type:'text',text:JSON.stringify(result)}]});
 }catch(error){
  return reply({isError:true,content:[{type:'text',text:error instanceof z.ZodError?'Invalid tool arguments':error instanceof HttpError?error.message:'Tool failed or review already submitted'}]});
 }
}
