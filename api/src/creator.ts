import {proofDetails,isPublicProof} from './proof-view';
import { z } from 'zod';
import { currentUser, cookie } from './auth';
import {requireActiveUser} from './user-status';
import { Store, type Bindings } from './store';
import { HttpError, id, now, sha256, randomToken } from './domain';
import {access,audit,sourceURL} from './operations';
import {pagination,pageResult,listResponse} from './pagination';
const projectInput=z.object({name:z.string().trim().min(1).max(200),client_name:z.string().trim().max(200).default(''),start_date:z.iso.date().nullable().default(null),end_date:z.iso.date().nullable().default(null)}).strict().refine(v=>!v.start_date||!v.end_date||v.end_date>=v.start_date);
const fileShape=z.object({filename:z.string().trim().min(1).max(255),mime_type:z.string().max(255).default('application/octet-stream'),size:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),sha256:z.string().regex(/^[a-f0-9]{64}$/),creator_id:z.string().uuid().nullable().default(null),comment:z.string().max(4000).default(''),status:z.enum(['DRAFT','SUBMITTED']).default('SUBMITTED'),external_source_url:sourceURL.nullable().default(null)}).strict();
const fileInput=fileShape;const assetInput=fileShape.extend({name:z.string().trim().min(1).max(200).optional()});
export async function creatorRoute(request:Request,env:Bindings,apiUser?:string):Promise<Response> {
 const url=new URL(request.url),path=url.pathname, method=request.method, s=new Store(env);
 const paging=pagination(url.searchParams),{limit,offset}=paging,query=`%${(url.searchParams.get('q')??'').slice(0,200)}%`;
 let m:RegExpMatchArray|null;
 if(path==='/api/health'&&method==='GET')return Response.json({ok:true,service:'Creator Trace',phase:3});
 if((m=path.match(/^\/api\/verify\/([^/]+)(?:\/(ots))?$/))&&method==='GET') {
  const proof=await s.sql('SELECT pr.*,a.project_id FROM proofs pr JOIN asset_versions v ON v.id=pr.asset_version_id JOIN assets a ON a.id=v.asset_id WHERE pr.id=?',m[1]).first<Record<string,unknown>>();
  if(!proof)throw new HttpError(404,'証跡が見つかりません');
  // Only explicitly selected own-music proofs are public. Names and filenames never grant visibility.
  if(!isPublicProof(env,m[1])){if(!apiUser)throw new HttpError(404,'この証跡は公開されていません。案件メンバーは証跡詳細から確認してください');await access(s,apiUser,String(proof.project_id));}
  if(m[2]==='ots'){if(typeof proof.ots_proof!=='string')throw new HttpError(409,'証跡ファイルはまだ作成されていません');return new Response(Buffer.from(proof.ots_proof,'base64'),{headers:{'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename="${String(proof.id).replace(/[^a-zA-Z0-9-]/g,'')}.ots"`}});}
  const fields=['id','sha256','created_at','timestamp_status','bitcoin_status','timestamp','proof_status','timestamp_created_at','bitcoin_confirmed_at','bitcoin_block_height','bitcoin_block_hash','bitcoin_block_time'];
  const detail=await proofDetails(proof,env);return Response.json({...Object.fromEntries(fields.map(key=>[key,(detail as Record<string,unknown>)[key]])),verification:detail.verification});
 }
 // One-time owner provisioning is done by CLI, never by certificate invitations.
 if(path==='/api/auth/owner-session'&&method==='POST') {
  const token=request.headers.get('Authorization');
  if(!env.OPERATOR_TOKEN||!token||await sha256(token)!==await sha256(`Bearer ${env.OPERATOR_TOKEN}`))throw new HttpError(403,'初期設定の権限がありません');
  const {user_id}=z.object({user_id:z.string().uuid()}).strict().parse(await request.json());
  if(!await s.sql('SELECT id FROM users WHERE id=?',user_id).first())throw new HttpError(404,'ユーザーが見つかりません');
  await requireActiveUser(s,user_id);
  const secret=randomToken();await s.sql('INSERT INTO sessions VALUES(?,?,?)',await sha256(secret),user_id,new Date(Date.now()+3600000).toISOString()).run();
  return Response.json({ok:true},{headers:{'Set-Cookie':cookie(env,'punka_session',secret,3600)}});
 }
 const user=apiUser??await currentUser(request,s);
 if(apiUser)await requireActiveUser(s,user);
 async function project(projectId:string) {
  await access(s,user,projectId,method==='POST'?'manage':'read');
  const item=await s.sql('SELECT * FROM projects WHERE id=?',projectId).first();
  if(!item)throw new HttpError(404,'案件が見つかりません');return item;
 }
 async function asset(assetId:string) {
  const item=await s.sql('SELECT * FROM assets WHERE id=?',assetId).first<{id:string;project_id:string;created_by:string|null;archived_at:string|null}>();
  if(item?.archived_at&&method==='POST')throw new HttpError(409,'制作物はアーカイブ済みです');
  if(!item)throw new HttpError(404,'制作物が見つかりません');const role=await access(s,user,item.project_id,method==='POST'?'write':'read');if(method==='POST'&&role==='CREATOR'&&item.created_by!==user)throw new HttpError(403,'自分の制作物のみ操作できます');return item;
 }
 async function creator(creatorId:string|null,projectId:string) {
  if(creatorId&&!await s.sql('SELECT id FROM creators WHERE id=? AND project_id=?',creatorId,projectId).first())throw new HttpError(400,'制作者が案件に所属していません');
 }
 if(path==='/api/projects') {
  if(method==='GET')return listResponse((await s.sql("SELECT p.* FROM projects p JOIN project_members m ON m.project_id=p.id WHERE m.user_id=? AND m.status='ACTIVE' AND p.archived_at IS NULL AND (p.name LIKE ? OR p.client_name LIKE ?) ORDER BY p.created_at DESC,p.id LIMIT ? OFFSET ?",user,query,query,limit+1,offset).all()).results,paging,url.searchParams);
  if(method==='POST') {
   const data=projectInput.parse(await request.json()),projectId=id();
   await s.sql('INSERT INTO projects(id,name,client_name,owner_id,start_date,end_date,created_at) VALUES(?,?,?,?,?,?,?)',projectId,data.name,data.client_name,user,data.start_date,data.end_date,now()).run();
   return Response.json(await project(projectId),{status:201});
  }
 }
 if((m=path.match(/^\/api\/projects\/([^/]+)(?:\/(creators|assets))?$/))) {
  const item=m[2]==='assets'&&method==='POST'?(await access(s,user,m[1],'write'),await s.sql('SELECT * FROM projects WHERE id=? AND archived_at IS NULL',m[1]).first()):await project(m[1]);
  if(!item)throw new HttpError(409,'案件はアーカイブ済みです');
  if(!m[2]&&method==='GET'){
   const assets=pageResult((await s.sql('SELECT a.*,COALESCE(a.name,a.filename) AS name,(SELECT filename FROM asset_versions WHERE asset_id=a.id ORDER BY version DESC LIMIT 1) AS latest_filename, (SELECT MAX(version) FROM asset_versions WHERE asset_id=a.id) AS latest_version FROM assets a WHERE project_id=? AND archived_at IS NULL AND (COALESCE(name,filename) LIKE ? OR filename LIKE ? OR EXISTS(SELECT 1 FROM asset_versions v LEFT JOIN creators c ON c.id=v.creator_id WHERE v.asset_id=a.id AND (v.sha256 LIKE ? OR c.name LIKE ?))) ORDER BY created_at DESC,id LIMIT ? OFFSET ?',m[1],query,query,query,query,limit+1,offset).all()).results,paging);
   return Response.json({...item,current_role:await access(s,user,m[1]),creators:(await s.sql('SELECT * FROM creators WHERE project_id=? ORDER BY created_at,id',m[1]).all()).results,assets:assets.items,assets_pagination:{page:assets.page,limit:assets.limit,hasNext:assets.hasNext}});
  }
  if(m[2]==='creators'&&method==='POST') {
   const data=z.object({name:z.string().trim().min(1).max(200),email:z.union([z.email(),z.literal('')]).default(''),role:z.string().trim().min(1).max(100)}).strict().parse(await request.json()),creatorId=id();
   await s.sql('INSERT INTO creators VALUES(?,?,?,?,?,?)',creatorId,m[1],data.name,data.email,data.role,now()).run();return Response.json({id:creatorId,...data},{status:201});
  }
  if(m[2]==='assets'&&method==='POST') {
   const data=assetInput.parse(await request.json());await creator(data.creator_id,m[1]);
   const assetId=id(),versionId=id(),proofId=id(),time=now();
   await env.DB.batch([
    s.sql('INSERT INTO assets(id,project_id,creator_id,filename,mime_type,size,created_at,created_by,external_source_url,name) VALUES(?,?,?,?,?,?,?,?,?,?)',assetId,m[1],data.creator_id,data.filename,data.mime_type,data.size,time,user,data.external_source_url,data.name??data.filename),
    s.sql('UPDATE asset_version_counters SET next_version=next_version+1 WHERE asset_id=?',assetId),versionStatement(assetId,versionId,data,time),
    proofStatement(proofId,versionId,data.sha256,time),
    ...sourceStatements(versionId,data),audit(s,m[1],user,'ASSET_CREATED','asset',assetId)
   ]);return Response.json({id:assetId,version_id:versionId,proof_id:proofId,version:1},{status:201});
  }
 }
 if(path==='/api/assets'&&method==='GET')return listResponse((await s.sql("SELECT a.*,COALESCE(a.name,a.filename) AS name,(SELECT filename FROM asset_versions WHERE asset_id=a.id ORDER BY version DESC LIMIT 1) AS latest_filename,p.name AS project_name,(SELECT MAX(version) FROM asset_versions WHERE asset_id=a.id) AS latest_version FROM assets a JOIN projects p ON p.id=a.project_id JOIN project_members m ON m.project_id=p.id WHERE m.user_id=? AND m.status='ACTIVE' AND a.archived_at IS NULL AND p.archived_at IS NULL AND (COALESCE(a.name,a.filename) LIKE ? OR a.filename LIKE ? OR EXISTS(SELECT 1 FROM asset_versions v LEFT JOIN creators c ON c.id=v.creator_id WHERE v.asset_id=a.id AND (v.sha256 LIKE ? OR c.name LIKE ?))) ORDER BY a.created_at DESC,a.id LIMIT ? OFFSET ?",user,query,query,query,query,limit+1,offset).all()).results,paging,url.searchParams);
 if((m=path.match(/^\/api\/assets\/([^/]+)\/versions\/([^/]+)$/))&&method==='GET'){
  await asset(m[1]);const version=await s.sql('SELECT v.*,st.status AS status,c.name AS creator_name,p.id AS proof_id,p.timestamp_status,p.bitcoin_status,src.external_source_url FROM asset_versions v JOIN asset_version_states st ON st.asset_version_id=v.id LEFT JOIN version_sources src ON src.asset_version_id=v.id LEFT JOIN creators c ON c.id=v.creator_id JOIN proofs p ON p.asset_version_id=v.id WHERE v.asset_id=? AND v.id=?',m[1],m[2]).first();if(!version)throw new HttpError(404,'版が見つかりません');return Response.json(version);
 }
 if((m=path.match(/^\/api\/assets\/([^/]+)(?:\/(versions))?$/))) {
  const item=await asset(m[1]);
  if(method==='GET'){const data=await env.DB.batch<Record<string,unknown>>([
   s.sql('SELECT a.*,COALESCE(a.name,a.filename) AS name,(SELECT MAX(version) FROM asset_versions WHERE asset_id=a.id) AS latest_version,(SELECT filename FROM asset_versions WHERE asset_id=a.id ORDER BY version DESC LIMIT 1) AS latest_filename FROM assets a WHERE a.id=?',item.id),
   s.sql('SELECT v.*,st.status AS status,c.name AS creator_name,p.id AS proof_id,p.timestamp_status,p.bitcoin_status,src.external_source_url FROM asset_versions v JOIN asset_version_states st ON st.asset_version_id=v.id LEFT JOIN version_sources src ON src.asset_version_id=v.id LEFT JOIN creators c ON c.id=v.creator_id JOIN proofs p ON p.asset_version_id=v.id WHERE v.asset_id=? ORDER BY v.version DESC LIMIT ? OFFSET ?',item.id,limit+1,offset)
  ]);const versions=pageResult(data[1].results,paging);return m[2]?listResponse(data[1].results,paging,url.searchParams):Response.json({...data[0].results[0],versions:versions.items,versions_pagination:{page:versions.page,limit:versions.limit,hasNext:versions.hasNext}});}

  if(m[2]&&method==='POST') {
   const data=fileInput.parse(await request.json());await creator(data.creator_id,item.project_id);
   const versionId=id(),proofId=id(),time=now();
   try {await env.DB.batch([s.sql('UPDATE asset_version_counters SET next_version=next_version+1 WHERE asset_id=?',item.id),versionStatement(item.id,versionId,data,time),proofStatement(proofId,versionId,data.sha256,time),...sourceStatements(versionId,data)]);}
   catch {throw new HttpError(409,'登録が競合しました。履歴を確認して再度登録してください');}
   return Response.json(await s.sql('SELECT v.*,p.id AS proof_id FROM asset_versions v JOIN proofs p ON p.asset_version_id=v.id WHERE v.id=?',versionId).first(),{status:201});
  }
 }
 if((m=path.match(/^\/api\/proofs\/([^/]+)$/))&&method==='GET') {
  const proof=await s.sql('SELECT pr.*,v.version,v.asset_id,v.filename,a.project_id FROM proofs pr JOIN asset_versions v ON v.id=pr.asset_version_id JOIN assets a ON a.id=v.asset_id WHERE pr.id=?',m[1]).first<{project_id:string}>();
  if(!proof)throw new HttpError(404,'証跡が見つかりません');await access(s,user,proof.project_id);return Response.json({...await proofDetails(proof,env),is_public:isPublicProof(env,m[1])});
 }
 throw new HttpError(404,'ページが見つかりません');
 function versionStatement(assetId:string,versionId:string,data:z.infer<typeof fileInput>,time:string) {
  return s.sql('INSERT INTO asset_versions(id,asset_id,version,sha256,status,comment,created_by,creator_id,filename,mime_type,size,created_at) SELECT ?,?,(SELECT next_version-1 FROM asset_version_counters WHERE asset_id=?),?,?,?,?,?,?,?,?,?',versionId,assetId,assetId,data.sha256,data.status,data.comment,user,data.creator_id,data.filename,data.mime_type,data.size,time);
 }
 function sourceStatements(versionId:string,data:z.infer<typeof fileInput>){return data.external_source_url?[s.sql('INSERT INTO version_sources VALUES(?,?)',versionId,data.external_source_url)]:[];}
 function proofStatement(proofId:string,versionId:string,hash:string,time:string) {return s.sql('INSERT INTO proofs(id,asset_version_id,sha256,created_at,updated_at) VALUES(?,?,?,?,?)',proofId,versionId,hash,time,time);}
}
