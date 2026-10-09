import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { mapBlsEmploymentReleaseToEventFacts } from '../backend/event_facts/bls_employment_situation_adapter.ts';
import { decodeBlsEmploymentSituationHtmlArtifact } from '../scripts/audit_bls_employment_situation_ahe_artifact.mjs';
import {
  BLS_EMPLOYMENT_HTML_PARSER_VERSION,
  parseAuthenticatedBlsEmploymentSituationHtml,
  parseRetainedBlsEmploymentSituationHtmlArtifact,
} from '../scripts/parse_bls_employment_situation_html.mjs';

const artifactUrl = month => new URL(
  `./fixtures/bls_employment_situation_2026_${month}.archive.html.gz`, import.meta.url,
);
const manifestUrl = month => new URL(
  `./fixtures/bls_employment_situation_2026_${month}.artifact.json`, import.meta.url,
);
const projectionUrl = month => new URL(
  `./fixtures/bls_employment_situation_2026_${month}.json`, import.meta.url,
);
const loadManifest = month => JSON.parse(readFileSync(manifestUrl(month), 'utf8'));
const loadProjection = month => JSON.parse(readFileSync(projectionUrl(month), 'utf8'));
const loadHtml = month => decodeBlsEmploymentSituationHtmlArtifact(
  readFileSync(artifactUrl(month)), loadManifest(month),
);
const parseRetained = month => parseRetainedBlsEmploymentSituationHtmlArtifact({
  htmlPath: artifactUrl(month),
  manifestPath: manifestUrl(month),
});

assert.equal(BLS_EMPLOYMENT_HTML_PARSER_VERSION, 'bls-employment-html-parser-v1');

const july = parseRetained('07');
assert.equal(july.kind, 'PARSED', JSON.stringify(july));
assert.deepEqual(july.payload, loadProjection('07'));
assert.deepEqual(july.payload.summary.payroll.priorRevisions, [
  {
    referencePeriod: { kind: 'MONTH', year: 2026, month: 5 },
    priorChangeThousands: 129,
    revisedChangeThousands: 63,
  },
  {
    referencePeriod: { kind: 'MONTH', year: 2026, month: 6 },
    priorChangeThousands: 57,
    revisedChangeThousands: 20,
  },
]);
assert.equal(july.payload.summary.averageHourlyEarningsMom, null);
const julyAdapter = mapBlsEmploymentReleaseToEventFacts(july.payload);
assert.equal(julyAdapter.kind, 'UNAVAILABLE');
assert.equal(julyAdapter.reason, 'REQUIRED_OFFICIAL_EVIDENCE_UNAVAILABLE');
console.log('PASS exact July raw HTML reproduces the reviewed projection and preserves AHE unavailability');

const august = parseRetained('08');
assert.equal(august.kind, 'PARSED', JSON.stringify(august));
assert.deepEqual(august.payload, loadProjection('08'));
assert.deepEqual(august.payload.summary.payroll.priorRevisions, [
  {
    referencePeriod: { kind: 'MONTH', year: 2026, month: 6 },
    priorChangeThousands: 20,
    revisedChangeThousands: 31,
  },
  {
    referencePeriod: { kind: 'MONTH', year: 2026, month: 7 },
    priorChangeThousands: -23,
    revisedChangeThousands: 21,
  },
]);
assert.equal(august.payload.summary.averageHourlyEarningsMom.monthOverMonthPercent, 0.3);
const augustAdapter = mapBlsEmploymentReleaseToEventFacts(august.payload);
assert.equal(augustAdapter.kind, 'RESOLVED', JSON.stringify(augustAdapter));
assert.deepEqual(parseRetained('08'), august);
console.log('PASS exact August raw HTML composes deterministically through the strict NFP adapter');

const changedPayrollHtml = loadHtml('08').replace(
  '<td headers="ces_table10.r.1.1 ces_table10.h.1.5"><span class="datavalue">162</span></td>',
  '<td headers="ces_table10.r.1.1 ces_table10.h.1.5"><span class="datavalue">163</span></td>',
);
const changedPayroll = parseAuthenticatedBlsEmploymentSituationHtml(
  changedPayrollHtml, loadManifest('08'),
);
assert.equal(changedPayroll.kind, 'CONFLICT');
assert.equal(changedPayroll.reason, 'PAYROLL_NARRATIVE_TABLE_CONFLICT');

const changedRevisionHtml = loadHtml('08').replace(
  'from\r\n+20,000 to +31,000',
  'from\r\n+20,000 to +32,000',
);
const changedRevision = parseAuthenticatedBlsEmploymentSituationHtml(
  changedRevisionHtml, loadManifest('08'),
);
assert.equal(changedRevision.kind, 'CONFLICT');
assert.equal(changedRevision.reason, 'PAYROLL_REVISIONS_TABLE_CONFLICT');

const missingRateRowHtml = loadHtml('08').replace(
  'id="cps_empsit_sum.r.2.1.3.1"',
  'id="missing.unemployment.rate.row"',
);
const missingRate = parseAuthenticatedBlsEmploymentSituationHtml(
  missingRateRowHtml, loadManifest('08'),
);
assert.equal(missingRate.kind, 'MALFORMED');
assert.equal(missingRate.reason, 'REQUIRED_TABLE_ROW_MALFORMED');
console.log('PASS table/narrative contradictions and missing required rows fail closed');

const untrustedManifest = {
  ...loadManifest('08'),
  sourceUrl: 'https://example.com/empsit.htm',
};
const untrusted = parseAuthenticatedBlsEmploymentSituationHtml(
  loadHtml('08'), untrustedManifest,
);
assert.equal(untrusted.kind, 'MALFORMED');
assert.equal(untrusted.reason, 'BLS_AHE_ARTIFACT_MANIFEST_UNTRUSTED');

const wrongArtifact = parseRetainedBlsEmploymentSituationHtmlArtifact({
  htmlPath: projectionUrl('08'),
  manifestPath: manifestUrl('08'),
});
assert.deepEqual(wrongArtifact, {
  kind: 'MALFORMED',
  parserVersion: BLS_EMPLOYMENT_HTML_PARSER_VERSION,
  reason: 'ARTIFACT_AUTHENTICATION_OR_DECODING_FAILED',
});
console.log('PASS untrusted provenance and unauthenticated artifact bytes fail before projection');

const source = readFileSync(new URL(
  '../scripts/parse_bls_employment_situation_html.mjs', import.meta.url,
), 'utf8');
assert.doesNotMatch(source, /\bfetch\s*\(|node:https|node:http|XMLHttpRequest/);
assert.doesNotMatch(source, /supabase|postgres|\bsql\s*`/i);
assert.doesNotMatch(source, /process\.env|Date\.now|new Date|Math\.random|OpenAI|Anthropic|LLM/i);
console.log('PASS parser has no network, database, environment, clock, model, or runtime activation');
