import {test,expect} from './fixtures';
import {installAuthenticator} from './authenticator';
test('公開トップはログイン導線のみで、旧signupはログインへ移動する',async({page})=>{
 await page.goto('/');await expect(page.getByRole('link',{name:'ログイン',exact:true})).toHaveAttribute('href','/login');await expect(page.getByRole('link',{name:'導入について相談する'})).toHaveAttribute('href','/business');await expect(page.getByText('無料で試す',{exact:true})).toHaveCount(0);
 for(const text of ['導入前の確認 無料：納品の流れ、原本の置き場、証跡の有無を見て、導入パックが要るかを提案。','導入パック 121,500円 ＋ カスタマイズ費用','カスタマイズ費用は、必要な機能・運用内容を確認したうえで個別に見積もります。','保守は任意です。要る場合は32,000円です。導入時に決めます。'])await expect(page.getByText(text,{exact:true})).toBeVisible();
 await page.getByRole('link',{name:'ログイン',exact:true}).click();await expect(page.getByRole('heading',{name:'ログイン',exact:true})).toBeVisible();await expect(page.getByText('説明会のあと、渡したアカウントで入ります。',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'パスキーでログイン'})).toBeVisible();
 await page.goto('/signup');await expect(page).toHaveURL(/\/login$/);await expect(page.getByLabel('表示名',{exact:true})).toHaveCount(0);await expect(page.getByLabel('最初の案件名')).toHaveCount(0);await expect(page.getByRole('button',{name:'登録する',exact:true})).toHaveCount(0);await expect(page.locator('form')).toHaveCount(0);
 const stopped=await page.request.post('/api/auth/signup',{headers:{Origin:'http://localhost:8791'},data:{name:'Nobody',project_name:'No project'}});expect(stopped.status()).toBe(410);
});
test('発行済みアカウントの初期設定・追加Passkey・ログアウトと実署名ログイン',async({page})=>{
 await installAuthenticator(page);await page.goto('/setup');await page.getByLabel('ユーザーID').fill('11111111-1111-4111-8111-111111111111');await page.getByLabel('初期設定トークン').fill('e2e-operator-only');await page.getByRole('button',{name:'登録する'}).click();await expect(page).toHaveURL(/\/settings\/security$/);
 const before=(await (await page.request.get('/api/auth/passkeys')).json()).passkeys.length;
 await page.getByLabel('追加Passkeyの名前').fill('Issued account Passkey');await page.getByRole('button',{name:'パスキーを追加'}).click();await expect(page.getByText(`登録済み：${before+1}件`)).toBeVisible();
 await page.getByLabel('追加Passkeyの名前').fill('Backup device');await page.getByRole('button',{name:'パスキーを追加'}).click();await expect(page.getByText(`登録済み：${before+2}件`)).toBeVisible();await expect(page.getByText(/Backup device/)).toBeVisible();
 await page.goto('/projects');await page.getByLabel('案件名',{exact:true}).fill('実ファイル運用');await page.getByRole('button',{name:'登録する'}).click();await expect(page.getByRole('heading',{name:'実ファイル運用',exact:true})).toBeVisible();
 await page.goto('/settings/security');
 await page.getByRole('button',{name:'ログアウト'}).click();await expect(page).toHaveURL(/\/login$/);await page.getByRole('button',{name:'パスキーでログイン'}).click();await expect(page).toHaveURL(/\/projects$/);await expect(page.getByRole('link',{name:'実ファイル運用',exact:true})).toBeVisible();
});
