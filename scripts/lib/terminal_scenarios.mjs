/**
 * Local simulation scenarios for the terminal (TV-1). Each one derives a
 * CHAIN-0 document `{ knowledgeCutoff, input }` from the golden fixture, to
 * show how the chain holds and why. They are simulations, not market data:
 * the terminal labels every view built from them SIMULATION.
 */

const clone = (value) => structuredClone(value);

/** Everything a caller can grant is granted; methods stay unapproved. */
function everythingGranted(input) {
  for (const key of Object.keys(input.authorizations)) input.authorizations[key] = 'AUTHORIZED';
  Object.assign(input, {
    eventImpact: { ...input.eventImpact, status: 'ASSESSED' },
    goldTransmission: { ...input.goldTransmission, status: 'ASSESSED' },
    evidenceGraph: { schemaVersion: 'xau.evidence-graph.v0-test', complete: true, nodeCount: 3 },
    portfolioState: 'AVAILABLE', brokerConstraintsVersion: 'broker-test-1',
    brokerConnection: 'CONNECTED', recipientPolicyVersion: 'recipients-test-1',
    runtimeEvidence: { correlationId: 'corr-test-1', deploymentId: 'deploy-test-1' },
    acceptanceEvidence: Object.fromEntries(Object.keys(input.acceptanceEvidence).map((key) => [key, true])),
  });
}

const addDays = (iso, days) => new Date(Date.parse(iso) + days * 86_400_000).toISOString();

export const TERMINAL_SCENARIOS = [
  {
    id: 'golden',
    label: 'Fixture de référence : état honnête, rien d\'autorisé',
    build: (golden) => clone(golden),
  },
  {
    id: 'everything-granted',
    label: 'Toutes les autorisations accordées, aucune méthode approuvée',
    build: (golden) => {
      const document = clone(golden);
      everythingGranted(document.input);
      return document;
    },
  },
  {
    id: 'read-7-days-later',
    label: 'Même entrée lue 7 jours après son cutoff',
    build: (golden) => ({ ...clone(golden), knowledgeCutoff: addDays(golden.knowledgeCutoff, 7) }),
  },
  {
    id: 'market-unavailable',
    label: 'Fournisseur de marché indisponible',
    build: (golden) => {
      const document = clone(golden);
      const snapshot = document.input.marketSnapshot;
      for (const field of ['spot', 'bid', 'ask', 'dxy', 'us10y', 'realYield', 'vix', 'wti']) {
        snapshot[field] = { value: null, status: 'UNAVAILABLE', observedAt: null, ageSeconds: null, source: null };
      }
      Object.assign(snapshot, { available: false, reason: 'provider outage (simulated)', capturedAt: null });
      return document;
    },
  },
  {
    id: 'lookahead',
    label: 'Prix observé 500 µs après le cutoff',
    build: (golden) => {
      const document = clone(golden);
      const after = golden.knowledgeCutoff.replace(/\.\d+Z$|Z$/, '.000500Z');
      const snapshot = document.input.marketSnapshot;
      for (const field of ['spot', 'bid', 'ask']) snapshot[field].observedAt = after;
      snapshot.capturedAt = after;
      return document;
    },
  },
  {
    id: 'invalid-input',
    label: 'Entrée mal formée (clé inconnue)',
    build: (golden) => ({ ...clone(golden), input: { ...clone(golden.input), unexpectedKey: true } }),
  },
];

export const TERMINAL_SCENARIO_IDS = TERMINAL_SCENARIOS.map(({ id }) => id);

export function findTerminalScenario(id) {
  return TERMINAL_SCENARIOS.find((scenario) => scenario.id === id) ?? null;
}
