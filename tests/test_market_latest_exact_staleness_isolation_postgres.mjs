// Isolation of tests/test_market_latest_exact_staleness_postgres.mjs on a shared PostgreSQL server: it never drops a
// database it did not create. Two runs at once, a run failing midway and a run whose scratch name is already taken
// each leave every other database, with its data, exactly as it was, and leave no scratch database of their own.
// Runs on the job's ephemeral server only, declared by XAU_PG_DISPOSABLE. Values are synthetic.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// The server must be declared disposable explicitly, by naming its test database (set by the CI job step).
assert.equal(process.env.XAU_PG_DISPOSABLE, 'xau_market_rls_test', 'XAU_PG_DISPOSABLE=xau_market_rls_test required: disposable server only');
assert.equal(process.env.PGDATABASE, 'xau_market_rls_test', 'disposable database required');
assert.ok(['127.0.0.1', 'localhost'].includes(process.env.PGHOST), 'local test server required');
assert.ok(!process.env.PGSERVICE && !process.env.PGSERVICEFILE && !process.env.PGHOSTADDR,
  'connection overrides are not allowed');

const TEST = fileURLToPath(new URL('./test_market_latest_exact_staleness_postgres.mjs', import.meta.url));
const run = (database, query) => execFileSync('psql', ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], {
  input: query, encoding: 'utf8', timeout: 20000, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PGDATABASE: database } }).trim();
const admin = (query) => run(process.env.PGDATABASE, query);
const databases = () => admin('SELECT datname FROM pg_database ORDER BY datname;').split('\n');
const child = (env = {}) => new Promise((resolve) => {
  const proc = spawn(process.execPath, [TEST], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  proc.stdout.on('data', (chunk) => { out += chunk; });
  proc.stderr.on('data', (chunk) => { err += chunk; });
  proc.on('close', (code) => resolve({ code, out, err, scratch: out.match(/^scratch database (\S+)$/m)?.[1] }));
});

// Decoys: the fixed name the test used to drop on start, a name in the test's own prefix, and the collision target.
const suffix = randomBytes(6).toString('hex');
const decoys = ['xau_market_staleness_scratch', `xau_a_c3_decoy_${suffix}`, `xau_a_c3_taken_${suffix}`];
const mine = [];
for (const name of decoys) {
  if (databases().includes(name)) continue; // someone else's: it must survive too, and is never dropped here
  admin(`CREATE DATABASE ${name};`);
  mine.push(name);
}
const sentinel = (name) => run(name, 'SELECT payload FROM public.xau_isolation_sentinel;');
for (const name of mine) run(name, `CREATE TABLE public.xau_isolation_sentinel(payload text); INSERT INTO public.xau_isolation_sentinel VALUES ('${name} ${suffix}');`);
const sentinels = Object.fromEntries(mine.map((name) => [name, sentinel(name)]));
const untouched = (where) => {
  const now = databases();
  for (const name of decoys) assert.ok(now.includes(name), `${where}: ${name} still exists`);
  for (const name of mine) assert.equal(sentinel(name), sentinels[name], `${where}: ${name} data intact`);
};
const baseline = databases();
const noScratchLeft = (where) => assert.deepEqual(databases(), baseline, `${where}: no scratch database left behind`);

try {
  // --- 1. Two runs at once: distinct scratch databases, both pass, both cleaned up, decoys intact.
  const [a, b] = await Promise.all([child(), child()]);
  for (const r of [a, b]) assert.equal(r.code, 0, `concurrent run failed:\n${r.out}\n${r.err}`);
  assert.ok(a.scratch && b.scratch && a.scratch !== b.scratch, 'each run has its own scratch database');
  untouched('after two concurrent runs');
  noScratchLeft('after two concurrent runs');
  console.log(`PASS two concurrent runs (${a.scratch}, ${b.scratch}) pass, drop only their own database, decoys intact`);

  // --- 2. A run failing midway (before and after the migration): it fails, drops its own database, nothing else.
  for (const step of ['create', 'migration']) {
    const r = await child({ XAU_A_C3_FAIL_AT: step });
    assert.notEqual(r.code, 0, `${step}: the injected failure fails the run`);
    assert.match(r.err, new RegExp(`injected failure at ${step}`));
    assert.ok(r.scratch, `${step}: the run had created its database`);
    untouched(`after a failure at ${step}`);
    noScratchLeft(`after a failure at ${step}`);
  }
  console.log('PASS a run failing midway drops its own scratch database and nothing else');

  // --- 3. The scratch name is already taken: the run refuses before creating or dropping anything.
  const taken = `xau_a_c3_taken_${suffix}`;
  const r = await child({ XAU_A_C3_SCRATCH_NAME: taken });
  assert.notEqual(r.code, 0);
  assert.match(r.err, /already exists; refusing to use it/);
  assert.equal(r.scratch, undefined, 'nothing was created');
  untouched('after a name collision');
  noScratchLeft('after a name collision');
  console.log('PASS a taken scratch name stops the run; the existing database and its data are untouched');

  // --- 4. Not declared disposable: refused before any connection-side effect.
  for (const env of [{ XAU_PG_DISPOSABLE: '' }, { XAU_PG_DISPOSABLE: 'yes' }, { PGDATABASE: 'postgres' }, { PGHOST: 'db.example.invalid' }]) {
    const refused = await child(env);
    assert.notEqual(refused.code, 0, JSON.stringify(env));
    assert.match(refused.err, /disposable|local test server/, JSON.stringify(env));
    assert.equal(refused.scratch, undefined);
    noScratchLeft(`refused for ${JSON.stringify(env)}`);
  }
  untouched('after refused starts');
  console.log('PASS a server not explicitly declared disposable (opt-in, database, local host) is refused, nothing created');

  // --- 5. The database no longer carries this run's marker: cleanup refuses to drop it.
  const lost = await child({ XAU_A_C3_FAIL_AT: 'ownership' });
  assert.notEqual(lost.code, 0);
  assert.match(lost.err, /NOT dropped: \S+ is not this run's database/);
  assert.ok(lost.scratch && databases().includes(lost.scratch), 'a database not proved ours is left in place');
  admin(`DROP DATABASE ${lost.scratch};`); // created by the child under this test; removed here, by name
  untouched('after a lost ownership marker');
  noScratchLeft('after a lost ownership marker');
  console.log('PASS cleanup leaves a database whose ownership marker no longer matches');
} finally {
  // The decoys this file created; IF EXISTS so that a run which destroyed one reports that, not this cleanup.
  for (const name of mine) admin(`DROP DATABASE IF EXISTS ${name};`);
}
