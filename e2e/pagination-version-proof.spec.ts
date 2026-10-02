import {test,expect} from './fixtures';
import type {Page} from '@playwright/test';
async function login(page:Page){await page.goto('/setup');await page.getByLabel('ユーザーID').fill('11111111-1111-4111-8111-111111111111');await page.getByLabel('初期設定トークン').fill('e2e-operator-only');await page.getByRole('button',{name:'登録する'}).click();await expect(page).toHaveURL(/\/settings\/security$/);}
for(const kind of ['projects','assets'])test(`${kind}: 0件・1件・中間・最終ページと検索条件保持`,async({page})=>{
 await login(page);const q=`paging-${kind}-${Date.now()}`,headers={Origin:new URL(page.url()).origin};let project:string|undefined;
 async function add(){if(kind==='projects')return (await (await page.request.post('/api/projects',{headers,data:{name:q}})).json()).id;
  project??=(await (await page.request.post('/api/projects',{headers,data:{name:'Asset list pagination'}})).json()).id;
  return (await (await page.request.post(`/api/projects/${project}/assets`,{headers,data:{name:q,filename:`${q}.wav`,size:1,sha256:'a'.repeat(64)}})).json()).id;
 }
 const path=`/${kind}?q=${encodeURIComponent(q)}&limit=1`;
 await page.goto(path);await expect(page.getByText('まだ登録されていません。')).toBeVisible();await expect(page.getByRole('navigation',{name:'ページ切り替え'})).toHaveCount(0);
 await add();await page.goto(path);await expect(page.getByRole('link',{name:q,exact:true})).toBeVisible();await expect(page.getByRole('link',{name:'次へ',exact:true})).toHaveCount(0);await expect(page.getByRole('link',{name:'前へ',exact:true})).toHaveCount(0);
 await expect(page.locator('#account-status')).toContainText('ログイン中：Punka');await expect(page.locator('#account-status')).not.toContainText(q);await expect(page.locator('#account-status')).not.toContainText('Owner');
 await add();await add();await page.goto(path);await expect(page.getByRole('link',{name:'次へ',exact:true})).toBeVisible();await expect(page.getByRole('link',{name:'前へ',exact:true})).toHaveCount(0);
 await page.getByRole('link',{name:'次へ',exact:true}).click();await expect(page).toHaveURL(/page=2/);await expect(page.getByRole('link',{name:'前へ',exact:true})).toBeVisible();await expect(page.getByRole('link',{name:'次へ',exact:true})).toBeVisible();expect(new URL(page.url()).searchParams.get('q')).toBe(q);expect(new URL(page.url()).searchParams.get('limit')).toBe('1');
 await page.getByRole('link',{name:'次へ',exact:true}).click();await expect(page).toHaveURL(/page=3/);await expect(page.getByRole('link',{name:'前へ',exact:true})).toBeVisible();await expect(page.getByRole('link',{name:'次へ',exact:true})).toHaveCount(0);
 await page.getByRole('link',{name:'前へ',exact:true}).click();await expect(page).toHaveURL(/page=2/);await expect(page.getByLabel('検索',{exact:true})).toHaveValue(q);
});
test('案件トップの登録アンカー、手入力フォームなし、OWNERと招待管理を維持',async({page})=>{
 await login(page);const headers={Origin:new URL(page.url()).origin},project=await (await page.request.post('/api/projects',{headers,data:{name:'Anchor project'}})).json();
 await page.goto(`/projects/${project.id}`);await expect(page.getByRole('heading',{name:'担当者・制作者を登録'})).toHaveCount(0);await expect(page.getByLabel('氏名',{exact:true})).toHaveCount(0);await expect(page.getByRole('heading',{name:'案件メンバー',exact:true})).toBeVisible();await expect(page.locator('table').first()).toContainText('OWNER');await expect(page.getByRole('heading',{name:'案件メンバーを招待'})).toBeVisible();await expect(page.getByRole('heading',{name:'招待中',exact:true})).toBeVisible();await expect(page.getByRole('heading',{name:'招待履歴（最新3件）'})).toBeVisible();
 const anchor=page.getByRole('link',{name:'新しい制作物を登録',exact:true});await expect(anchor).toHaveAttribute('href','#new-asset');await expect(page.locator('#new-asset form')).toBeVisible();await anchor.click();await expect(page).toHaveURL(/#new-asset$/);await expect(page.locator('#new-asset h2')).toBeInViewport();
 await expect(page.locator('#account-status')).not.toContainText('Anchor project');await expect(page.locator('#account-status')).not.toContainText('Owner');
});
// UI-only chain fixtures; independent proof persistence and OTS upgrade are tested against D1 in operations.spec.ts.
test('旧Versionと新Versionの画面で、それぞれのProofのBitcoin情報と再確認APIを使用',async({page})=>{
 await login(page);const headers={Origin:new URL(page.url()).origin},project=await (await page.request.post('/api/projects',{headers,data:{name:'Independent proof UI'}})).json();
 const a=await (await page.request.post(`/api/projects/${project.id}/assets`,{headers,data:{filename:'v1.wav',size:1,sha256:'7'.repeat(64),status:'DRAFT'}})).json();
 const v2=await (await page.request.post(`/api/assets/${a.id}/versions`,{headers,data:{filename:'v2.wav',size:2,sha256:'8'.repeat(64),status:'DRAFT'}})).json();
 const calls:string[]=[];
 for(const [proofId,height,hash] of [[a.proof_id,100,'a'.repeat(64)],[v2.proof_id,200,'b'.repeat(64)]] as [string,number,string][]){
  await page.route(`**/api/proofs/${proofId}`,async route=>{const response=await route.fetch(),p=await response.json();await route.fulfill({json:{...p,ots_proof:'UI-only receipt',timestamp_created_at:'2026-10-02T02:46:47.385Z',bitcoin_block_height:height,bitcoin_block_hash:hash,bitcoin_block_time:'2026-10-01T18:35:46.000Z',verification:{state:'BITCOIN_VERIFIED',has_ots:true,anchors:[{height}],last_attempt:null}}});});
  await page.route(`**/api/proofs/${proofId}/bitcoin-recheck`,async route=>{calls.push(proofId);await route.fulfill({json:{ok:true,verificationStatus:'CONFIRMED',blockHeight:height,blockHash:hash}});});
 }
 for(const [versionId,proofId,height,hash] of [[a.version_id,a.proof_id,100,'a'.repeat(64)],[v2.id,v2.proof_id,200,'b'.repeat(64)]] as [string,string,number,string][]){
  await page.goto(`/assets/${a.id}/versions/${versionId}`);await expect(page.locator('.proof-verification')).toContainText(String(height));await expect(page.locator('.proof-verification')).toContainText(hash);await expect(page.locator('.proof-verification')).toContainText('2026/10/02 03:35:46');await expect(page.locator('.proof-verification')).toContainText('2026/10/02 11:46:47');
  await page.getByRole('button',{name:'Bitcoinを再確認',exact:true}).click();await expect.poll(()=>calls.at(-1)).toBe(proofId);await expect(page.locator('.proof-verification')).toContainText(hash);
 }
 expect(calls).toEqual([a.proof_id,v2.proof_id]);
});
