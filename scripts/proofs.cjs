const {spawnSync}=require('node:child_process');
const {resolve}=require('node:path');
const result=spawnSync(resolve(__dirname,'../.venv/bin/python'),[resolve(__dirname,'proofs.py')],{stdio:'inherit'});
if(result.error)console.error('Python OTS環境が必要です。READMEの準備手順を実行してください。');
process.exit(result.status??1);
