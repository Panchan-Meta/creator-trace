import {test,expect} from './fixtures';
// UI-only fixtures. Chain cryptography and D1 persistence are covered separately by API tests.
test('Bitcoinアンカー表示・再確認・確認済みの再検証失敗をPC/スマホで表示',async({page})=>{
 await page.goto('/setup');await page.getByLabel('ユーザーID').fill('11111111-1111-4111-8111-111111111111');await page.getByLabel('初期設定トークン').fill('e2e-operator-only');await page.getByRole('button',{name:'登録する'}).click();await expect(page).toHaveURL(/\/settings\/security$/);
 const headers={Origin:new URL(page.url()).origin};
 const project=(await (await page.request.post('/api/projects',{headers,data:{name:'Bitcoin UI test'}})).json()).id;
 const asset=await (await page.request.post(`/api/projects/${project}/assets`,{headers,data:{filename:'test.wav',size:4,sha256:'7'.repeat(64),status:'DRAFT'}})).json();
 expect(project).toBeTruthy();expect(asset.proof_id).toBeTruthy();
 const proof=await (await page.request.get(`/api/proofs/${asset.proof_id}`)).json();let phase=0;
 await page.route(`**/api/proofs/${proof.id}`,async route=>route.fulfill({json:{...proof,ots_proof:'UI fixture only',timestamp_created_at:'2026-01-01T00:00:00Z',bitcoin_confirmed_at:phase?'2026-10-02T01:00:00Z':null,bitcoin_block_height:100,bitcoin_block_hash:phase?'a'.repeat(64):null,bitcoin_block_time:phase?'2023-11-14T22:13:20Z':null,verification:{state:phase?'BITCOIN_VERIFIED':'BITCOIN_ANCHOR_FOUND',has_ots:true,api_configured:false,anchors:[{height:100}],last_attempt:phase?{state:'VERIFY_FAILED',error_code:'BITCOIN_API_TIMEOUT',checked_at:'2026-10-02T02:00:00Z'}:null}}}));
 await page.goto(`/proof/${proof.id}/check`);await expect(page.locator('.proof-verification')).toContainText('Bitcoinアンカー情報あり・チェーン検証未実施');await expect(page.locator('.proof-verification')).not.toContainText('未確認（検証設定が必要）');await expect(page.getByRole('button',{name:'Bitcoinを再確認',exact:true})).toBeVisible();await expect(page.locator('.proof-verification')).toContainText('Bitcoinブロック高さ');
 let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;});
 await page.route(`**/api/proofs/${proof.id}/bitcoin-recheck`,async route=>{await pending;phase=1;await route.fulfill({json:{ok:true}});});
 await page.getByRole('button',{name:'Bitcoinを再確認',exact:true}).click();await expect(page.getByRole('button',{name:'Bitcoinを再確認',exact:true})).toBeDisabled();release();
 await expect(page.locator('.proof-verification')).toContainText('直近のBitcoin再確認は失敗しました');await expect(page.locator('.proof-verification')).toContainText('確認済み');await expect(page.locator('.proof-verification')).toContainText('Bitcoinブロック採掘日時');await expect(page.getByRole('button',{name:'Bitcoinを再確認',exact:true})).toBeVisible();
 for(const width of [1280,390]){await page.setViewportSize({width,height:900});await page.getByRole('button',{name:'Bitcoinを再確認',exact:true}).scrollIntoViewIfNeeded();await expect(page.getByRole('button',{name:'Bitcoinを再確認',exact:true})).toBeInViewport();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);}
});
