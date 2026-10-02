import {z} from 'zod';
import {HttpError,now} from './domain';
import {Store} from './store';
// requireAdmin is called by the users route before this function.
export async function terminateUser(request:Request,s:Store,admin:string,target:string){
 const {reason}=z.object({reason:z.string().trim().min(1).max(1000).default('契約終了')}).strict().parse(await request.json());
 if(target===admin)throw new HttpError(409,'自分自身の契約終了はできません');
 const user=await s.sql('SELECT id,status FROM users WHERE id=?',target).first<{id:string;status:string}>();
 if(!user)throw new HttpError(404,'利用者が見つかりません');
 if(await s.sql('SELECT user_id FROM site_admins WHERE user_id=?',target).first())throw new HttpError(409,'ADMINアカウントの契約終了はできません');
 if(user.status==='TERMINATED')throw new HttpError(409,'この利用者は契約終了済みです');
 const result=await s.sql("UPDATE users SET status='TERMINATED',terminated_at=?,terminated_by_admin_id=?,termination_reason=? WHERE id=? AND status='ACTIVE' RETURNING id,status,terminated_at",now(),admin,reason,target).first();
 if(!result)throw new HttpError(409,'この利用者は契約終了済みです');
 return Response.json({ok:true,...result});
}
