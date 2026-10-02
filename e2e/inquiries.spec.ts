import {test,expect} from './fixtures';
import {installAuthenticator} from './authenticator';
test('Business問い合わせを管理者が確認・対応し一般ユーザーには公開しない',async({page,browser})=>{
 await page.goto('/business');await expect(page.getByText('送信後、内容を確認のうえご連絡します。この送信だけで契約・料金は発生しません。')).toBeVisible();
 for(const [label,value]of [['氏名','相談者'],['会社','テスト会社'],['メール','business@example.com'],['チーム人数','3人'],['現在のツール','Drive'],['課題','納品管理'],['メッセージ','相談したい']])await page.getByLabel(label,{exact:true}).fill(value);
 await page.getByRole('button',{name:'導入について問い合わせる'}).click();await expect(page.getByText('お問い合わせを受け付けました。')).toBeVisible();
 await page.goto('/setup');await page.getByLabel('ユーザーID').fill('11111111-1111-4111-8111-111111111111');await page.getByLabel('初期設定トークン').fill('e2e-operator-only');await page.getByRole('button',{name:'登録する'}).click();await expect(page).toHaveURL(/\/settings\/security$/);
 await expect(page.getByRole('navigation').getByRole('link')).toHaveText(['案件','制作物','問い合わせ','認証設定']);
 await page.getByRole('navigation').getByRole('link',{name:'問い合わせ',exact:true}).click();await expect(page.getByRole('heading',{name:'問い合わせ',exact:true})).toBeVisible();await page.getByRole('link',{name:'相談者',exact:true}).click();
 await expect(page.getByRole('heading',{name:'問い合わせ詳細'})).toBeVisible();await expect(page.locator('dd').filter({hasText:'未対応'})).toBeVisible();
 await page.getByRole('button',{name:'対応を開始'}).click();await expect(page.locator('dd').filter({hasText:'対応中'})).toBeVisible();
 await page.getByRole('button',{name:'完了にする'}).click();await expect(page.locator('dd').filter({hasText:'完了'})).toBeVisible();await expect(page.getByText('相談したい',{exact:true})).toBeVisible();
 const url=page.url();const context=await browser.newContext();const other=await context.newPage();await installAuthenticator(other);await other.goto('/signup');await other.getByLabel('表示名').fill('Punka');await other.getByLabel('最初の案件名').fill('一般案件');await other.getByRole('button',{name:'登録する'}).click();await expect(other).toHaveURL(/\/projects$/);
 const deniedDetail=await other.goto(url);expect(deniedDetail!.status()).toBe(403);await expect(other.getByText('問い合わせ管理の権限がありません')).toBeVisible();await expect(other.getByText('business@example.com')).toHaveCount(0);await expect(other.getByRole('navigation').getByRole('link',{name:'問い合わせ',exact:true})).toHaveCount(0);
 const deniedList=await other.goto('/admin/inquiries');expect(deniedList!.status()).toBe(403);await expect(other.getByText('問い合わせ管理の権限がありません')).toBeVisible();await context.close();
});
