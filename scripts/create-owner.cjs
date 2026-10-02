// Provision an owner. Does not print secrets or create certificate invitations.
const {randomUUID}=require('node:crypto');
const {spawnSync}=require('node:child_process');
const path=require('node:path');
const remote=process.argv.includes('--remote');
const userId=randomUUID();
const sql=`INSERT INTO users(id,display_name,created_at) VALUES('${userId}','Creator Trace owner',strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;
const result=spawnSync(process.execPath,[path.resolve(__dirname,'../node_modules/wrangler/bin/wrangler.js'),'d1','execute','creator-trace-db',remote?'--remote':'--local','--config',path.resolve(__dirname,'../api/wrangler.jsonc'),'--command',sql],{stdio:'inherit'});
if(result.status!==0)process.exit(result.status??1);
console.log(`ユーザーID: ${userId}\n/setup でこのIDとOPERATOR_TOKENを入力し、パスキーを登録してください。`);
