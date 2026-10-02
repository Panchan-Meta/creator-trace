import {test,expect} from './fixtures';
import {installAuthenticator} from './authenticator';
test('セルフサービス初回登録・追加Passkey・ログアウトと実署名ログイン',async({page})=>{
 await installAuthenticator(page);await page.goto('/signup');await page.getByLabel('表示名').fill('Punka');await page.getByLabel('最初の案件名').fill('実ファイル運用');await page.getByRole('button',{name:'登録する'}).click();
 await expect(page).toHaveURL(/\/projects$/);await expect(page.getByRole('link',{name:'実ファイル運用',exact:true})).toBeVisible();
 await page.goto('/settings/security');await expect(page.getByText('登録済み：1件')).toBeVisible();await page.getByLabel('追加Passkeyの名前').fill('Backup device');await page.getByRole('button',{name:'パスキーを追加'}).click();await expect(page.getByText('登録済み：2件')).toBeVisible();await expect(page.getByText(/Backup device/)).toBeVisible();
 await page.getByRole('button',{name:'ログアウト'}).click();await expect(page).toHaveURL(/\/login$/);await page.getByRole('button',{name:'パスキーでログイン'}).click();await expect(page).toHaveURL(/\/projects$/);await expect(page.getByRole('link',{name:'実ファイル運用',exact:true})).toBeVisible();
});
