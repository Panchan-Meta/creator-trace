import {env} from 'cloudflare:test';
import {it,expect} from 'vitest';
import {parseReceipt,verifyBitcoin} from '../src/proof';
import fixture from './fixtures/calendar-pending.json';
const receipt=(env as unknown as {TEST_OTS:string}).TEST_OTS;
it('実際のOTS calendarのpending receiptを解析しBitcoin確認とは扱わない',async()=>{
 const result=parseReceipt(receipt,fixture.payloadHash);expect(result.bytes.length).toBeGreaterThan(100);expect(result.attestations).toEqual([]);
 await expect(verifyBitcoin(result.attestations,900000,'http://localhost:8332')).rejects.toThrow('確認前');
});
it('OTSの対象hashの違いと破損を拒否',()=>{
 expect(()=>parseReceipt(receipt,'f'.repeat(64))).toThrow('hash');expect(()=>parseReceipt(receipt.slice(0,80),fixture.payloadHash)).toThrow();
});
it('RPC未設定でconfirmedにしない',async()=>{
 await expect(verifyBitcoin([{height:900000,merkleRoot:'a'.repeat(64)}],900000)).rejects.toThrow('RPC');
});
