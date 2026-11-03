#!/usr/bin/env python3
"""Live scoreboard for the stream. Run on the laptop:  ./live/server.py

  OBS browser source (1920x1080):  http://localhost:8000/live/overlay.html
  Scorekeeper's phone (same Wi-Fi):  http://<laptop-ip>:8000/live/control.html  (printed below)
"""
import json, pathlib, socket, subprocess, sys, time
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

ROOT = pathlib.Path(__file__).resolve().parent.parent  # Futsal/, so logo.jpg and matchday/league.js are served too
state = {'home': 'Junior Ballers Tamghas', 'away': 'Resunga Eight', 'hs': 0, 'as': 0,
         'period': '1st Half', 'show': True, 'elapsed': 0.0, 'since': None}
EDITABLE = ('results.txt', 'groups.txt')  # the only files the hub may overwrite (laptop only: the database is edited from the phone maker)
LAN = '<laptop-ip>'  # set at startup, shown on the hub so phones know where to connect

def view():
    clock = state['elapsed'] + (time.time() - state['since'] if state['since'] else 0)
    return {**state, 'clock': clock, 'running': state['since'] is not None, 'lan': LAN}

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
    def log_message(self, *a): pass  # the overlay polls 4x a second; keep the terminal quiet

    def send_json(self, data):
        body = json.dumps(data).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/state': return self.send_json(view())
        super().do_GET()

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'] or 0)) or '{}')
        if self.path == '/state': return self.update(body)
        if self.path == '/make': return self.make(body)
        if self.path == '/save' and body.get('name') in EDITABLE:
            (ROOT / 'matchday' / body['name']).write_text(body['text'])
            return self.send_json({'ok': True})
        self.send_error(404)

    # {"type": "goal", "scorer": "...", ...} -> runs make.py, returns the PNG's URL.
    def make(self, params):
        args = [f'{k}={v}' for k, v in params.items() if k != 'type' and str(v).strip()]
        r = subprocess.run([sys.executable, ROOT / 'matchday' / 'make.py', str(params.get('type')), *args],
                           capture_output=True, text=True)
        if r.returncode: return self.send_json({'error': (r.stderr or r.stdout).strip()[-500:]})
        png = pathlib.Path(r.stdout.strip()).relative_to(ROOT)
        self.send_json({'png': f'/{png}'})

    # Body is a partial update, e.g. {"hs": 2} or {"clock": "start"}. Unknown keys are ignored.
    def update(self, patch):
        now = time.time()
        match patch.pop('clock', None):
            case 'start' if state['since'] is None: state['since'] = now
            case 'stop' if state['since'] is not None: state['elapsed'] += now - state['since']; state['since'] = None
            case 'reset': state['elapsed'], state['since'] = 0.0, None
            case int() | float() as secs: state['elapsed'] = max(0.0, float(secs)); state['since'] = state['since'] and now
        for k in ('home', 'away', 'period', 'show', 'hs', 'as'):
            if k in patch: state[k] = max(0, int(patch[k])) if k in ('hs', 'as') else patch[k]
        self.send_json(view())

if __name__ == '__main__':
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))  # no packet is sent; just finds the LAN address
        LAN = s.getsockname()[0]
    except OSError:
        pass
    print(f'Hub (open this):  http://localhost:8000/\nControl (phone):  http://{LAN}:8000/live/control.html')
    ThreadingHTTPServer(('0.0.0.0', 8000), Handler).serve_forever()
