/**
 * ALPHA-XAU — scripts/run_ci_tests.mjs
 *
 * Deterministic CI test runner. Runs an explicit, reviewed list of
 * tests/*.mjs files that are self-contained: no live PostgreSQL, no real
 * outbound network calls, no hardcoded environment-specific paths.
 *
 * Excluded intentionally, not silently:
 *   - test_committee_lock.mjs, test_assembly_http.mjs,
 *     test_frontend_contract.mjs, test_legacy_non_tradable.mjs,
 *     test_market_cycle_live.mjs, test_news_score_parity.mjs
 *       -> require a live local PostgreSQL instance (psql/su postgres).
 *   - test_anthropic_error_path.mjs, probe_external_endpoints.mjs
 *       -> make real outbound calls to external APIs.
 *   - test_frontend_degraded_modes.mjs, test_committee_validation.mjs
 *       -> hardcoded /home/claude/alpha-xau/... absolute paths from a
 *          different environment (pre-existing gap, tracked separately;
 *          not fixed by this task).
 *   - test_anthropic_error_path.mjs, test_event_routing.mjs,
 *     test_provider_failure_modes.mjs
 *       -> import sibling files (tests/ai_engine/*.mjs, tests/providers.mjs,
 *          etc.) that do not exist in this checkout layout (pre-existing
 *          gap, not fixed by this task).
 *
 * Adding a new deterministic test: add its path to TEST_FILES below.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const TEST_FILES = [
  'tests/test_committee_event_retry_idempotency.mjs',
  'tests/test_committee_internal_transport.mjs',
  'tests/test_ecb_collector.mjs',
  'tests/test_ecb_raw_integration.mjs',
  'tests/test_event_cluster_relation_contract.mjs',
  'tests/test_event_deterministic_processor.mjs',
  'tests/test_event_identity_claim_contract.mjs',
  'tests/test_event_membership_reassign_contract.mjs',
  'tests/test_event_membership_supersession_contract.mjs',
  'tests/test_event_rpc_contract.mjs',
  'tests/test_event_schema_contract.mjs',
  'tests/test_event_shadow_batch.mjs',
  'tests/test_event_shadow_orchestrator.mjs',
  'tests/test_event_shadow_runtime.mjs',
  'tests/test_event_version_rpc_contract.mjs',
  'tests/test_federal_reserve_collector.mjs',
  'tests/test_federal_reserve_raw_integration.mjs',
  'tests/test_gdelt_429_retry_policy.mjs',
  'tests/test_notification_horizon_provider_circuit.mjs',
  'tests/test_ofac_collector.mjs',
  'tests/test_ofac_raw_adapter.mjs',
  'tests/test_ofac_raw_integration.mjs',
  'tests/test_raw_news_writer.mjs',
  'tests/test_us_treasury_collector.mjs',
  'tests/test_us_treasury_raw_adapter.mjs',
  'tests/test_us_treasury_raw_integration.mjs',
];

let failed = 0;

for (const relPath of TEST_FILES) {
  const absPath = path.join(repoRoot, relPath);
  console.log(`\n=== ${relPath} ===`);
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', absPath],
    { cwd: repoRoot, stdio: 'inherit' },
  );
  if (result.status !== 0) {
    failed += 1;
    console.error(`FAILED: ${relPath} (exit ${result.status})`);
  }
}

console.log(`\n${TEST_FILES.length - failed}/${TEST_FILES.length} test files passed.`);
process.exit(failed > 0 ? 1 : 0);
