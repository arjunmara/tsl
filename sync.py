#!/usr/bin/env python3
"""Keep the laptop files and the phone maker (Firebase) in sync.

  ./sync.py login     sign in once with the organiser email/password (needed to upload)
  ./sync.py           pull + push once
  ./sync.py watch     keep syncing: phone changes land in the files within a second,
                      file edits go up within ~2s (live/server.py runs this for you after login)

Last change wins. Reading is public, so make.py pulls the latest before every render even without login.
"""
import getpass, json, pathlib, sys, threading, time, urllib.request

ROOT = pathlib.Path(__file__).resolve().parent
DB = 'https://tamghassuperleague-4242a-default-rtdb.asia-southeast1.firebasedatabase.app/tsl'
KEY = 'AIzaSyAicg1RfR7xmmfdyxDhWD0wib-TjVLO6Bs'  # public web API key (same as maker.html)
FILES = {'results': 'matchday/results.txt', 'fixtures': 'matchday/fixtures.txt', 'groups': 'matchday/groups.txt',
         'squads': 'teamlist/squads.txt', 'goals': 'matchday/goals.json', 'events': 'matchday/events.json'}
TOKEN_FILE = pathlib.Path.home() / '.config' / 'tsl-sync.json'
_auth = {}  # idToken + expiry, refreshed from the saved refresh token
_wrote = {}  # what we last wrote/read per key, so our own writes don't bounce back as "edits"


def http(url, data=None, method=None):
    req = urllib.request.Request(url, None if data is None else json.dumps(data).encode(), method=method,
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)


def token():
    if _auth.get('exp', 0) > time.time() + 60:
        return _auth['id']
    if not TOKEN_FILE.exists():
        return None
    r = http(f'https://securetoken.googleapis.com/v1/token?key={KEY}',
             {'grant_type': 'refresh_token', 'refresh_token': json.loads(TOKEN_FILE.read_text())['refresh']})
    _auth.update(id=r['id_token'], exp=time.time() + int(r['expires_in']))
    return _auth['id']


def login():
    email, pw = input('Organiser email: ').strip(), getpass.getpass('Password: ')
    r = http(f'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key={KEY}',
             {'email': email, 'password': pw, 'returnSecureToken': True})
    TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
    TOKEN_FILE.write_text(json.dumps({'refresh': r['refreshToken']}))
    TOKEN_FILE.chmod(0o600)
    print('Signed in ✓ — uploads enabled.')


def read(key):
    f = ROOT / FILES[key]
    return f.read_text() if f.exists() else None


def pull(remote=None):
    """Write every key Firebase has into its file. Returns the remote dict."""
    remote = http(f'{DB}.json') if remote is None else remote
    for key, val in (remote or {}).items():
        if key in FILES and isinstance(val, str) and val != read(key):
            (ROOT / FILES[key]).write_text(val)
            print(f'  ← {FILES[key]} (from phone)')
        if key in FILES:
            _wrote[key] = val
    return remote or {}


def push(keys=FILES):
    if not keys:
        return
    t = token()
    if not t:
        return print('  (not signed in: run ./sync.py login to upload laptop edits)')
    for key in keys:
        val = read(key)
        if val is not None and val != _wrote.get(key):
            http(f'{DB}/{key}.json?auth={t}', val, 'PUT')
            http(f'{DB}/history.json?auth={t}', {'k': key, 'v': val, 'at': {'.sv': 'timestamp'}, 'by': 'laptop'}, 'POST')
            _wrote[key] = val
            print(f'  → {FILES[key]} (to phone)')


def once():
    remote = pull()
    push([k for k in FILES if k not in remote])  # first run: upload files the phone doesn't have yet


def watch():
    once()

    def stream():  # Firebase streams every change as server-sent events; re-pull on each one
        while True:
            try:
                req = urllib.request.Request(f'{DB}.json', headers={'Accept': 'text/event-stream'})
                with urllib.request.urlopen(req, timeout=90) as r:
                    for line in r:
                        if line.startswith(b'data:') and line.strip() not in (b'data: null', b'data:null'):
                            pull()
            except Exception as e:
                print('  sync stream reconnecting:', e)
                time.sleep(3)

    threading.Thread(target=stream, daemon=True).start()
    while True:  # ponytail: 2s polling of 5 small files; inotify if this ever matters
        time.sleep(2)
        try:
            push([k for k in FILES if read(k) is not None and read(k) != _wrote.get(k)])
        except Exception as e:
            print('  sync upload failed, will retry:', e)


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'once'
    {'login': login, 'once': once, 'watch': watch}.get(cmd, lambda: sys.exit(__doc__))()
