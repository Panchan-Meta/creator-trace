import {describe,it,expect} from 'vitest';
import {proofVerification,isPublicProof} from '../src/proof-view';
import type {Bindings} from '../src/store';
const env={} as Bindings;
const pending={proof_status:'PENDING',timestamp_status:'NOT_REQUESTED',bitcoin_status:'NOT_REQUESTED',ots_proof:null,retry_count:0};
function receipt(bitcoin=false){const hash='a'.repeat(64),tree=bitcoin?Buffer.concat([Buffer.from('000588960d73d7190101','hex'),Buffer.from([1])]):Buffer.concat([Buffer.from('0083dfe30d2ef90c8e','hex'),Buffer.from([3,2]),Buffer.from('xx')]);return {sha256:hash,ots_proof:Buffer.concat([Buffer.from('004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e892940108','hex'),Buffer.from(hash,'hex'),tree]).toString('base64')};}
describe('証跡の状態を日時の欠落だけで推測しない',()=>{
 it('未実行と、日時だけ存在する状態を区別する',()=>{expect(proofVerification(pending,env).state).toBe('NOT_REQUESTED');expect(proofVerification({timestamp_created_at:'2026-10-01T17:47:59Z'},env).state).toBe('UNKNOWN');});
 it('失敗を確認待ちと表示しない',()=>{expect(proofVerification({...pending,last_retry_at:'2026-10-01',proof_status:'FAILED',error_code:'OTS_CREATION_FAILED'},env).state).toBe('VERIFY_FAILED');});
 it('外部証跡のpendingとBitcoin検証未完了を区別する',()=>{expect(proofVerification(receipt(),env).state).toBe('WAITING_BITCOIN');expect(proofVerification(receipt(true),env).state).toBe('BITCOIN_ANCHOR_FOUND');expect(proofVerification(receipt(true),{BITCOIN_RPC_URL:'https://node.invalid'} as Bindings).state).toBe('BITCOIN_ANCHOR_FOUND');});
 it('記録済みのgeneric失敗でも現在の接続未設定を判別する',()=>{expect(proofVerification({...receipt(true),error_code:'TIMESTAMP_PROCESSING_FAILED'},env).state).toBe('BITCOIN_ANCHOR_FOUND');});
 it('Bitcoin日時がなくても確認済みの状態を勝手に待機へ戻さない',()=>{expect(proofVerification({proof_status:'CONFIRMED',bitcoin_status:'CONFIRMED'},env).state).toBe('BITCOIN_VERIFIED');});
 it('不正証跡と未知の内部エラーを安全に扱う',()=>{const summary=proofVerification({ots_proof:'invalid',sha256:'a'.repeat(64),error_code:'private URL with credentials'},env);expect(summary.state).toBe('RECEIPT_INVALID');expect(summary.error_code).toBe('TIMESTAMP_PROCESSING_FAILED');expect(JSON.stringify(summary)).not.toContain('private URL');});
 it('公開対象は明示されたIDのみ、案件名や所有者名では判断しない',()=>{expect(isPublicProof(env,'own-music')).toBe(false);expect(isPublicProof({PUBLIC_PROOF_IDS:' own-music, another-proof '} as Bindings,'own-music')).toBe(true);expect(isPublicProof({PUBLIC_PROOF_IDS:'own-music'} as Bindings,'private')).toBe(false);});
});
