// Explicit operator provisioning; never infer administration from a display name or project role.
const {spawnSync}=require('node:child_process');
const path=require('node:path');
const userId=process.argv.find(arg=>arg.startsWith('--user-id='))?.slice(10);
if(!userId||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(userId))throw new Error('Specify --user-id=<existing user UUID>');
const result=spawnSync(process.execPath,[path.resolve(__dirname,'../node_modules/wrangler/bin/wrangler.js'),'d1','execute','creator-trace-db',process.argv.includes('--remote')?'--remote':'--local','--config',path.resolve(__dirname,'../api/wrangler.jsonc'),'--command',`INSERT INTO site_admins(user_id,created_at) VALUES('${userId}',strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(user_id) DO NOTHING`],{stdio:'inherit'});
if(result.status===0)console.log(`システム権限ADMINを付与しました: ${userId}（既存ユーザー・Passkeyは変更していません）`);
process.exit(result.status??1);
