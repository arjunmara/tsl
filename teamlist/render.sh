#!/usr/bin/env bash
# Usage: ./render.sh "Team Name" "Player 1|Player 2 (C)|Player 3"   -> team-name.png
# No args: renders the defaults inside teamlist.html -> teamlist.png
cd "$(dirname "$0")"
url="file://$PWD/teamlist.html"; out=teamlist.png
if [ -n "$1" ]; then
  enc() { python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$1"; }
  url="$url?team=$(enc "$1")&players=$(enc "$2")"
  out="$(echo "$1" | tr 'A-Z' 'a-z' | sed 's/[^a-z0-9]\+/-/g; s/^-\|-$//g').png"
fi
google-chrome --headless=new --disable-gpu --hide-scrollbars --allow-file-access-from-files \
  --virtual-time-budget=5000 --window-size=1080,1350 --screenshot="$PWD/$out" "$url" 2>/dev/null
echo "$PWD/$out"
