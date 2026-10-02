import {cloudflareTest,readD1Migrations} from '@cloudflare/vitest-plugin';
import {defineConfig} from 'vitest/config';
import {readFileSync} from 'node:fs';
export default defineConfig({plugins:[cloudflareTest({wrangler:{configPath:'./wrangler.jsonc'},miniflare:{bindings:{BITCOIN_API_BASE_URL:'',BITCOIN_RPC_URL:'',TEST_OTS:readFileSync('./test/fixtures/calendar-pending.ots').toString('base64'),TEST_MIGRATIONS:await readD1Migrations('../migrations')}}})],test:{fileParallelism:false}});
