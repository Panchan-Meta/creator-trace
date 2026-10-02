import {test,expect} from './fixtures';
import {installAuthenticator} from './authenticator';
test('ADMIN発行 → 顧客Passkey登録 → 案件なし → 最初の案件OWNER、再ログインと権限分離',async({page,browser})=>{
 await page.goto('/setup');await page.getByLabel('ユーザーID').fill('11111111-1111-4111-8111-111111111111');await page.getByLabel('初期設定トークン').fill('e2e-operator-only');await page.getByRole('button',{name:'登録する'}).click();await expect(page).toHaveURL(/\/settings\/security$/);
 await page.getByRole('link',{name:'利用者管理',exact:true}).click();await expect(page.getByRole('heading',{name:'利用者管理',exact:true})).toBeVisible();
 const email=`customer-${Date.now()}@example.com`;await page.getByLabel('メール',{exact:true}).fill(email);await page.getByRole('button',{name:'利用開始URLを発行'}).click();const url=page.getByLabel('利用開始URL',{exact:true});await expect(url).toHaveValue(/\/activate\/[a-f0-9]{64}$/);const activationURL=await url.inputValue();
 for(const width of [1440,390]){await page.setViewportSize({width,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
 const customerContext=await browser.newContext({extraHTTPHeaders:{'CF-Connecting-IP':'e2e-activation-customer'},viewport:{width:390,height:844}});const customer=await customerContext.newPage();const authenticator=await installAuthenticator(customer);
 await customer.goto(activationURL);await expect(customer.getByRole('heading',{name:'Creator Trace 利用開始',exact:true})).toBeVisible();await expect(customer.getByText(email,{exact:true})).toBeVisible();await expect(customer.getByLabel('案件名')).toHaveCount(0);
 expect(await customer.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await customer.getByLabel('表示名',{exact:true}).fill('  山田 太郎  ');await customer.getByRole('button',{name:'Passkeyを登録して利用開始'}).click();await expect(customer.getByRole('heading',{name:'利用開始登録が完了しました'})).toBeVisible();expect(authenticator.calls.map(c=>c.kind)).toEqual(['create']);
 await customer.getByRole('link',{name:'Creator Traceを開く'}).click();await expect(customer.getByText('まだ案件がありません。',{exact:true})).toBeVisible();await expect(customer.getByRole('link',{name:'最初の案件を作成',exact:true})).toHaveAttribute('href','#new-project');
 await expect(customer.locator('nav a')).toHaveText(['案件','制作物','認証設定']);
 const session=await (await customer.request.get('/api/auth/session')).json();expect(session).toMatchObject({display_name:'山田 太郎',is_admin:false,memberships:[]});
 expect((await customer.request.get('/admin/users')).status()).toBe(403);expect((await customer.request.get('/api/admin/users')).status()).toBe(403);expect((await customer.request.get('/api/admin/inquiries')).status()).toBe(403);
 await customer.getByLabel('案件名',{exact:true}).fill('山田の最初の案件');await customer.getByRole('button',{name:'登録する',exact:true}).click();await expect(customer.getByRole('heading',{name:'山田の最初の案件',exact:true})).toBeVisible();await expect(customer.getByRole('heading',{name:'新しい制作物を登録',exact:true})).toBeVisible();
 const projectId=new URL(customer.url()).pathname.split('/').at(-1)!;const members=await (await customer.request.get(`/api/projects/${projectId}/members`)).json();expect(members).toHaveLength(1);expect(members[0]).toMatchObject({user_id:session.recipient_id,role:'OWNER',status:'ACTIVE',joined_at:expect.any(String)});
 await customer.getByRole('button',{name:'ログアウト'}).click();await expect(customer).toHaveURL(/\/login$/);await customer.getByRole('button',{name:'パスキーでログイン'}).click();await expect(customer).toHaveURL(/\/projects$/);expect(authenticator.calls.map(c=>c.kind)).toEqual(['create','get']);
 await customer.goto(activationURL);await expect(customer.getByText('この利用開始URLは使用済みです。',{exact:true})).toBeVisible();
 await page.reload();await expect(page.getByLabel('利用開始URL',{exact:true})).toHaveCount(0);await expect(page.locator('section.card').filter({hasText:email}).filter({hasText:'ACTIVATED'})).toBeVisible();await expect(page.getByText('山田 太郎',{exact:true})).toBeVisible();
 await customerContext.close();
});
test('ADMIN画面で未使用発行を取り消せて、再発行しても古いURLは利用不可',async({page,browser})=>{
 await page.goto('/setup');await page.getByLabel('ユーザーID').fill('11111111-1111-4111-8111-111111111111');await page.getByLabel('初期設定トークン').fill('e2e-operator-only');await page.getByRole('button',{name:'登録する'}).click();await expect(page).toHaveURL(/\/settings\/security$/);await page.goto('/admin/users');
 const email=`cancel-${Date.now()}@example.com`;await page.getByLabel('メール',{exact:true}).fill(email);await page.getByRole('button',{name:'利用開始URLを発行'}).click();const field=page.getByLabel('利用開始URL',{exact:true});await expect(field).toHaveValue(/\/activate\//);const old=await field.inputValue();
 const card=page.locator('section.card').filter({hasText:email});await card.getByRole('button',{name:'発行を取り消す'}).click();await expect(card).toContainText('REVOKED');
 const context=await browser.newContext({extraHTTPHeaders:{'CF-Connecting-IP':'e2e-activation-cancel'}}),customer=await context.newPage();await customer.goto(old);await expect(customer.getByText('この利用開始URLは取り消されています。',{exact:true})).toBeVisible();await expect(customer.getByRole('button',{name:'Passkeyを登録して利用開始'})).toHaveCount(0);
 await page.getByLabel('メール',{exact:true}).fill(email);await page.getByRole('button',{name:'利用開始URLを発行'}).click();await expect(field).toHaveValue(/\/activate\//);expect(await field.inputValue()).not.toBe(old);await customer.reload();await expect(customer.getByText('この利用開始URLは取り消されています。',{exact:true})).toBeVisible();await context.close();
});
