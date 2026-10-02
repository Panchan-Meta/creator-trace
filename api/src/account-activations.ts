import {z} from 'zod';
import {requireAdmin} from './admin';
import {terminateUser} from './user-termination';
import {HttpError,id,now,randomToken,sha256} from './domain';
import {Store,type Bindings} from './store';
export type Activation={id:string;email:string;status:string;expires_at:string};
export async function expireAccountActivations(env:Bindings){
 const s=new Store(env);await s.sql("UPDATE account_activations SET status='EXPIRED' WHERE status='PENDING' AND expires_at<=?",now()).run();
 await s.sql('DELETE FROM account_activation_registrations WHERE expires_at<=?',now()).run();
}
export async function pendingActivation(s:Store,tokenHash:string):Promise<Activation>{
 await s.sql("UPDATE account_activations SET status='EXPIRED' WHERE token_hash=? AND status='PENDING' AND expires_at<=?",tokenHash,now()).run();
 const row=await s.sql('SELECT id,email,status,expires_at FROM account_activations WHERE token_hash=?',tokenHash).first<Activation>();
 if(!row)throw new HttpError(410,'この利用開始URLは無効です。');
 if(row.status==='EXPIRED')throw new HttpError(410,'この利用開始URLは期限切れです。');
 if(row.status==='REVOKED')throw new HttpError(410,'この利用開始URLは取り消されています。');
 if(row.status!=='PENDING')throw new HttpError(410,'この利用開始URLは使用済みです。');
 return row;
}
export const activationToken=z.string().regex(/^[a-f0-9]{64}$/);
export async function accountActivationsRoute(request:Request,env:Bindings):Promise<Response|null>{
 const path=new URL(request.url).pathname,s=new Store(env);
 if(path==='/api/auth/account-activation/preview'&&request.method==='POST'){
  const d=z.object({token:activationToken}).strict().parse(await request.json());
  return Response.json(await pendingActivation(s,await sha256(d.token)));
 }
 if(!/^\/api\/admin\/(users|account-activations)(?:\/|$)/.test(path))return null;
 const admin=await requireAdmin(request,s,'利用者管理の権限がありません');
 const termination=path.match(/^\/api\/admin\/users\/([^/]+)\/terminate$/);
 if(termination&&request.method==='POST')return terminateUser(request,s,admin,termination[1]);
 await expireAccountActivations(env);
 if(path==='/api/admin/users'&&request.method==='GET'){
  const users=(await s.sql("SELECT u.id,u.display_name,u.email,u.created_at,u.status,u.terminated_at,u.terminated_by_admin_id,u.termination_reason,CASE WHEN EXISTS(SELECT 1 FROM webauthn_credentials c WHERE c.recipient_id=u.id AND c.revoked_at IS NULL) THEN 'REGISTERED' ELSE 'UNREGISTERED' END AS passkey_status,CASE WHEN EXISTS(SELECT 1 FROM site_admins a WHERE a.user_id=u.id) THEN 'ADMIN' ELSE 'USER' END AS system_role FROM users u ORDER BY u.created_at DESC,u.id").all()).results;
  const activations=(await s.sql('SELECT id,email,status,expires_at,activated_at,user_id,created_by_admin_id,created_at,revoked_at FROM account_activations ORDER BY created_at DESC,id').all()).results;
  return Response.json({users,activations});
 }
 if(path==='/api/admin/account-activations'&&request.method==='POST'){
  const {email}=z.object({email:z.string().trim().pipe(z.email().max(254)).transform(v=>v.toLowerCase())}).strict().parse(await request.json());
  if(await s.sql('SELECT id FROM users WHERE lower(email)=?',email).first())throw new HttpError(409,'このメールアドレスは登録済みです。既存のPasskeyでログインしてください。');
  if(await s.sql("SELECT id FROM account_activations WHERE email=? AND status='PENDING'",email).first())throw new HttpError(409,'このメールアドレスには未使用の利用開始URLがあります。必要なら発行を取り消してください。');
  const activation=id(),token=randomToken(),time=now(),expires=new Date(Date.now()+7*86400000).toISOString();
  try{await s.sql('INSERT INTO account_activations(id,email,token_hash,expires_at,created_by_admin_id,created_at) VALUES(?,?,?,?,?,?)',activation,email,await sha256(token),expires,admin,time).run();}
  catch{throw new HttpError(409,'利用開始URLの発行が競合しました。一覧を確認してください。');}
  return Response.json({id:activation,url:new URL(`/activate/${token}`,env.APP_ORIGIN).href,expires_at:expires},{status:201});
 }
 const revoke=path.match(/^\/api\/admin\/account-activations\/([^/]+)\/revoke$/);
 if(revoke&&request.method==='POST'){
  z.object({}).strict().parse(await request.json());
  const row=await s.sql("UPDATE account_activations SET status='REVOKED',revoked_at=?,revoked_by_admin_id=? WHERE id=? AND status='PENDING' RETURNING id",now(),admin,revoke[1]).first();
  if(!row)throw new HttpError(409,'未使用の利用開始URLだけ取り消せます。');
  return Response.json({ok:true});
 }
 throw new HttpError(404,'ページが見つかりません');
}
