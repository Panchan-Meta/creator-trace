import {z} from 'zod';
import {displayName} from './display-name';
import {currentUser} from './auth';
import {HttpError,id,now,randomToken,sha256} from './domain';
import {access,audit} from './operations';
import {Store,type Bindings} from './store';
const statusSQL="CASE WHEN i.consumed_at IS NOT NULL THEN 'ACCEPTED' WHEN i.revoked_at IS NOT NULL THEN 'REVOKED' WHEN i.expires_at<=? THEN 'EXPIRED' ELSE 'PENDING' END AS status";
const columns='i.id,i.project_id,i.email,i.role,i.created_at,i.expires_at,i.consumed_at,i.revoked_at';
export async function expireInvites(env:Bindings,project?:string){const s=new Store(env);await s.sql('UPDATE project_invites SET expired_at=? WHERE expired_at IS NULL AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at<=?'+(project?' AND project_id=?':''),now(),now(),...(project?[project]:[])).run();}
export async function projectInvitesRoute(request:Request,env:Bindings):Promise<Response|null>{
 const url=new URL(request.url),path=url.pathname,manage=path.match(/^\/api\/projects\/([^/]+)\/invites(?:\/([^/]+)\/revoke)?$/);
 if(!manage&&!['/api/project-invites/preview','/api/project-invites/accept'].includes(path))return null;
 const s=new Store(env),user=path==='/api/project-invites/preview'?null:await currentUser(request,s);
 if(manage){
  const project=manage[1],role=await access(s,user!,project,'read');if(!['OWNER','MANAGER'].includes(role))throw new HttpError(403,'操作権限がありません');if(request.method!=='GET')await access(s,user!,project,'manage');
  await expireInvites(env,project);
  if(manage[2]&&request.method==='POST'){
   const changed=await s.sql('UPDATE project_invites SET revoked_at=? WHERE id=? AND project_id=? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>? RETURNING id',now(),manage[2],project,now()).first();if(!changed)throw new HttpError(409,'この招待は取り消せません');await audit(s,project,user!,'INVITE_REVOKED','invite',manage[2]).run();return Response.json({id:manage[2],status:'REVOKED'});
  }
  if(manage[2])throw new HttpError(405,'Method not allowed');
  if(request.method==='GET'){const limit=url.searchParams.get('limit'),status=url.searchParams.get('status');if(limit!==null&&!/^(?:[1-9]|[1-9][0-9]|100)$/.test(limit))throw new HttpError(400,'表示件数が不正です');if(status!==null&&status!=='PENDING')throw new HttpError(400,'招待状態が不正です');const time=now();return Response.json((await s.sql(`SELECT ${columns},${statusSQL} FROM project_invites i WHERE i.project_id=?${status?' AND i.consumed_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>?':''} ORDER BY i.created_at DESC,i.id DESC${limit?' LIMIT ?':''}`,time,project,...(status?[time]:[]),...(limit?[Number(limit)]:[])).all()).results);}
  if(request.method!=='POST')throw new HttpError(405,'Method not allowed');
  const parsed=z.object({email:z.email().max(254),role:z.enum(['MANAGER','CREATOR','REVIEWER','VIEWER'])}).strict().safeParse(await request.json());if(!parsed.success)throw new HttpError(400,'招待先メールとRoleを確認してください。OWNERは追加招待できません');
  const d={...parsed.data,email:parsed.data.email.trim().toLowerCase()},token=randomToken(),invite=id(),time=now(),expires=new Date(Date.now()+7*86400000).toISOString();

  try{await env.DB.batch([s.sql('INSERT INTO project_invites(id,project_id,token_hash,email,role,created_by,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)',invite,project,await sha256(token),d.email,d.role,user!,expires,time),audit(s,project,user!,'MEMBER_INVITED','invite',invite)]);}catch(error){if(await s.sql('SELECT id FROM project_invites WHERE project_id=? AND lower(trim(email))=? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>?',project,d.email,now()).first())throw new HttpError(409,'このメールアドレスには既に招待を送っています');throw error;}
  return Response.json({id:invite,project_id:project,email:d.email,role:d.role,status:'PENDING',created_at:time,expires_at:expires,url:`${env.APP_ORIGIN}/invite/${token}`},{status:201});
 }
 if(request.method!=='POST')throw new HttpError(405,'Method not allowed');
 const parsed=z.object({token:z.string().min(32).max(200),...(path==='/api/project-invites/accept'?{display_name:displayName.optional()}:{})}).strict().safeParse(await request.json());if(!parsed.success)throw new HttpError(400,parsed.error.issues[0].message);const {token}=parsed.data,hash=await sha256(token);
 const invite=await s.sql(`SELECT ${columns},${statusSQL},p.name AS project_name,p.archived_at AS project_archived_at FROM project_invites i JOIN projects p ON p.id=i.project_id WHERE i.token_hash=?`,now(),hash).first<{id:string;project_id:string;status:string;project_archived_at:string|null;[key:string]:unknown}>();
 if(!invite)throw new HttpError(400,'招待が無効です');
 await expireInvites(env,invite.project_id);
 if(path==='/api/project-invites/preview')return Response.json(invite);
 if(invite.status==='EXPIRED')throw new HttpError(410,'招待URLの有効期限が切れています');
 if(invite.status!=='PENDING')throw new HttpError(400,'招待が無効、使用済み、取消済み、または期限切れです');
 if(invite.project_archived_at)throw new HttpError(409,'案件はアーカイブ済みです');
 if(await s.sql("SELECT id FROM project_members WHERE project_id=? AND user_id=? AND status='ACTIVE'",invite.project_id,user!).first())throw new HttpError(409,'この案件にはすでに参加しています');
 if(!await s.sql('SELECT id FROM webauthn_credentials WHERE recipient_id=?',user!).first())throw new HttpError(403,'先にPasskeyを登録してください');
 const profile=await s.sql('SELECT display_name FROM users WHERE id=?',user!).first<{display_name:string|null}>();const requested=(parsed.data as {display_name?:string}).display_name;
 const validName=displayName.safeParse(requested??profile?.display_name);if(!validName.success)throw new HttpError(400,validName.error.issues[0].message);const name=validName.data,time=now();
 try{
  const results=await env.DB.batch([
   s.sql('UPDATE users SET display_name=? WHERE id=? AND EXISTS(SELECT 1 FROM project_invites WHERE token_hash=? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>?)',name,user!,hash,time),
   s.sql('UPDATE project_invites SET consumed_at=?,consumed_by=? WHERE token_hash=? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>? RETURNING project_id',time,user!,hash,time)
  ]);if(!results[1].results.length)throw new HttpError(400,'招待は無効または使用済みです');
 }catch(error){if(error instanceof HttpError)throw error;if(await s.sql("SELECT id FROM project_members WHERE project_id=? AND user_id=? AND status='ACTIVE'",invite.project_id,user!).first())throw new HttpError(409,'この案件にはすでに参加しています');throw error;}
 return Response.json({project_id:invite.project_id,project_name:invite.project_name,role:invite.role,display_name:name,status:'ACCEPTED'});
}
