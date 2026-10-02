import {HttpError} from './domain';
import {Store} from './store';
export async function requireActiveUser(s:Store,user:string){
 const row=await s.sql('SELECT status FROM users WHERE id=?',user).first<{status:string}>();
 if(!row||row.status!=='ACTIVE')throw new HttpError(403,'このアカウントは利用停止されています');
}
