#!/usr/bin/env bash
# Suite du garde anti-fuite GitHub Pages (blocker #1).
# Extrait les etapes `run` du workflow et les execute reellement.
#   usage : bash tests/test_pages_secret_guard.sh
#
# Tout se passe dans un repertoire jetable sous $TMPDIR (ou /tmp). Une
# preparation de cas qui echoue arrete la suite : sinon un `cd` rate
# produirait le code 1 attendu par les cas negatifs et les ferait passer.
set -uo pipefail
cd "$(dirname "$0")/.."
WORK=$(mktemp -d "${TMPDIR:-/tmp}/pages-guard.XXXXXX") || { echo "mktemp impossible"; exit 2; }
trap 'rm -rf "$WORK"' EXIT
export WORK
python3 - <<'PY' || { echo "extraction du workflow impossible"; exit 2; }
import os, yaml
work = os.environ['WORK']
d = yaml.safe_load(open('.github/workflows/pages.yml'))
for i, s in enumerate(d['jobs']['deploy']['steps']):
    if 'run' in s: open(f'{work}/gstep{i}.sh', 'w').write(s['run'])
PY
python3 - <<'PY' || { echo "fabrication des jetons impossible"; exit 2; }
import base64, json, os
work = os.environ['WORK']
b = lambda o: base64.urlsafe_b64encode(json.dumps(o).encode()).decode().rstrip('=')
h = b({"alg": "HS256", "typ": "JWT"}); s = "sig_placeholder_value"
open(f'{work}/g_svc.txt', 'w').write(f'{h}.{b({"role": "service_role"})}.{s}')
open(f'{work}/g_anon.txt', 'w').write(f'{h}.{b({"role": "anon"})}.{s}')
PY
for f in gstep1.sh gstep2.sh g_svc.txt g_anon.txt; do
  [ -s "$WORK/$f" ] || { echo "preparation incomplete : $f"; exit 2; }
done
SVC=$(cat "$WORK/g_svc.txt"); ANON=$(cat "$WORK/g_anon.txt"); FAIL=0
mk(){ rm -rf "$1" && mkdir -p "$1" && cp -r frontend "$1"/ || { echo "preparation impossible : $1"; exit 2; }; }
# Pas de substitution de commande : FAIL doit etre modifie dans ce shell.
chk(){
  local verdict=OK
  if [ "$2" != "$3" ]; then verdict=FAIL; FAIL=1; fi
  printf "%-58s exit=%s %s\n" "$1" "$2" "$verdict"
}
G1="$WORK/gstep1.sh"; G2="$WORK/gstep2.sh"
mk "$WORK/g1"; (cd "$WORK/g1" && bash "$G2" >/dev/null 2>&1); chk "T1 sain" $? 0
mk "$WORK/g2"; echo "const k='service_role';" >> "$WORK/g2/frontend/js/dashboard.js" || exit 2
(cd "$WORK/g2" && bash "$G2" >/dev/null 2>&1); chk "T2 service_role litteral .js" $? 1
mk "$WORK/g3"; sed -i "s|SUPABASE_ANON_KEY: ''|SUPABASE_ANON_KEY: 'sk-ant-api03-X'|" "$WORK/g3/frontend/index.html" || exit 2
grep -q "sk-ant-api03-X" "$WORK/g3/frontend/index.html" || { echo "injection T3 absente"; exit 2; }
(cd "$WORK/g3" && bash "$G2" >/dev/null 2>&1); chk "T3 sk-ant- index.html" $? 1
mk "$WORK/g4"; (cd "$WORK/g4" && SUPABASE_URL=https://x.supabase.co SUPABASE_ANON_KEY="$SVC" bash "$G1" >/dev/null 2>&1 && bash "$G2" >/dev/null 2>&1); chk "T4 JWT service_role index.html" $? 1
mk "$WORK/g4b"; echo "const k='$SVC';" >> "$WORK/g4b/frontend/js/dashboard.js" || exit 2
(cd "$WORK/g4b" && bash "$G2" >/dev/null 2>&1); chk "T4b JWT service_role .js" $? 1
mk "$WORK/g5"; (cd "$WORK/g5" && SUPABASE_URL=https://x.supabase.co SUPABASE_ANON_KEY="$ANON" bash "$G1" >/dev/null 2>&1 && bash "$G2" >/dev/null 2>&1); chk "T5 anon + commentaires" $? 0
mk "$WORK/g6"; (cd "$WORK/g6" && SUPABASE_URL="" SUPABASE_ANON_KEY="" bash "$G1" >/dev/null 2>&1 && bash "$G2" >/dev/null 2>&1); chk "T6 mode demo" $? 0
mk "$WORK/g7"; sed -i "s|SUPABASE_ANON_KEY: ''|SUPABASE_ANON_KEY: 'my_service_role_key'|" "$WORK/g7/frontend/index.html" || exit 2
grep -q "my_service_role_key" "$WORK/g7/frontend/index.html" || { echo "injection T7 absente"; exit 2; }
(cd "$WORK/g7" && bash "$G2" >/dev/null 2>&1); chk "T7 service_role hors commentaire html" $? 1
exit $FAIL
