import {currentUser} from './auth';
import {HttpError} from './domain';
import {Store} from './store';
// site_admins membership represents the system ADMIN role, independent of all project roles.
export async function requireAdmin(request:Request,store:Store,message='問い合わせ管理の権限がありません'):Promise<string>{
 const user=await currentUser(request,store);
 if(!await store.sql('SELECT user_id FROM site_admins WHERE user_id=?',user).first())throw new HttpError(403,message);
 return user;
}
