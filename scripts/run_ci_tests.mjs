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
 *   - test_anthropic_error_path.mjs, test_provider_failure_modes.mjs
 *       -> import sibling files (tests/ai_engine/*.mjs, tests/providers.mjs,
 *          etc.) that do not exist in this checkout layout. Loading them
 *          through scripts/lib/backend_module_loader.mjs is not enough:
 *          test_provider_failure_modes.mjs expects the removed Stooq
 *          provider, so its expectations need an owner decision.
 *
 * Adding a new deterministic test: add its path to TEST_FILES below.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const TEST_FILES = [
  'tests/test_advisory_transport_contract.mjs',
  'tests/test_advisory_ui_0_contract.mjs',
  'tests/test_advisory_surface_mutation.mjs',
  'tests/test_architecture_boundaries.mjs',
  'tests/test_capture_continuity_contract.mjs',
  'tests/test_collector_readiness_contract.mjs',
  'tests/test_capture_schedule_contract.mjs',
  'tests/test_capture_chain_mutation.mjs',
  'tests/test_offline_capture_replay_contract.mjs',
  'tests/test_persisted_capture_receipts_contract.mjs',
  'tests/test_ci_inventory.mjs',
  'tests/test_evidence_manifest_contract.mjs',
  'tests/test_institutional_purity_guard.mjs',
  'tests/test_institutional_transitive_imports.mjs',
  'tests/test_canonical_json_contract.mjs',
  'tests/test_temporal_contract.mjs',
  'tests/test_worker_routes_security.mjs',
  'tests/test_shadow_routes_authorized_bodies.mjs',
  'tests/test_shadow_lock_conflict_classification.mjs',
  'tests/test_unified_input_boundary.mjs',
  'tests/test_unified_offline_rehearsal.mjs',
  'tests/test_unified_receipt_gate.mjs',
  'tests/test_alert_contract.mjs',
  'tests/test_ai_committee_v2_contract.mjs',
  'tests/test_bea_pce_adapter.mjs',
  'tests/test_bls_cpi_event_facts_adapter.mjs',
  'tests/test_bls_employment_situation_adapter.mjs',
  'tests/test_bls_employment_situation_ahe_artifact.mjs',
  'tests/test_bls_employment_situation_html_parser.mjs',
  'tests/test_dol_ui_weekly_claims_adapter.mjs',
  'tests/test_dol_ui_weekly_claims_text_parser.mjs',
  'tests/test_dol_ui_weekly_claims_pdf_artifact.mjs',
  'tests/test_bls_cpi_artifact_parser.mjs',
  'tests/test_bls_cpi_artifact_structure_mutation.mjs',
  'tests/test_bls_cpi_producer_planner.mjs',
  'tests/test_bls_cpi_production_writer.mjs',
  'tests/test_bls_cpi_production_orchestrator.mjs',
  'tests/test_committee_baseline_numbers.mjs',
  'tests/test_committee_event_retry_idempotency.mjs',
  'tests/test_committee_internal_transport.mjs',
  'tests/test_committee_validation.mjs',
  'tests/test_command_center_contract.mjs',
  'tests/test_completion_board_and_recovery_authorization.mjs',
  'tests/test_contract_version_registry.mjs',
  'tests/test_decision_chain_contract.mjs',
  'tests/test_decision_chain_dry_run.mjs',
  'tests/test_decision_chain_mutation.mjs',
  'tests/test_deep_nesting.mjs',
  'tests/test_decision_gates_forged_upstream.mjs',
  'tests/test_decision_chain_scenarios.mjs',
  'tests/test_ecb_collector.mjs',
  'tests/test_ecb_raw_integration.mjs',
  'tests/test_event_cluster_relation_contract.mjs',
  'tests/test_event_deterministic_processor.mjs',
  'tests/test_event_consumers_mutation.mjs',
  'tests/test_event_facts_adapters_mutation.mjs',
  'tests/test_event_facts_ces_v2_consumers.mjs',
  'tests/test_event_facts_ces_v2_persistence.mjs',
  'tests/test_event_facts_atomic_production_contract.mjs',
  'tests/test_event_facts_activation_runbook.mjs',
  'tests/test_event_facts_production_authorization_packet.mjs',
  'tests/test_event_facts_staging_proof.mjs',
  'tests/test_event_facts_write_boundary_mutation.mjs',
  'tests/test_event_identity_claim_contract.mjs',
  'tests/test_event_routing.mjs',
  'tests/test_event_impact_atomic_rpc.mjs',
  'tests/test_event_impact_deterministic_processor.mjs',
  'tests/test_event_impact_shadow_batch.mjs',
  'tests/test_event_impact_shadow_orchestrator.mjs',
  'tests/test_event_impact_shadow_runtime.mjs',
  'tests/test_event_membership_reassign_contract.mjs',
  'tests/test_event_plan_aggregation.mjs',
  'tests/test_event_membership_supersession_contract.mjs',
  'tests/test_event_rpc_contract.mjs',
  'tests/test_event_schema_contract.mjs',
  'tests/test_event_shadow_batch.mjs',
  'tests/test_event_shadow_candidate_discovery.mjs',
  'tests/test_event_shadow_orchestrator.mjs',
  'tests/test_event_shadow_runtime.mjs',
  'tests/test_event_version_rpc_contract.mjs',
  'tests/test_frontend_degraded_modes.mjs',
  'tests/test_future_data_api_grant_contract.mjs',
  'tests/test_federal_reserve_collector.mjs',
  'tests/test_federal_reserve_raw_integration.mjs',
  'tests/test_gdelt_429_retry_policy.mjs',
  'tests/test_gold_transmission_deterministic_processor.mjs',
  'tests/test_gold_transmission_shadow_batch.mjs',
  'tests/test_gold_transmission_shadow_orchestrator.mjs',
  'tests/test_gold_transmission_shadow_runtime.mjs',
  'tests/test_horizon_synthesis_contract.mjs',
  'tests/test_institutional_acceptance_contract.mjs',
  'tests/test_market_data_ingest_mutation.mjs',
  'tests/test_market_driver_provenance.mjs',
  'tests/test_market_pricing_as_of_contract.mjs',
  'tests/test_market_provider_parsing.mjs',
  'tests/test_provider_parsers_mutation.mjs',
  'tests/test_news_feed_structure_mutation.mjs',
  'tests/test_news_source_entity_decoding.mjs',
  'tests/test_news_dedup_accounting.mjs',
  'tests/test_market_pricing_institutional_contract.mjs',
  'tests/test_market_pricing_persistence_contract.mjs',
  'tests/test_market_evidence_replay.mjs',
  'tests/test_market_evidence_capture.mjs',
  'tests/test_market_evidence_mutation.mjs',
  'tests/test_notification_horizon_provider_circuit.mjs',
  'tests/test_official_source_artifacts_contract.mjs',
  'tests/test_official_html_parser_mutation.mjs',
  'tests/test_official_text_parser_mutation.mjs',
  'tests/test_ofac_collector.mjs',
  'tests/test_ofac_raw_adapter.mjs',
  'tests/test_ofac_raw_integration.mjs',
  'tests/test_raw_news_writer.mjs',
  'tests/test_data_api_default_privileges_contract.mjs',
  'tests/test_data_api_default_acl_preflight.mjs',
  'tests/test_public_schema_create_hardening_contract.mjs',
  'tests/test_positioning_evidence_contract.mjs',
  'tests/test_positioning_persistence_contract.mjs',
  'tests/test_pre_pm_evidence_risk_contract.mjs',
  'tests/test_prepare_recovery_roles.mjs',
  'tests/test_verify_recovery_plaintext.mjs',
  'tests/test_release_identity_lookup.mjs',
  'tests/test_recovery_manifest_compare.mjs',
  'tests/test_recovery_rehearsal_contract.mjs',
  'tests/test_rc0_cross_system_contract.mjs',
  'tests/test_regime_contract.mjs',
  'tests/test_security_baseline_hardening_contract.mjs',
  'tests/test_sql_ts_enum_parity.mjs',
  'tests/test_strict_timestamp.mjs',
  'tests/test_sub_millisecond_cutoff.mjs',
  'tests/test_terminal_contrast.mjs',
  'tests/test_terminal_local.mjs',
  'tests/test_terminal_local_host_guard.mjs',
  'tests/test_terminal_local_hostile_files.mjs',
  'tests/test_terminal_render_isolation.mjs',
  'tests/test_terminal_view.mjs',
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
