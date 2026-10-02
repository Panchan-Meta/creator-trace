import {env,applyD1Migrations} from 'cloudflare:test';
import {it,expect} from 'vitest';
import {id,now,sha256} from '../src/domain';
it('migrationは既存OWNER・旧REVOKED・Version・Proof・監査をすべて保持する',async()=>{
 const migrations=(env as unknown as {TEST_MIGRATIONS:Parameters<typeof applyD1Migrations>[1]}).TEST_MIGRATIONS;
 await applyD1Migrations(env.DB,migrations.slice(0,14));
 const user=id(),legacy=id(),project=id(),member=id();for(const u of [user,legacy])await env.DB.prepare('INSERT INTO users(id,display_name,created_at) VALUES(?,?,?)').bind(u,'Existing user',now()).run();
 await env.DB.prepare('INSERT INTO projects(id,name,owner_id,created_at) VALUES(?,?,?,?)').bind(project,'Existing project',user,now()).run();await env.DB.prepare('INSERT INTO project_members(id,project_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)').bind(member,project,legacy,'CREATOR','REVOKED',now()).run();
 await env.DB.prepare('INSERT INTO sessions VALUES(?,?,?)').bind(await sha256(user),user,new Date(Date.now()+86400000).toISOString()).run();
 const asset=id(),version=id(),time=now();await env.DB.prepare('INSERT INTO assets(id,project_id,filename,mime_type,size,created_at,created_by) VALUES(?,?,?,?,?,?,?)').bind(asset,project,'legacy.wav','audio/wav',4,time,user).run();await env.DB.prepare('INSERT INTO asset_versions(id,asset_id,version,sha256,status,created_by,filename,mime_type,size,created_at) VALUES(?,?,1,?,?,?,?,?,?,?)').bind(version,asset,'4'.repeat(64),'SUBMITTED',user,'legacy.wav','audio/wav',4,time).run();await env.DB.prepare('INSERT INTO proofs(id,asset_version_id,sha256,created_at) VALUES(?,?,?,?)').bind(id(),version,'4'.repeat(64),time).run();
 const tables=['project_members','asset_versions','asset_version_states','asset_version_state_history','proofs','audit_events'];const before=await Promise.all(tables.map(async table=>(await env.DB.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results));
 await applyD1Migrations(env.DB,migrations);
 for(const [index,table] of tables.entries()){const after=(await env.DB.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results;if(table==='project_members'){expect(after.map(({removed_at,removed_by,...old})=>old)).toEqual(before[index]);}else if(table==='asset_version_state_history')expect(after.map(({actor_role,...old})=>old)).toEqual(before[index]);else if(table==='proofs')expect(after.map(({bitcoin_block_height,bitcoin_block_hash,bitcoin_block_time,bitcoin_verification_state,...old})=>old)).toEqual(before[index]);else expect(after).toEqual(before[index]);}
 expect((await env.DB.prepare('SELECT * FROM project_member_history').all()).results).toHaveLength(2);
});
