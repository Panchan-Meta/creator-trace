import {test,expect} from './fixtures';
import {createHash} from 'node:crypto';
import {mkdtemp,open,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('1 GiB超の実ファイルをブラウザWorkerで照合しUIの応答を維持する',async({page})=>{
 const request=page.request;
 test.setTimeout(180000);
 const dir=await mkdtemp(join(tmpdir(),'creator-trace-large-')),filename=join(dir,'large-video-test.bin'),size=1024*1024*1024+1;
 try{
  const file=await open(filename,'w');await file.truncate(size);await file.close();
  const hash=createHash('sha256'),chunk=Buffer.alloc(4*1024*1024);for(let offset=0;offset<size;offset+=chunk.length)hash.update(chunk.subarray(0,Math.min(chunk.length,size-offset)));
  const headers={Origin:'http://localhost:8791'};
  const session=await request.post('/api/auth/owner-session',{headers:{...headers,Authorization:'Bearer e2e-operator-only'},data:{user_id:'11111111-1111-4111-8111-111111111111'}});expect(session.status()).toBe(200);
  const project=await (await request.post('/api/projects',{headers,data:{name:'Local large file test'}})).json();
  const asset=await (await request.post(`/api/projects/${project.id}/assets`,{headers,data:{filename:'large-video-test.bin',size,sha256:hash.digest('hex'),status:'DRAFT'}})).json();
  await page.goto(`/proof/${asset.proof_id}/check`);await expect(page.getByRole('heading',{name:'Creator Trace Proof'})).toBeVisible();await page.getByLabel('確認するファイル').setInputFiles(filename);
  await page.evaluate(()=>{(window as any).hashUITicks=0;setInterval(()=>(window as any).hashUITicks++,100);});
  await page.getByRole('button',{name:'ファイルを照合する'}).click();await expect(page.getByText(/^SHA-256を計算しています… \d+%$/)).toBeVisible();
  await expect(page.getByRole('status')).toContainText('SHA-256が一致しました',{timeout:150000});expect(await page.evaluate(()=>(window as any).hashUITicks)).toBeGreaterThan(10);
 }finally{await rm(dir,{recursive:true,force:true});}
});
