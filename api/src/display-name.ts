import {z} from 'zod';
export const displayName=z.string({error:'表示名を入力してください'}).trim().min(1,{error:'表示名を入力してください'}).max(50,{error:'表示名は50文字以内で入力してください'});
