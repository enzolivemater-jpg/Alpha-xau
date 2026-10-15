// DATA-4B: disposable PostgreSQL proof only, never production.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

assert.equal(process.env.PGDATABASE,'xau_capture_evidence_test');
assert.ok(['127.0.0.1','localhost'].includes(process.env.PGHOST));
assert.ok(!process.env.PGSERVICE && !process.env.PGSERVICEFILE && !process.env.PGHOSTADDR);
const env={...process.env,PGOPTIONS:'-c statement_timeout=15000 -c lock_timeout=10000'};
const sql=(q)=>execFileSync('psql',['-X','-q','-A','-t','-v','ON_ERROR_STOP=1'],{input:q,encoding:'utf8',env,timeout:20000}).trim();
const reject=(q,rx)=>assert.throws(()=>sql(q),rx);
const service=(q)=>sql('SET ROLE service_role; '+q);
assert.match(sql('SHOW server_version;'),/^17\./);
sql("CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS; CREATE SCHEMA extensions; CREATE EXTENSION pgcrypto WITH SCHEMA extensions; GRANT USAGE ON SCHEMA extensions TO service_role;");
sql(readFileSync(new URL('../database/proposals/data_4b_market_provider_capture_evidence.sql',import.meta.url),'utf8'));
console.log('PASS isolated migration in disposable PostgreSQL');

const body="decode('7b226f62736572766174696f6e73223a5b5d7d','hex')";
const time="'2026-10-15T08:00:00Z'";
const record=(plan,slot,provider,series,symbol,outcome,bytes,failure,received=time)=>
  'SELECT receipt_id::text || \'|\' || write_outcome || \'|\' || coalesce(content_sha256,\'-\') FROM public.fn_market_capture_record_attempt('+
  ["'"+plan+"'","'"+slot+"'","'"+provider+"'","'"+series+"'","'"+symbol+"'","'"+outcome+"'",received,bytes,failure].join(',')+');';

const first=service(record('plan-1','dgs10-1','fred','DGS10','US10Y','CAPTURED',body,'NULL'));
assert.match(first,/^[0-9a-f-]{36}\|PERSISTED\|[0-9a-f]{64}$/);
assert.equal(service(record('plan-1','dgs10-1','fred','DGS10','US10Y','CAPTURED',body,'NULL')),
 first.replace('|PERSISTED|','|REPLAYED|'));
assert.equal(service('SELECT count(*) FROM public.market_provider_responses;'),'1');
console.log('PASS atomic persisted capture and exact idempotence');

reject('SET ROLE service_role; '+record('plan-1','dgs10-1','fred','DGS10','US10Y','CAPTURED',"decode('7b7d','hex')",'NULL'),/divergent evidence/);
reject('SET ROLE service_role; '+record('plan-1','dgs10-1','fred','DFII10','US10YR','CAPTURED',body,'NULL'),/divergent evidence/);
assert.equal(service('SELECT count(*) FROM public.market_provider_responses;'),'1');
const repeated=service(record('plan-1','dgs10-2','fred','DGS10','US10Y','CAPTURED',body,'NULL'));
assert.match(repeated,/\|PERSISTED\|/);
assert.equal(service('SELECT count(*) FROM public.market_provider_responses;'),'1');
service(record('plan-1','real-yield-1','fred','DFII10','US10YR','CAPTURED',body,'NULL'));
assert.equal(service('SELECT count(*) FROM public.market_provider_responses;'),'2');
console.log('PASS divergent slot rejected, exact-byte dedup local to provider/series');

const failed=service(record('plan-1','vix-1','fred','VIXCLS','VIX','FAILED','NULL',"'TIMEOUT'"));
assert.match(failed,/\|PERSISTED\|-/);
reject('SET ROLE service_role; '+record('plan-1','wti-1','fred','DCOILWTICO','WTI','CAPTURED','NULL','NULL'),/outcome does not match/);
reject('SET ROLE service_role; '+record('plan-1','wti-2','fred','DCOILWTICO','WTI','FAILED','NULL','NULL'),/outcome does not match/);
reject('SET ROLE service_role; '+record('plan-1','wti-3','fred','DCOILWTICO','WTI','FAILED','NULL',"'BAD_ERROR_CODE'"),/check constraint|failure_code/);
reject('SET ROLE service_role; '+record('plan-1','wti-4','fred','DCOILWTICO','WTI','FAILED','NULL',"'TIMEOUT'","'2099-01-01T00:00:00Z'"),/future receipt/);
reject('SET ROLE service_role; '+record('plan-1','spoof-1','twelve_data','XAU/USD','VIX','CAPTURED',body,'NULL'),/chk_market_provider_series|check constraint/);
console.log('PASS failure receipts, source pairing, invalid outcomes and future timestamps rejected');

assert.equal(service("SELECT encode(body_bytes,'hex') FROM public.market_provider_responses WHERE source_record_id='DGS10';"),
 '7b226f62736572766174696f6e73223a5b5d7d');
assert.equal(service("SELECT content_sha256 FROM public.market_provider_responses WHERE source_record_id='DGS10';"),
 first.split('|')[2]);
reject('UPDATE public.market_provider_responses SET source_received_at=now();',/append-only/);
reject('DELETE FROM public.market_capture_attempt_receipts;',/append-only/);
reject('SET ROLE service_role; INSERT INTO public.market_provider_responses (provider,source_record_id,symbol,body_bytes,source_received_at,recorded_at) VALUES ('+
  "'fred','DGS10','US10Y',"+body+','+time+",'2025-01-01T00:00:00Z');",/permission denied/);
console.log('PASS exact-byte retention, digest and immutable database-owned timestamps');

assert.equal(sql("SELECT bool_and(relrowsecurity) FROM pg_class WHERE oid IN ('public.market_provider_responses'::regclass,'public.market_capture_attempt_receipts'::regclass);"),'t');
for(const table of ['market_provider_responses','market_capture_attempt_receipts']) {
 const name='public.'+table;
 assert.equal(sql("SELECT NOT has_table_privilege('anon','"+name+"','SELECT') AND NOT has_table_privilege('authenticated','"+name+"','SELECT')"+
  " AND has_table_privilege('service_role','"+name+"','SELECT') AND NOT has_table_privilege('service_role','"+name+"','DELETE')"+
  " AND NOT has_table_privilege('service_role','"+name+"','UPDATE');"),'t');
}
for(const proc of [
 'public.fn_market_capture_record_attempt(text,text,text,text,text,text,timestamptz,bytea,text)',
 'public.fn_market_capture_receipts_as_of(timestamptz,integer)',
]) {
 assert.equal(sql("SELECT NOT prosecdef AND EXISTS (SELECT 1 FROM unnest(proconfig) setting WHERE setting IN ('search_path=', 'search_path=""'))"+
  " AND NOT has_function_privilege('anon',oid,'EXECUTE') AND NOT has_function_privilege('authenticated',oid,'EXECUTE')"+
  " AND has_function_privilege('service_role',oid,'EXECUTE') FROM pg_proc WHERE oid='"+proc+"'::regprocedure;"),'t');
}
console.log('PASS RLS, grants, invoker RPC and empty search_path');

assert.equal(service("SELECT count(*) FROM public.fn_market_capture_receipts_as_of(statement_timestamp()-interval '1 day',20);"),'0');
assert.equal(service("SELECT count(*) FROM public.fn_market_capture_receipts_as_of(statement_timestamp()+interval '1 minute',20);"),'4');
assert.equal(service("SELECT outcome FROM public.fn_market_capture_receipts_as_of(statement_timestamp()+interval '1 minute',20) WHERE slot_id='vix-1';"),'FAILED');
reject("SET ROLE service_role; SELECT * FROM public.fn_market_capture_receipts_as_of(statement_timestamp()+interval '1 minute',1);",/exceeds explicit bound/);
reject("SET ROLE service_role; SELECT * FROM public.fn_market_capture_receipts_as_of('infinity',20);",/invalid market receipt cutoff/);
assert.equal(service('SELECT count(*) FROM public.market_provider_responses;'),'2');
assert.equal(service('SELECT count(*) FROM public.market_capture_attempt_receipts;'),'4');
console.log('PASS bounded as-of complete-or-error, never evidence of complete schedule or market coverage');
