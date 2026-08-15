#!/usr/bin/env bash
# Suite du garde anti-fuite GitHub Pages (blocker #1).
# Extrait les etapes `run` du workflow et les execute reellement.
#   usage : bash tests/test_pages_secret_guard.sh
set -uo pipefail
cd "$(dirname "$0")/.."
python3 - <<'PY'
import yaml
d=yaml.safe_load(open('.github/workflows/pages.yml'))
for i,s in enumerate(d['jobs']['deploy']['steps']):
    if 'run' in s: open(f'/tmp/gstep{i}.sh','w').write(s['run'])
PY
python3 - <<'PY'
import base64,json
b=lambda o: base64.urlsafe_b64encode(json.dumps(o).encode()).decode().rstrip('=')
h=b({"alg":"HS256","typ":"JWT"}); s="sig_placeholder_value"
open('/tmp/g_svc.txt','w').write(f'{h}.{b({"role":"service_role"})}.{s}')
open('/tmp/g_anon.txt','w').write(f'{h}.{b({"role":"anon"})}.{s}')
PY
SVC=$(cat /tmp/g_svc.txt); ANON=$(cat /tmp/g_anon.txt); FAIL=0
mk(){ rm -rf "$1" && mkdir -p "$1" && cp -r frontend "$1"/; }
chk(){ printf "%-58s exit=%s %s\n" "$1" "$2" "$([ "$2" = "$3" ] && echo OK || { echo FAIL; FAIL=1; })"; }
mk /tmp/g1; (cd /tmp/g1 && bash /tmp/gstep2.sh >/dev/null 2>&1); chk "T1 sain" $? 0
mk /tmp/g2; echo "const k='service_role';" >> /tmp/g2/frontend/js/dashboard.js
(cd /tmp/g2 && bash /tmp/gstep2.sh >/dev/null 2>&1); chk "T2 service_role litteral .js" $? 1
mk /tmp/g3; sed -i "s|SUPABASE_ANON_KEY: ''|SUPABASE_ANON_KEY: 'sk-ant-api03-X'|" /tmp/g3/frontend/index.html
(cd /tmp/g3 && bash /tmp/gstep2.sh >/dev/null 2>&1); chk "T3 sk-ant- index.html" $? 1
mk /tmp/g4; (cd /tmp/g4 && SUPABASE_URL=https://x.supabase.co SUPABASE_ANON_KEY="$SVC" bash /tmp/gstep1.sh >/dev/null 2>&1 && bash /tmp/gstep2.sh >/dev/null 2>&1); chk "T4 JWT service_role index.html" $? 1
mk /tmp/g4b; echo "const k='$SVC';" >> /tmp/g4b/frontend/js/dashboard.js
(cd /tmp/g4b && bash /tmp/gstep2.sh >/dev/null 2>&1); chk "T4b JWT service_role .js" $? 1
mk /tmp/g5; (cd /tmp/g5 && SUPABASE_URL=https://x.supabase.co SUPABASE_ANON_KEY="$ANON" bash /tmp/gstep1.sh >/dev/null 2>&1 && bash /tmp/gstep2.sh >/dev/null 2>&1); chk "T5 anon + commentaires" $? 0
mk /tmp/g6; (cd /tmp/g6 && SUPABASE_URL="" SUPABASE_ANON_KEY="" bash /tmp/gstep1.sh >/dev/null 2>&1 && bash /tmp/gstep2.sh >/dev/null 2>&1); chk "T6 mode demo" $? 0
mk /tmp/g7; sed -i "s|SUPABASE_ANON_KEY: ''|SUPABASE_ANON_KEY: 'my_service_role_key'|" /tmp/g7/frontend/index.html
(cd /tmp/g7 && bash /tmp/gstep2.sh >/dev/null 2>&1); chk "T7 service_role hors commentaire html" $? 1
exit $FAIL
