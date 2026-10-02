import {Store,type Bindings} from './store';
import {HttpError,sha256,now} from './domain';
import {access} from './operations';
import {creatorRoute} from './creator';
export async function publicAPI(request:Request,env:Bindings){
 if(request.method!=='GET')throw new HttpError(405,'Read-only API');
 const raw=request.headers.get('Authorization')?.match(/^Bearer (ct_[A-Za-z0-9_-]+)$/)?.[1];if(!raw)throw new HttpError(401,'APIキーが必要です');const s=new Store(env);
 const key=await s.sql('SELECT * FROM api_keys WHERE key_hash=? AND revoked_at IS NULL',await sha256(raw)).first<{key_id:string;user_id:string;project_id:string|null;scopes:string}>();if(!key)throw new HttpError(401,'APIキーが無効です');
 const url=new URL(request.url),path=url.pathname.replace('/api/v1/','/api/'),m=path.match(/^\/api\/(projects|assets|proofs|verify)(?:\/([^/]+))?(?:\/(versions))?$/);if(!m||(!m[2]&&m[1]!=='projects')||(m[3]&&m[1]!=='assets'))throw new HttpError(404,'APIが見つかりません');
 if(!(JSON.parse(key.scopes) as string[]).includes(`${m[1]}:read`))throw new HttpError(403,'scopeが不足しています');
 const count=await s.sql('INSERT INTO rate_limits(key,count,reset_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN reset_at=excluded.reset_at THEN count+1 ELSE 1 END,reset_at=excluded.reset_at RETURNING count',`key:${key.key_id}`,Math.floor(Date.now()/60000)).first<{count:number}>();if(count!.count>60)throw new HttpError(429,'API rate limit');
 if(m[2]){const project=m[1]==='projects'?{project_id:m[2]}:await s.sql(m[1]==='assets'?'SELECT project_id FROM assets WHERE id=?':'SELECT a.project_id FROM proofs p JOIN asset_versions v ON v.id=p.asset_version_id JOIN assets a ON a.id=v.asset_id WHERE p.id=?',m[2]).first<{project_id:string}>();if(!project||(key.project_id&&project.project_id!==key.project_id))throw new HttpError(404,'対象が見つかりません');await access(s,key.user_id,project.project_id);}
 await s.sql('UPDATE api_keys SET last_used_at=? WHERE key_id=?',now(),key.key_id).run();
 url.pathname=path;
 if(path==='/api/projects'&&key.project_id){await access(s,key.user_id,key.project_id);return Response.json((await s.sql('SELECT * FROM projects WHERE id=? AND archived_at IS NULL',key.project_id).all()).results);}
 return creatorRoute(new Request(url,request),env,key.user_id);
}
