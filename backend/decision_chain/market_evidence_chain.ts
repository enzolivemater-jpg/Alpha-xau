/**
 * DATA-1 bridge: runs CHAIN-0 on the market snapshot produced by a market
 * evidence replay, at the replay's own cutoff.
 *
 * Only `marketSnapshot` is replaced; every other input, every gate and every
 * CHAIN-0 contract is unchanged. MP-0 still reports its own replay boundary
 * (HISTORICAL_REPLAY_UNAVAILABLE): the replay manifest travels beside the
 * chain, it never upgrades a gate. The outcome is HOLD with execution
 * forbidden on every path.
 */

import { evaluateDecisionChain, type DecisionChainOutcome } from './dry_run.js';
import type { MarketEvidenceReplay } from '../market_engine/evidence_archive.js';

export function evaluateDecisionChainOnMarketEvidence(
  baseInput: unknown,
  replay: MarketEvidenceReplay,
): DecisionChainOutcome {
  if (replay.decision !== 'HOLD' || replay.execution !== 'FORBIDDEN') {
    throw new Error('market evidence replay must be HOLD with execution forbidden');
  }
  const input = typeof baseInput === 'object' && baseInput !== null && !Array.isArray(baseInput)
    ? { ...baseInput, marketSnapshot: replay.marketSnapshot }
    : baseInput;
  return evaluateDecisionChain(input, replay.knowledgeCutoff);
}
