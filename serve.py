"""Local web server for testing the web app:  python serve.py [port]
Open http://localhost:8080 on this computer, or http://<this-PC-IP>:8080 from a phone on the same Wi-Fi
(OneDrive sign-in needs https or localhost, so test OneDrive on the computer or on the hosted site)."""
import http.server
import os
import socket
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
os.chdir(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
                      ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".json": "application/json"}

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


try:
    ip = socket.gethostbyname(socket.gethostname())
except OSError:
    ip = "?"
print(f"Serving on http://localhost:{PORT}  (LAN: http://{ip}:{PORT})")
http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
