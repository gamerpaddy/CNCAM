# Dev static server: http.server that never lets an edited module go stale.
#
# Every response is `no-cache`, so the browser asks again on each load — but it
# asks with the ETag it already has, and an unchanged file comes back as an
# empty 304 instead of its whole body. The ETag is the file's modification time
# to the nanosecond and its size, so an edit is never mistaken for the old file.
#
# It listens on both loopback addresses and keeps connections open. `localhost`
# resolves to ::1 first on Windows, and a server on 127.0.0.1 alone made every
# request wait out the browser's IPv6 attempt before falling back — about 250ms
# each, for an app of some 250 modules. HTTP/1.0 (the library default) then
# closed each connection after one file, so the wait was paid again every time.
#
# POST /_shot/<name>.png with a data: URL (or raw base64) in the body writes the
# image to shots/<name>.png. The viewport can only be inspected by rendering it
# and looking at the result, and a canvas cannot write to disk on its own.
import base64
import http.server
import os
import socket
import sys
import threading
import time

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8500
SHOTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'shots')


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    # a module is text; say so, so no browser second-guesses a .js or .mjs
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm',
    }

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Access-Control-Allow-Origin', '*')
        super().end_headers()

    def send_head(self):
        path = self.translate_path(self.path)
        try:
            st = os.stat(path)
        except OSError:
            st = None
        if st is None or not os.path.isfile(path):
            return super().send_head()
        etag = '"%x-%x"' % (st.st_mtime_ns, st.st_size)
        if self.headers.get('If-None-Match') == etag:
            self.send_response(304)
            self.send_header('ETag', etag)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return None
        self._etag = etag
        return super().send_head()

    def send_header(self, keyword, value):
        super().send_header(keyword, value)
        # the ETag goes out with the file's own headers; If-Modified-Since is
        # left to the library and is never the deciding check (one-second
        # resolution cannot tell two saves in the same second apart)
        if keyword == 'Last-Modified' and getattr(self, '_etag', None):
            super().send_header('ETag', self._etag)
            self._etag = None

    def do_POST(self):
        if not self.path.startswith('/_shot/'):
            self.send_error(404)
            return
        name = os.path.basename(self.path)
        body = self.rfile.read(int(self.headers.get('Content-Length', 0))).decode()
        if ',' in body[:64]:
            body = body.split(',', 1)[1]
        os.makedirs(SHOTS, exist_ok=True)
        with open(os.path.join(SHOTS, name), 'wb') as f:
            f.write(base64.b64decode(body))
        self.send_response(200)
        self.send_header('Content-Length', '2')
        self.end_headers()
        self.wfile.write(b'ok')

    def log_message(self, *args):
        pass  # keep the console quiet


class IPv6Server(http.server.ThreadingHTTPServer):
    address_family = socket.AF_INET6


def serve(server):
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()


servers = [http.server.ThreadingHTTPServer(('127.0.0.1', PORT), NoCacheHandler)]
if socket.has_ipv6:
    try:
        servers.append(IPv6Server(('::1', PORT), NoCacheHandler))
    except OSError:
        pass  # no IPv6 loopback here; 127.0.0.1 is enough
for server in servers:
    serve(server)
print(f'CNCAM on http://localhost:{PORT}', flush=True)
try:
    while True:
        time.sleep(3600)   # a sleep, not a wait: Ctrl+C interrupts one on Windows
except KeyboardInterrupt:
    pass
