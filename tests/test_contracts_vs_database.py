import re, subprocess, glob, sys
def psql(s):
    return subprocess.run(['su','postgres','-c',
      f'/usr/lib/postgresql/16/bin/psql -h /tmp -p 5433 -d alphaxau -tAc "{s}"'],
      capture_output=True,text=True).stdout.strip()

def cols(rel):
    return set(filter(None, psql(f"SELECT string_agg(column_name,',') FROM information_schema.columns WHERE table_name='{rel}';").split(',')))

ok=fail=0
def t(n,c,x=''):
    global ok,fail
    if c: ok+=1; print(f"  OK  {n}")
    else: fail+=1; print(f"  FAIL {n} {x}")

print("--- SELECT du frontend vs colonnes reelles des vues ---")
front=open('frontend/js/dashboard.js').read()
for m in re.finditer(r"'(v_[a-z_]+)\?select=([^'&]+)", front.replace("\n","").replace("      + '","")):
    view, sel = m.group(1), m.group(2)
    asked={c.strip() for c in sel.split(',') if c.strip() and '=' not in c}
    real=cols(view)
    missing=asked-real
    t(f"frontend -> {view} ({len(asked)} colonnes)", not missing, f"absentes: {missing}")

print("--- SELECT du backend vs colonnes reelles ---")
for f in glob.glob('backend/**/*.ts',recursive=True):
    src=open(f).read().replace("\n","").replace("      + '","")
    for m in re.finditer(r"'(v_[a-z_]+)',\s*'([a-z_,]+)'", src):
        view,sel=m.group(1),m.group(2)
        asked={c.strip() for c in sel.split(',') if c.strip()}
        real=cols(view); missing=asked-real
        t(f"{f.split('/')[-1]} -> {view}", not missing, f"absentes: {missing}")
    for m in re.finditer(r"select=([a-z_,]{20,})", src):
        pass

print("--- Colonnes ECRITES par le backend vs schema ---")
orch=open('backend/ai_engine/committee_orchestrator.ts').read()
blk=orch[orch.index("[{\n        model_version:"):orch.index("valid_until:")]
written={m.group(1) for m in re.finditer(r"^\s{8}([a-z_]+):",blk,re.M)}|{'valid_until'}
real=cols('ai_analyses'); t("persistAnalysis -> ai_analyses", not (written-real), f"absentes: {written-real}")

blk2=orch[orch.index("analysis_id: analysisId,"):orch.index("reasoning: s.reasoning,")+30]
w2={m.group(1) for m in re.finditer(r"^\s{10}([a-z_]+):",blk2,re.M)}
real2=cols('ai_scenarios'); t("persistAnalysis -> ai_scenarios", not (w2-real2), f"absentes: {w2-real2}")

mk=open('backend/market_engine/ingest_market.ts').read()
tick={m.group(1) for m in re.finditer(r"^\s{2}([a-z_]+)[?]?: (number|string|null)",mk[mk.index("export interface TickRow"):mk.index("export function buildTickRows")],re.M)}
realm=cols('market_ticks'); t("TickRow -> market_ticks", not (tick-realm), f"absentes: {tick-realm}")

ev=orch[orch.index("await db.request('POST', 'ai_events'"):orch.index("], { prefer: 'return=minimal' });")]
we={m.group(1) for m in re.finditer(r"^\s{6}([a-z_]+):",ev,re.M)}
reale=cols('ai_events'); t("claimEvent -> ai_events", not (we-reale), f"absentes: {we-reale}")

print("--- Contrat notification news -> validation comite ---")
ing=open('backend/news_engine/ingest.ts').read()
emitted={m.group(1) for m in re.finditer(r"^\s{4}(event_id|event_type|source|triggered_at|news_event_id|news_score):",ing,re.M)}
required={'event_id','event_type','source','triggered_at'}
t("news emet tous les champs requis", required<=emitted, f"emis: {emitted}")
t("news emet aussi les champs optionnels traces", {'news_event_id','news_score'}<=emitted)

print("--- Types d'evenements : emis vs acceptes ---")
emitted_types=set(re.findall(r"'(RECALC_H1_H2|REEVALUATE_H3)'",ing))
accepted=set(re.findall(r"'(RECALC_H1_H2|REEVALUATE_H3)'",orch))
t("tout type emis est accepte", emitted_types<=accepted, f"{emitted_types} vs {accepted}")

print("--- Enum SQL vs union TypeScript ---")
sqlv=set(psql("SELECT string_agg(enumlabel,',') FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='risk_verdict_t';").split(','))
tsv=set(re.findall(r"\| '(APPROVED|APPROVED_WITH_CONDITIONS|REJECTED|DATA_INSUFFICIENT|CONFLICT)'",orch))|{'APPROVED'}
t("risk_verdict_t == type Verdict", sqlv==tsv, f"SQL={sorted(sqlv)} TS={sorted(tsv)}")
sqle=set(psql("SELECT string_agg(enumlabel,',') FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='execution_status_t';").split(','))
t("execution_status_t == ExecutionStatus", sqle=={'VALID_SETUP','NO_VALID_SETUP'}, str(sqle))

print(f"\nRESULT: {ok} passed, {fail} failed")
sys.exit(1 if fail else 0)
