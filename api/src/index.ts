import {projectInvitesRoute,expireInvites} from './project-invites';
import {accountActivationsRoute,expireAccountActivations} from './account-activations';
import {botReviewsRoute} from './bot-reviews';
import { z } from 'zod';
import {requireAdmin} from './admin';
import {inquiriesRoute} from './inquiries';
import { auth } from './auth';
import { HttpError, sha256 } from './domain';
import { Store, type Bindings } from './store';
import { creatorRoute } from './creator';
import {operationsRoute} from './operations';
import {publicAPI} from './public-api';
import {refreshProofs} from './timestamps';
async function route(request:Request,env:Bindings):Promise<Response> {
 const path=new URL(request.url).pathname;
 if(path.startsWith('/mcp/')||/^\/api\/(issuance-batches|certificates|my|internal)(\/|$)/.test(path))throw new HttpError(410,'旧サービスは利用を停止しました');
 if(/^\/admin\/(inquiries|users)(?:\/|$)/.test(path))await requireAdmin(request,new Store(env),path.startsWith('/admin/users')?'利用者管理の権限がありません':'問い合わせ管理の権限がありません');
 if(!path.startsWith('/api/'))return env.ASSETS?env.ASSETS.fetch(request):new Response('Creator Trace');
 if(!['GET','POST'].includes(request.method)&&!(request.method==='PATCH'&&/^\/api\/admin\/inquiries\/[^/]+\/status$/.test(path)))throw new HttpError(405,'Method not allowed');
 if(['POST','PATCH'].includes(request.method)) {
  if(request.headers.get('Origin')!==env.APP_ORIGIN)throw new HttpError(403,'Originが一致しません');
  if(Number(request.headers.get('Content-Length')??0)>64000||(await request.clone().arrayBuffer()).byteLength>64000)throw new HttpError(413,'ファイル本体は送信せず、メタデータのみ登録してください');
 }
 const s=new Store(env),key=await sha256(`${request.headers.get('CF-Connecting-IP')??'local'}:${path.startsWith('/api/auth/')?'auth':'api'}`),epoch=Math.floor(Date.now()/60000);
 const rate=await s.sql('INSERT INTO rate_limits(key,count,reset_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN reset_at=excluded.reset_at THEN count+1 ELSE 1 END,reset_at=excluded.reset_at RETURNING count',key,epoch).first<{count:number}>();
 if(rate!.count>(path.startsWith('/api/auth/')?30:240))throw new HttpError(429,'しばらく待ってからお試しください');
 const activation=await accountActivationsRoute(request,env);if(activation)return activation;
 if(path.startsWith('/api/auth/')&&path!=='/api/auth/owner-session')return auth(request,env,path);
 if(path.startsWith('/api/v1/'))return publicAPI(request,env);
 const inquiry=await inquiriesRoute(request,env);if(inquiry)return inquiry;
 const review=await botReviewsRoute(request,env);if(review)return review;
 const invitation=await projectInvitesRoute(request,env);if(invitation)return invitation;
 const operation=await operationsRoute(request,env);if(operation)return operation;
 return creatorRoute(request,env);
}
export default {
 async scheduled(_event:ScheduledController,env:Bindings,ctx:ExecutionContext){ctx.waitUntil(refreshProofs(env));ctx.waitUntil(expireInvites(env));ctx.waitUntil(expireAccountActivations(env));},
 async fetch(request:Request,env:Bindings):Promise<Response> {
  let response:Response;
  try {
   const origin=new URL(env.APP_ORIGIN); if((origin.protocol!=='https:' && origin.hostname!=='localhost') || origin.hostname!==env.RP_ID) throw new HttpError(503,'認証設定を確認してください');
   if(new URL(request.url).protocol!=='https:' && origin.hostname!=='localhost') throw new HttpError(403,'HTTPS required');
   if(new URL(request.url).origin!==env.APP_ORIGIN) throw new HttpError(403,'Origin configuration mismatch');
   response=await route(request,env);
  } catch(error) {response=Response.json({error:error instanceof HttpError?error.message:error instanceof z.ZodError?'入力内容が不正です':error instanceof SyntaxError?'JSONが不正です':'処理に失敗しました'}, {status:error instanceof HttpError?error.status:error instanceof z.ZodError||error instanceof SyntaxError?400:500,headers:error instanceof HttpError && error.status===401?{'WWW-Authenticate':'Session'}:{}});}
  const headers=new Headers(response.headers); headers.set('X-Content-Type-Options','nosniff');headers.set('Referrer-Policy','no-referrer');headers.set('Cache-Control','no-store');headers.set('Content-Security-Policy',"default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; connect-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  if(env.APP_ORIGIN.startsWith('https:')) headers.set('Strict-Transport-Security','max-age=31536000');
  return new Response(response.body,{status:response.status,headers});
 }
};
