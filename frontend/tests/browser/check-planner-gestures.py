"""Native touch regression check. Run: python3 frontend/tests/browser/check-planner-gestures.py.
Requires Chrome/Chromium and Python stdlib only; uses mock API and a disposable profile.
"""
import base64
import json
import os
from pathlib import Path
import re
import shutil
import socket
import struct
import subprocess
import tempfile
import time

FRONTEND = Path(__file__).resolve().parents[2]

class CDP:
    def __init__(self, port, path):
        self.sock = socket.create_connection(('127.0.0.1', port), timeout=10)
        self.ident = 0
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall((f'GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\n'
                           f'Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n').encode())
        header = b''
        while not header.endswith(b'\r\n\r\n'):
            header += self.read(1)
        assert b'101' in header, header
    def read(self, n):
        data = b''
        while len(data) < n:
            part = self.sock.recv(n-len(data))
            if not part:
                raise RuntimeError('Chrome closed the diagnostic connection')
            data += part
        return data
    def call(self, method, params=None, session=None):
        self.ident += 1
        obj = dict(id=self.ident, method=method, params=params or {})
        if session:
            obj['sessionId'] = session
        data = json.dumps(obj).encode()
        size = len(data)
        length = bytes([128 | size]) if size < 126 else b'\xfe'+struct.pack('!H', size)
        mask = os.urandom(4)
        self.sock.sendall(b'\x81'+length+mask+bytes(x ^ mask[i%4] for i,x in enumerate(data)))
        while True:
            _, second = self.read(2)
            size = second & 127
            if size == 126:
                size = struct.unpack('!H', self.read(2))[0]
            elif size == 127:
                size = struct.unpack('!Q', self.read(8))[0]
            assert size < 16*1024*1024, 'Unexpected diagnostic frame size'
            mask = self.read(4) if second & 128 else None
            data = self.read(size)
            if mask:
                data = bytes(x ^ mask[i%4] for i,x in enumerate(data))
            response = json.loads(data)
            if response.get('id') == self.ident:
                assert 'error' not in response, response
                return response.get('result', {})

def run():
    chrome_path = shutil.which('google-chrome') or shutil.which('chromium') or shutil.which('chromium-browser')
    assert chrome_path, 'Chrome or Chromium is required'
    with tempfile.TemporaryDirectory(prefix='lubus-gestures-') as directory:
        work = Path(directory)
        html = re.sub(r'<script\b[^>]*>.*?</script>', '', (FRONTEND/'index.html').read_text(), flags=re.S)
        html = re.sub(r'<link[^>]+https://[^>]+>', '', html)
        html = re.sub(r'href="(css/[^\"]+)"', lambda m: f'href="{(FRONTEND/m[1]).as_uri()}"', html)
        source = (Path(__file__).with_name('planner-gestures-fixture.js')).as_uri()
        html = html.replace('</body>', f'<script type="module" src="{source}"></script></body>')
        page = work/'fixture.html'; page.write_text(html)
        process = subprocess.Popen([chrome_path,'--headless','--no-sandbox','--disable-gpu',
            '--allow-file-access-from-files','--disable-background-networking','--remote-debugging-port=0',
            f'--user-data-dir={work / "profile"}', 'about:blank'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        client = None
        try:
            port_file = work/'profile/DevToolsActivePort'
            for _ in range(100):
                if port_file.exists(): break
                time.sleep(.1)
            port, path = port_file.read_text().splitlines()[:2]
            client = CDP(int(port), path)
            target = client.call('Target.createTarget', {'url':'about:blank'})['targetId']
            session = client.call('Target.attachToTarget', {'targetId':target,'flatten':True})['sessionId']
            def call(method, params=None): return client.call(method, params, session)
            def js(expression):
                if expression.startswith('await '): expression = '(async()=>{'+expression+'})()'
                result = call('Runtime.evaluate',dict(expression=expression,awaitPromise=True,returnByValue=True))
                assert 'exceptionDetails' not in result, result
                return result.get('result',{}).get('value')
            def point(selector):
                return js('(()=>{const r=document.querySelector('+json.dumps(selector)+').getBoundingClientRect();'
                          'return {x:r.left+r.width/2,y:r.top+Math.min(r.height/2,45)}})()')
            def swipe(selector, distance):
                p = point(selector)
                call('Input.dispatchTouchEvent', {'type':'touchStart','touchPoints':[p]}); time.sleep(.04)
                for fraction in [1/3,2/3,1]:
                    call('Input.dispatchTouchEvent', {'type':'touchMove','touchPoints':[dict(x=p['x'],y=p['y']+distance*fraction)]}); time.sleep(.04)
                call('Input.dispatchTouchEvent', {'type':'touchEnd','touchPoints':[]}); time.sleep(.3)
            call('Emulation.setDeviceMetricsOverride',dict(width=430,height=1000,deviceScaleFactor=1,mobile=True))
            call('Emulation.setTouchEmulationEnabled',dict(enabled=True,maxTouchPoints=1))
            call('Emulation.setEmulatedMedia',{'features':[{'name':'prefers-reduced-motion','value':'reduce'}]})
            call('Page.navigate',{'url':page.as_uri()})
            for _ in range(100):
                if js('!!window.fixture?.ready'): break
                time.sleep(.1)
            assert js('!!window.fixture?.ready'), 'Fixture did not initialize'
            js('fixture.root.scrollTop=70')
            before = js('fixture.metrics()')
            assert before['liveHeight'] == before['liveContent'], before
            swipe('.fullscreen-expanded .lubus-live',-60)
            assert js('fixture.root.scrollTop') > before['outer'], 'Fitting LIVE blocks native scroll chaining'
            print('PASS fitting LIVE → outer native scroll')
            js("fixture.root.scrollTop=70;const filler=document.createElement('style');filler.id='overflow-fixture';filler.textContent='.lubus-live::after { content: \"\"; display:block; height:800px; }';document.head.append(filler);fixture.root.querySelector('.lubus-live').scrollTop=40")
            before = js('fixture.metrics()'); swipe('.fullscreen-expanded .lubus-live',-60)
            after = js('fixture.metrics()')
            assert after['inner'] > before['inner'] and abs(after['outer']-before['outer']) < 2, (before,after)
            print('PASS overflowing LIVE scrolls internally first')
            js("document.querySelector('#overflow-fixture').remove();fixture.root.querySelector('.lubus-live').scrollTop=0")
            for index, direction in [(0,1),(11,-1)]:
                js(f'await fixture.open({index})')
                for distance in [59,60,61]:
                    js('fixture.root.scrollTop='+('0' if index==0 else 'fixture.root.scrollHeight'))
                    before = js('fixture.routeRequests'); swipe('.fullscreen-expanded .lubus-live',distance*direction)
                    after = js('fixture.routeRequests')
                    assert after-before == (1 if distance>60 else 0), (index,distance,before,after)
            print('PASS pull/load-more: 59/60 px do nothing; 61 px triggers the existing action')
            js('await fixture.open(0);await fixture.open(1)')
            before = js('fixture.headerBacks'); swipe('.fullscreen-expanded .trasa-compact-header',0)
            assert js('fixture.headerBacks') == before+1 and not js('fixture.metrics().open'), 'A → B → header did not close'
            js('await fixture.open(0);await fixture.open(1);history.back()'); time.sleep(.25)
            assert not js('fixture.metrics().open'), 'A → B → system Back did not close'
            print('PASS A → B closes on first header tap or system Back')
            js("await fixture.open(0);fixture.root.querySelector('[data-lubus-tab=journey]').click();fixture.root.scrollTop=70;fixture.root.querySelector('.lubus-journey').scrollTop=40")
            before = js('({outer:fixture.root.scrollTop,inner:fixture.root.querySelector(".lubus-journey").scrollTop})')
            swipe('.fullscreen-expanded .lubus-journey',-60)
            after = js('({outer:fixture.root.scrollTop,inner:fixture.root.querySelector(".lubus-journey").scrollTop})')
            assert after['inner']>before['inner'] and abs(after['outer']-before['outer'])<2, (before,after)
            js('fixture.root.querySelector(".lubus-journey").scrollTop=10000'); before=js('fixture.root.scrollTop')
            swipe('.fullscreen-expanded .lubus-journey',-60)
            assert abs(js('fixture.root.scrollTop')-before)<2, 'Podróż leaked scrolling at its boundary'
            print('PASS Podróż retains independent scrolling and containment')
            js('fixture.planner.closePlannerAccordion();fixture.root.scrollTop=0'); time.sleep(.2)
            call('Emulation.setEmulatedMedia',{'features':[{'name':'prefers-reduced-motion','value':'no-preference'}]})
            js('fixture.root.querySelectorAll(".trasa-card")[5].click()')
            assert js('fixture.root.dataset.cardAligning') == 'true'
            swipe('#route-results-list',-25)
            assert js('fixture.root.dataset.cardAligning') is None
            before = js('fixture.root.scrollTop'); time.sleep(.8)
            assert abs(js('fixture.root.scrollTop')-before)<2, 'Auto-positioning resumed after manual interruption'
            print('PASS manual gesture cancels auto-positioning without resuming')
        finally:
            if client: client.sock.close()
            process.terminate()
            try: process.wait(timeout=5)
            except subprocess.TimeoutExpired: process.kill(); process.wait()

if __name__ == '__main__':
    run()
