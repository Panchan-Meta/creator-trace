import Papa from 'papaparse';
import { z } from 'zod';
export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
export const now = () => new Date().toISOString();
export const id = () => crypto.randomUUID();
export async function sha256(text: string) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(n => n.toString(16).padStart(2,'0')).join(''); }
export function randomToken() { return [...crypto.getRandomValues(new Uint8Array(32))].map(n => n.toString(16).padStart(2,'0')).join(''); }
const safeText = (max: number) => z.string().trim().min(1).max(max).refine(s => !/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(s), '不正文字');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => { const d = new Date(s); return !isNaN(d.valueOf()) && d.toISOString().slice(0,10)===s; }, '不正日付');
export const csvRow = z.object({name:safeText(100),email:z.email().max(254).transform(s=>s.toLowerCase()),course:safeText(200),completed_at:date});
export type Row = z.infer<typeof csvRow> & { row_number:number; errors:string[] };
export function parseCSV(csv:string):Row[] {
 if(new TextEncoder().encode(csv).length>1_000_000) throw new HttpError(413,'CSVは1MB以下にしてください');
 const parsed = Papa.parse<string[]>(csv.replace(/^\uFEFF/,''),{skipEmptyLines:false});
 if(parsed.errors.length) throw new HttpError(400,'CSV構文が不正です');
 const headers=parsed.data.shift()?.map(s=>s.trim());
 const required=['name','email','course','completed_at'];
 if(!headers || headers.length!==4 || new Set(headers).size!==4 || required.some(h=>!headers.includes(h))) throw new HttpError(400,'CSVヘッダはname,email,course,completed_atが必要です');
 // Ignore only the final newline; internal empty records are validation errors.
 if(parsed.data.at(-1)?.every(s=>s==='')) parsed.data.pop();
 if(!parsed.data.length || parsed.data.length>50) throw new HttpError(400,'CSVは1〜50行にしてください');
 const seen=new Set<string>();
 return parsed.data.map((cells,i)=>{
  const raw=Object.fromEntries(headers.map((h,j)=>[h,(cells[j]??'').trim()]));
  const result=csvRow.safeParse(raw);
  const errors=result.success?[]:result.error.issues.map(e=>`${e.path.join('.')}: ${e.message}`);
  if(cells.length!==4) errors.push('列数が不正です');
  if(cells.every(s=>!s.trim())) errors.push('空行です');
  const value=result.success?result.data:raw as z.infer<typeof csvRow>;
  const key=`${value.email.toLowerCase()}\u0000${value.course.normalize('NFC')}`;
  if(seen.has(key)) errors.push('同一人物・講座が重複しています');
  seen.add(key);
  return {...value,course:value.course.normalize('NFC'),row_number:i+2,errors};
 });
}
export function canonicalPayload(c:{certificate_id:string;issuer_id:string;course_id:string;issued_at:string;document_hash:string},status:'ACTIVE'|'REVOKED') {
 // Fixed lexical key order, six fields only. Never include source CSV, recipients or PII.
 return JSON.stringify({certificateId:c.certificate_id,courseId:c.course_id,documentHash:c.document_hash,issuedAt:c.issued_at,issuerId:c.issuer_id,status});
}
export function displayStatus(status:string) { return status==='ACTIVE'?{label:'VALID',symbol:'✓',message:'この修了証は有効です'}:status==='REVOKED'?{label:'REVOKED',symbol:'×',message:'この修了証は失効しています'}:{label:'PENDING',symbol:'!',message:'証明処理を確認中です'}; }
