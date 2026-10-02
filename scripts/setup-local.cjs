const fs=require('node:fs');const {randomBytes}=require('node:crypto');const {resolve}=require('node:path');
const file=resolve(__dirname,'../api/.dev.vars');
if(!fs.existsSync(file)){fs.writeFileSync(file,['OPERATOR_TOKEN'].map(name=>`${name}=${randomBytes(32).toString('hex')}`).join('\n')+'\n',{mode:0o600,flag:'wx'});console.log('api/.dev.vars に開発用の秘密鍵を作成しました（ログには表示しません）。');}else console.log('既存のapi/.dev.varsを使用します。');
