import {afterEach,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {MAINNET_GENESIS,verifyBitcoinChain} from '../src/bitcoin';
import type {Bindings} from '../src/store';
const root='a'.repeat(64),height=969477,header=Buffer.alloc(80);
header.writeUInt32LE(1,0);Buffer.from(root,'hex').reverse().copy(header,36);header.writeUInt32LE(1700000000,68);
const hash=createHash('sha256').update(createHash('sha256').update(header).digest()).digest().reverse().toString('hex');
const anchor={height,merkleRoot:root},bindings={BITCOIN_API_BASE_URL:'https://bitcoin.test/api'} as Bindings;
function mock(overrides:Record<string,unknown>={}){
 const replies:Record<string,unknown>={'/block-height/0':MAINNET_GENESIS,[`/block-height/${height}`]:hash,[`/block/${hash}/header`]:header.toString('hex'),[`/block/${hash}`]:{id:hash,height,timestamp:1700000000,merkle_root:root},[`/block/${hash}/status`]:{in_best_chain:true},'/blocks/tip/height':String(height+5),...overrides};
 return vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{expect(init?.signal).toBeInstanceOf(AbortSignal);expect(init?.redirect).toBe('manual');expect(()=>new Request(input,init)).not.toThrow();const data=replies[new URL(String(input)).pathname.replace('/api','')];if(data===undefined)throw new Error('Unexpected endpoint');return typeof data==='string'?new Response(data):Response.json(data);});
}
afterEach(()=>vi.restoreAllMocks());
it('API未設定では接続せず確認済みにしない',async()=>{const spy=vi.spyOn(globalThis,'fetch');await expect(verifyBitcoinChain(anchor,{} as Bindings)).rejects.toMatchObject({code:'BITCOIN_API_NOT_CONFIGURED'});expect(spy).not.toHaveBeenCalled();});
it('mainnet・raw header SHA256d・Merkle root・6確認・canonical hashが一致',async()=>{const spy=mock();expect(await verifyBitcoinChain(anchor,bindings)).toEqual({height,hash,blockTime:'2023-11-14T22:13:20.000Z',confirmations:6,provider:'ESPLORA'});expect(spy.mock.calls).toHaveLength(7);});
it.each([
 ['root不一致',{}, {height,merkleRoot:'b'.repeat(64)},'BLOCK_MISMATCH'],
 ['header不一致',{[`/block/${hash}/header`]:'00'.repeat(80)},anchor,'BLOCK_MISMATCH'],
 ['height不一致',{[`/block/${hash}`]:{id:hash,height:height+1,timestamp:1700000000,merkle_root:root}},anchor,'BLOCK_MISMATCH'],
 ['wrong network',{'/block-height/0':'f'.repeat(64)},anchor,'BITCOIN_WRONG_NETWORK'],
 ['orphan',{[`/block/${hash}/status`]:{in_best_chain:false}},anchor,'BITCOIN_NOT_CANONICAL'],
 ['5確認',{'/blocks/tip/height':String(height+4)},anchor,'BITCOIN_INSUFFICIENT_CONFIRMATIONS'],
 ['tip不正',{'/blocks/tip/height':'not a height'},anchor,'BITCOIN_API_INVALID_RESPONSE']
])('%s を拒否',async(_name,overrides,target,code)=>{mock(overrides);await expect(verifyBitcoinChain(target,bindings)).rejects.toMatchObject({code});});
it('タイムアウトを区別',async()=>{vi.spyOn(globalThis,'fetch').mockRejectedValue(new DOMException('timed out','TimeoutError'));await expect(verifyBitcoinChain(anchor,bindings)).rejects.toMatchObject({code:'TIMEOUT'});});
it('HTTP障害からのretry',async()=>{vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('error',{status:503}));await expect(verifyBitcoinChain(anchor,bindings)).rejects.toMatchObject({code:'VERIFY_FAILED',failureStage:'NETWORK_CHECK',httpStatus:503});vi.restoreAllMocks();mock();expect((await verifyBitcoinChain(anchor,bindings)).hash).toBe(hash);});
it('検証中のreorgを拒否',async()=>{const spy=mock();let reads=0;const original=spy.getMockImplementation()!;spy.mockImplementation(async(input,init)=>{if(String(input).endsWith(`/block-height/${height}`)&&++reads===2)return new Response('b'.repeat(64));return original(input,init);});await expect(verifyBitcoinChain(anchor,bindings)).rejects.toMatchObject({code:'BITCOIN_NOT_CANONICAL'});});
it('任意HTTP・URL内の資格情報・queryを設定として拒否',async()=>{for(const url of ['http://bitcoin.test/api','https://user:secret@bitcoin.test/api','https://bitcoin.test/api?key=secret'])await expect(verifyBitcoinChain(anchor,{BITCOIN_API_BASE_URL:url} as Bindings)).rejects.toMatchObject({code:'BITCOIN_API_CONFIGURATION_INVALID'});});
it.each([[404,'BLOCK_HASH_LOOKUP_FAILED'],[429,'RATE_LIMIT'],[302,'BLOCK_HASH_LOOKUP_FAILED']])('hash API HTTP %s の段階とstatusを記録し転送を追従しない',async(status,code)=>{
 const spy=mock(),original=spy.getMockImplementation()!;
 spy.mockImplementation(async(input,init)=>String(input).endsWith(`/block-height/${height}`)?new Response('sensitive upstream body',{status,headers:{Location:'https://other.test'}}):original(input,init));
 await expect(verifyBitcoinChain(anchor,bindings,'proof-test')).rejects.toMatchObject({code,failureStage:'BLOCK_HASH_LOOKUP',httpStatus:status});
 expect(spy.mock.calls).toHaveLength(2);
});
it.each([['network','NETWORK_ERROR'],['timeout','TIMEOUT']])('hash lookup %s を区別',async(kind,code)=>{
 const spy=mock(),original=spy.getMockImplementation()!;
 spy.mockImplementation(async(input,init)=>{if(String(input).endsWith(`/block-height/${height}`))throw kind==='timeout'?new DOMException('secret','TimeoutError'):new TypeError('secret');return original(input,init);});
 await expect(verifyBitcoinChain(anchor,bindings)).rejects.toMatchObject({code,failureStage:'BLOCK_HASH_LOOKUP',httpStatus:null});
});
it('block info 404を区別',async()=>{
 const spy=mock(),original=spy.getMockImplementation()!;
 spy.mockImplementation(async(input,init)=>String(input).endsWith(`/block/${hash}`)?new Response('',{status:404}):original(input,init));
 await expect(verifyBitcoinChain(anchor,bindings)).rejects.toMatchObject({code:'BLOCK_INFO_LOOKUP_FAILED',failureStage:'BLOCK_INFO_LOOKUP',httpStatus:404});
});
it('不正JSONをnetwork errorにせずinfo段階で報告',async()=>{
 mock({[`/block/${hash}`]:'invalid json'});
 await expect(verifyBitcoinChain(anchor,bindings)).rejects.toMatchObject({code:'VERIFY_FAILED',failureStage:'BLOCK_INFO_LOOKUP'});
});
it('不正block timeを拒否',async()=>{
 mock({[`/block/${hash}`]:{id:hash,height,timestamp:null,merkle_root:root}});
 await expect(verifyBitcoinChain(anchor,bindings)).rejects.toMatchObject({code:'BITCOIN_API_INVALID_RESPONSE',failureStage:'BLOCK_INFO_LOOKUP'});
});
it('ログに例外messageやレスポンスbodyを出さない',async()=>{
 const logs=vi.spyOn(console,'info').mockImplementation(()=>{}),spy=mock(),original=spy.getMockImplementation()!;
 spy.mockImplementation(async(input,init)=>{if(String(input).endsWith(`/block-height/${height}`))throw new Error('token=secret Cookie=private');return original(input,init);});
 await expect(verifyBitcoinChain(anchor,bindings,'proof-safe')).rejects.toMatchObject({code:'NETWORK_ERROR'});
 const entries=logs.mock.calls.map(([entry])=>JSON.parse(entry));
 expect(entries.map(e=>e.event)).toEqual(['BITCOIN_VERIFY_START','BITCOIN_BLOCK_HASH_LOOKUP','BITCOIN_VERIFY_FAILED']);
 expect(entries[1]).toMatchObject({http_status:null,success:false});
 expect(JSON.stringify(entries)).not.toMatch(/secret|Cookie|bitcoin.test/);
});
