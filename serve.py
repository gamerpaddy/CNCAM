# Dev static server: http.server with caching disabled so edited ES modules
# are always re-fetched (Chrome heuristically caches modules otherwise).
#
# POST /_shot/<name>.png with a data: URL (or raw base64) in the body writes the
# image to shots/<name>.png. The viewport can only be inspected by rendering it
# and looking at the result, and a canvas cannot write to disk on its own.
import base64
import http.server
import os
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8500
SHOTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'shots')


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Access-Control-Allow-Origin', '*')
        super().end_headers()

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


http.server.ThreadingHTTPServer(('127.0.0.1', PORT), NoCacheHandler).serve_forever()
