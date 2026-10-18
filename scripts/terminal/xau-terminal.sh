#!/bin/sh
# XAU V2 OFFLINE terminal (WSL / Linux side). Finds Node.js without a pinned
# version path, then runs scripts/terminal_launch.mjs from this checkout.
#   sh scripts/terminal/xau-terminal.sh [launcher options]
#   sh scripts/terminal/xau-terminal.sh --which-node
# Order: `node` on PATH, else the newest version installed by nvm
# ($NVM_DIR or ~/.nvm). Nothing is installed or configured.
set -u

find_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  versions="${NVM_DIR:-$HOME/.nvm}/versions/node"
  [ -d "$versions" ] || return 1
  best=$(ls -1 "$versions" 2>/dev/null | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' \
    | sort -t. -k1.2,1n -k2,2n -k3,3n \
    | while read -r version; do [ -x "$versions/$version/bin/node" ] && echo "$version"; done \
    | tail -n 1)
  [ -n "$best" ] || return 1
  echo "$versions/$best/bin/node"
}

NODE=$(find_node) || {
  echo "terminal XAU V2 : Node.js introuvable (ni sur le PATH, ni installé par nvm dans ${NVM_DIR:-$HOME/.nvm})." >&2
  echo "terminal XAU V2 : installer Node.js 22 ou plus récent dans WSL, puis relancer." >&2
  exit 3
}
if [ "${1:-}" = "--which-node" ]; then
  echo "$NODE"
  exit 0
fi
cd "$(dirname "$0")/../.." || exit 3
exec "$NODE" scripts/terminal_launch.mjs "$@"
