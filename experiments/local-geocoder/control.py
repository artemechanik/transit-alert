"""One explicitly managed local process, with PID, port and log."""
import argparse
import json
import os
import signal
import subprocess
import sys
import time
import urllib.request
from geocoder import ROOT

RUN = ROOT / 'run'
STATE = RUN / 'server.json'


def state():
    return json.loads(STATE.read_text()) if STATE.exists() else None


def ours(s):
    try:
        args = (open(f"/proc/{s['pid']}/cmdline", 'rb').read()).split(b'\0')
        return str(ROOT / 'server.py').encode() in args
    except (FileNotFoundError, ProcessLookupError):
        return False


def main():
    p = argparse.ArgumentParser()
    p.add_argument('action', choices=['start','stop','status'])
    p.add_argument('--port', type=int, default=0)
    a = p.parse_args()
    s = state()
    if a.action == 'stop':
        if s and ours(s):
            os.kill(s['pid'], signal.SIGTERM)
            for _ in range(50):
                if not ours(s):
                    break
                time.sleep(.1)
            else:
                raise SystemExit('Server did not stop; inspect run/server.log.')
        STATE.unlink(missing_ok=True)
        print('Stopped.')
    elif a.action == 'status':
        print(json.dumps(s if s and ours(s) else dict(status='stopped')))
    else:
        if s and ours(s):
            print(s['url'])
            return
        RUN.mkdir(exist_ok=True)
        STATE.unlink(missing_ok=True)
        with open(RUN / 'server.log', 'ab') as log:
            process = subprocess.Popen([sys.executable, str(ROOT/'server.py'), '--port', str(a.port)],
                stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True, cwd=ROOT)
        for _ in range(100):
            s = state()
            if s and s['pid'] == process.pid:
                try:
                    with urllib.request.urlopen(s['url']+'health', timeout=1) as r:
                        assert r.status == 200
                    print(s['url'])
                    return
                except OSError:
                    pass
            if process.poll() is not None:
                raise SystemExit('Startup failed; see run/server.log.')
            time.sleep(.1)
        process.terminate()
        raise SystemExit('Startup timed out; child terminated.')


if __name__ == '__main__':
    main()
