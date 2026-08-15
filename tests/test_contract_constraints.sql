\echo '--- 1) REJECTED sans motif'
INSERT INTO ai_analyses (model_version,market_regime,regime_confidence,symbol,spot_reference,risk_verdict,execution_status,overall_bias)
VALUES ('t','range_bound',0,'XAUUSD',3400,'REJECTED','NO_VALID_SETUP','neutral');
\echo '--- 2) DATA_INSUFFICIENT + VALID_SETUP'
INSERT INTO ai_analyses (model_version,market_regime,regime_confidence,symbol,spot_reference,risk_verdict,execution_status,overall_bias,rejection_reasons)
VALUES ('t','range_bound',0,'XAUUSD',3400,'DATA_INSUFFICIENT','VALID_SETUP','neutral','["m"]'::jsonb);
\echo '--- 3) NO_VALID_SETUP avec biais haussier'
INSERT INTO ai_analyses (model_version,market_regime,regime_confidence,symbol,spot_reference,risk_verdict,execution_status,overall_bias,rejection_reasons)
VALUES ('t','range_bound',0,'XAUUSD',3400,'CONFLICT','NO_VALID_SETUP','bullish','["m"]'::jsonb);
\echo '--- 4) scenario avec condition d activation trop courte'
INSERT INTO ai_scenarios (analysis_id,horizon,horizon_window,direction,probability,target,invalidation,activation_condition,confidence,reasoning)
VALUES ((SELECT id FROM ai_analyses LIMIT 1),'H1','6 hours','bullish',0.25,3450,3380,'court',0.5,'Justification suffisamment longue.');
\echo '--- 5) CONTROLE POSITIF : etat coherent accepte'
INSERT INTO ai_analyses (model_version,market_regime,regime_confidence,symbol,spot_reference,risk_verdict,execution_status,overall_bias,rejection_reasons)
VALUES ('t','range_bound',0,'XAUUSD',3400,'CONFLICT','NO_VALID_SETUP','neutral','["motif reel"]'::jsonb);
