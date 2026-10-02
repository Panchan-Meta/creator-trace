import {z} from 'zod';
import {requireAdmin} from './admin';
import {HttpError} from './domain';
import {Store,type Bindings} from './store';
export async function inquiriesRoute(request:Request,env:Bindings):Promise<Response|null>{
 const path=new URL(request.url).pathname;if(!path.startsWith('/api/admin/'))return null;
 const s=new Store(env);await requireAdmin(request,s);
 if(path==='/api/admin/access'&&request.method==='GET')return Response.json({is_admin:true,system_role:'ADMIN'});
 if(path==='/api/admin/inquiries'&&request.method==='GET')return Response.json((await s.sql("SELECT id,name,company,email,team_size,problem,created_at,status FROM business_inquiries WHERE archived_at IS NULL ORDER BY CASE WHEN status='NEW' THEN 0 ELSE 1 END,created_at DESC,id DESC").all()).results);
 const match=path.match(/^\/api\/admin\/inquiries\/([^/]+)(\/status)?$/);if(!match)throw new HttpError(404,'ページが見つかりません');
 if(!match[2]&&request.method==='GET'){
  const row=await s.sql('SELECT * FROM business_inquiries WHERE id=? AND archived_at IS NULL',match[1]).first();if(!row)throw new HttpError(404,'問い合わせが見つかりません');return Response.json(row);
 }
 if(match[2]&&request.method==='PATCH'){
  const parsed=z.object({status:z.enum(['NEW','IN_PROGRESS','COMPLETED'])}).strict().safeParse(await request.json());if(!parsed.success)throw new HttpError(400,'ステータスのみをNEW・IN_PROGRESS・COMPLETEDから指定してください');
  const row=await s.sql('UPDATE business_inquiries SET status=? WHERE id=? AND archived_at IS NULL RETURNING id,status',parsed.data.status,match[1]).first();if(!row)throw new HttpError(404,'問い合わせが見つかりません');return Response.json(row);
 }
 throw new HttpError(405,'Method not allowed');
}
