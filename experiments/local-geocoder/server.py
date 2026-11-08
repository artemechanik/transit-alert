from contextlib import closing
import argparse
import json
import os
import resource
import sqlite3
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit
from geocoder import ROOT, DB, connect, search, stats

RUN = ROOT / 'run'


class Handler(BaseHTTPRequestHandler):
    def send(self, code, payload, content_type='application/json; charset=utf-8'):
        data = payload.encode('utf-8') if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if len(self.path) > 2048:
            return self.send(414, dict(error='Запит задовгий.'))
        path = urlsplit(self.path)
        if path.path in {'/', '/index.html', '/app.js', '/style.css'}:
            name = 'index.html' if path.path in {'/', '/index.html'} else path.path[1:]
            mime = {'index.html':'text/html', 'app.js':'text/javascript', 'style.css':'text/css'}[name]
            return self.send(200, (ROOT / name).read_text(), mime + '; charset=utf-8')
        if path.path not in {'/search', '/health', '/stats'}:
            return self.send(404, dict(error='Not found'))
        try:
            with closing(connect()) as c:
                if path.path == '/health':
                    return self.send(200, dict(status='ok', offline=True, addresses=c.execute('SELECT count(*) FROM addresses').fetchone()[0]))
                if path.path == '/stats':
                    return self.send(200, dict(**stats(c),
                        server_peak_rss_mib=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1024,
                        pid=os.getpid()))
                args = parse_qs(path.query, keep_blank_values=True, strict_parsing=False, max_num_fields=10)
                if any(len(v) != 1 for v in args.values()) or set(args) - {'q', 'limit'}:
                    raise ValueError('Підтримуються лише по одному параметру q та limit.')
                raw_limit = args.get('limit', ['10'])[0]
                if not raw_limit.isascii() or not raw_limit.isdecimal():
                    raise ValueError('limit має бути додатним цілим числом.')
                started = time.perf_counter()
                c.set_progress_handler(lambda: int(time.perf_counter()-started > 2), 10000)
                data = search(c, args.get('q', [''])[0], int(raw_limit))
                data['elapsed_ms'] = (time.perf_counter()-started)*1000
                return self.send(200, data)
        except ValueError as e:
            return self.send(400, dict(error=str(e)))
        except sqlite3.OperationalError:
            return self.send(503, dict(error='Запит перевищив час обробки або база недоступна.'))

    def log_message(self, fmt, *args):
        print(time.strftime('%Y-%m-%d %H:%M:%S'), fmt % args, flush=True)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--port', type=int, default=0, help='0 selects a free port')
    args = p.parse_args()
    if not DB.is_file():
        raise SystemExit('Build the local database first: python3 build.py')
    RUN.mkdir(exist_ok=True)
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    state = dict(pid=os.getpid(), port=server.server_port, url=f'http://127.0.0.1:{server.server_port}/')
    (RUN / 'server.json').write_text(json.dumps(state, indent=2))
    print(json.dumps(state), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
