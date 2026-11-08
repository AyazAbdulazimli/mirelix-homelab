#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
for task_command in tailscale python3 docker sudo ss; do
  command -v "$task_command" >/dev/null || { echo "Missing command: $task_command" >&2; exit 1; }
done
# High, dedicated HTTPS ports avoid common services such as Crafty on 8443.
task_app_port=${MIRELIX_HTTPS_PORT:-13030}
task_proxy_port=${MIRELIX_PROXY_HTTPS_PORT:-13031}
python3 - "$task_app_port" "$task_proxy_port" <<'PY'
import sys
try: ports=[int(value) for value in sys.argv[1:]]
except ValueError: sys.exit('HTTPS ports must be integers.')
if len(set(ports))!=2 or any(port<1024 or port>65535 for port in ports):
 sys.exit('Choose two different HTTPS ports between 1024 and 65535.')
PY
task_dns=$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
[ -n "$task_dns" ] || { echo 'Tailscale DNS name unavailable.' >&2; exit 1; }
task_app="https://$task_dns:$task_app_port"
task_proxy="https://$task_dns:$task_proxy_port"
# Docker NAT can capture traffic even when Tailscale accepts a Serve rule.
# Inspect published ports as well as TCP listeners before changing anything.
python3 - "$task_dns" "$task_app_port" "$task_proxy_port" <<'PY'
import json,re,subprocess,sys
host=sys.argv[1]
ports={int(sys.argv[2]):'http://127.0.0.1:3030',int(sys.argv[3]):'http://127.0.0.1:3031'}
config=json.loads(subprocess.check_output(['tailscale','serve','status','--json']))
publications=subprocess.check_output(['docker','ps','--format','{{.Names}} {{.Ports}}'],text=True)
for line in publications.splitlines():
 for start,end in re.findall(r':(\d+)(?:-(\d+))?->',line):
  for port in ports:
   if int(start)<=port<=int(end or start): sys.exit('HTTPS port '+str(port)+' is published by '+line.split()[0]+'. Choose other MIRELIX_HTTPS_PORT/MIRELIX_PROXY_HTTPS_PORT values.')
listeners=subprocess.check_output(['ss','-ltnH'],text=True)
for port,target in ports.items():
 address=host+':'+str(port)
 existing=config.get('Web',{}).get(address)
 if existing and existing.get('Handlers',{})!={'/':{'Proxy':target}}:
  sys.exit('HTTPS port '+str(port)+' belongs to another Tailscale service.')
 tcp=config.get('TCP',{}).get(str(port))
 if tcp and not tcp.get('HTTPS'): sys.exit('TCP port '+str(port)+' belongs to another Tailscale service.')
 if not existing:
  for line in listeners.splitlines():
   columns=line.split()
   if len(columns)>3 and columns[3].endswith(':'+str(port)):sys.exit('TCP port '+str(port)+' is already in use.')
# This launcher forwards the default published ports.
compose=json.loads(subprocess.check_output(['docker','compose','config','--format','json']))
published={int(p['target']):int(p.get('published',0)) for p in compose['services']['mirelix'].get('ports',[])}
if published.get(3030)!=3030 or published.get(3031)!=3031:
 sys.exit('This launcher expects APP_PORT=3030 and PROXY_PORT=3031; use your reverse proxy for custom ports.')
PY
echo "HTTPS app: $task_app"
echo "HTTPS proxy: $task_proxy"
if [ "${1:-}" = '--check' ]; then
  echo 'Port and configuration checks passed. No changes made.'
  exit 0
fi
echo 'Tailscale needs administrator access to add these HTTPS listeners.'
sudo tailscale serve --bg --https="$task_app_port" http://127.0.0.1:3030
sudo tailscale serve --bg --https="$task_proxy_port" http://127.0.0.1:3031
python3 - "$task_app" "$task_proxy" <<'PY'
from pathlib import Path
import sys
p=Path('.env')
updates={'PUBLIC_ORIGIN':sys.argv[1], 'PROXY_ORIGIN':sys.argv[2]}
lines=p.read_text().splitlines() if p.exists() else []
lines=[line for line in lines if line.split('=',1)[0].strip() not in updates]
lines.extend(key+'='+value for key,value in updates.items())
p.write_text('\n'.join(lines)+'\n')
p.chmod(0o600)
PY
docker compose up -d --build --wait --wait-timeout 60 mirelix
# Remove only the previous Mirelix rules, never another service or port 443.
for task_old_port in 8443 8444; do
  [ "$task_old_port" != "$task_app_port" ] && [ "$task_old_port" != "$task_proxy_port" ] || continue
  if tailscale serve status --json | python3 -c '
import json,sys
p=sys.argv[1];d=json.load(sys.stdin);target="http://127.0.0.1:"+("3030" if p=="8443" else "3031")
sys.exit(0 if any(k.endswith(":"+p) and v.get("Handlers",{})=={"/":{"Proxy":target}} for k,v in d.get("Web",{}).items()) else 1)
' "$task_old_port"; then
    sudo tailscale serve --https="$task_old_port" off
  fi
done
echo "Ready. Both participants should open $task_app"
