import {test,expect} from './fixtures';
test('Versionの5Botレビュー・実行中表示・最新のみ表示・再読込・失敗表示と状態不変',async({page})=>{
 await page.goto('/setup');await page.getByLabel('ユーザーID').fill('11111111-1111-4111-8111-111111111111');await page.getByLabel('初期設定トークン').fill('e2e-operator-only');await page.getByRole('button',{name:'登録する'}).click();await expect(page).toHaveURL(/\/settings\/security$/);
 const headers={Origin:'http://localhost:8791'};
 const project=await (await page.request.post('/api/projects',{headers,data:{name:'AI browser test'}})).json();
 const asset=await (await page.request.post(`/api/projects/${project.id}/assets`,{headers,data:{filename:'review.wav',mime_type:'audio/wav',size:3,sha256:'c'.repeat(64),status:'SUBMITTED',comment:'実データ'}})).json();
 // xAI transport is mocked; DB persistence and all five real calls are covered in the Worker tests.
 let runs:any[]=[],fail=false,release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
 const bots=[['sanada','真田 蓮','技術・版管理レビュー'],['mido','御堂 玲','セキュリティ・証跡レビュー'],['shiraishi','白石 律','ガバナンスレビュー'],['mizuki','水城 澪','顧客・運用レビュー'],['tachibana','橘 司','統合レビュー']];
 await page.route(`**/api/projects/${project.id}/bot-reviews**`,async route=>{
  if(route.request().method()==='GET'){await route.fulfill({json:runs});return;}
  expect(route.request().postDataJSON()).toEqual({assetVersionId:asset.version_id});await gate;
  const run={id:String(runs.length),asset_version_id:asset.version_id,created_at:new Date().toISOString(),status:fail?'FAILED':'COMPLETED',messages:fail?[]:bots.map(([bot_key,bot_name,role])=>({bot_key,bot_name,role,content:`${bot_name} レビュー${runs.length + 1}本文\n未確認事項あり`}))};runs.unshift(run);
  await route.fulfill({status:fail?502:201,json:fail?{error:'AIレビューに失敗しました。制作データには変更ありません。'}:run});
 });
 await page.goto(`/assets/${asset.id}`);const section=page.locator('.ai-reviews');await expect(section.getByRole('heading',{name:'AI制作レビュー'})).toBeVisible();await expect(section.getByText('対象Version：Version 1')).toBeVisible();await expect(section.getByText('現在状態：SUBMITTED')).toBeVisible();
 await section.getByRole('button',{name:'5人のBotでレビューする'}).click();await expect(section.getByRole('button',{name:'AIレビュー中...'})).toBeDisabled();release();
 for(const [,name]of bots)await expect(section.getByRole('heading',{name,exact:true})).toBeVisible();await expect(section.getByText('AIレビューは参考情報です。状態の変更はお客様が行います。')).toBeVisible();
 await section.getByRole('button',{name:'5人のBotでレビューする'}).click();await expect(section.locator('details')).toHaveCount(1);await expect(section.getByText('橘 司 レビュー2本文',{exact:false})).toBeVisible();await expect(section.getByText('橘 司 レビュー1本文',{exact:false})).toHaveCount(0);expect(runs).toHaveLength(2);await page.reload();await expect(section.locator('details')).toHaveCount(1);await expect(section.getByText('橘 司 レビュー2本文',{exact:false})).toBeVisible();fail=true;await section.getByRole('button',{name:'5人のBotでレビューする'}).click();await expect(section.getByText('AIレビューに失敗しました。制作データには変更ありません。').first()).toBeVisible();await expect(section.getByRole('heading',{name:'橘 司',exact:true})).toHaveCount(0);await expect(section.locator('details')).toHaveCount(1);await page.reload();await expect(section.getByRole('heading',{name:'橘 司',exact:true})).toHaveCount(0);expect(runs).toHaveLength(3);
 const actual=await (await page.request.get(`/api/assets/${asset.id}`)).json();expect(actual.versions[0].status).toBe('SUBMITTED');
});
