"""Point d'entrée Vercel : une seule fonction qui reçoit toutes les requêtes (cf. vercel.json)
et les passe au même code que le serveur local (serveur.H) — page, prix, news, connexion, IA.

vercel.json réécrit /chemin?x=1 en /api/index?__p=/chemin&x=1 : on reconstruit le chemin d'origine ici.
"""
import io
import os
import sys
import urllib.parse
from http.client import parse_headers

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import serveur  # noqa: E402


def app(environ, start_response):
    qs = urllib.parse.parse_qsl(environ.get("QUERY_STRING", ""), keep_blank_values=True)
    path = next((v for k, v in qs if k == "__p"), None) or environ.get("PATH_INFO", "/") or "/"
    if not path.startswith("/"):
        path = "/" + path
    rest = urllib.parse.urlencode([(k, v) for k, v in qs if k != "__p"])

    h = serveur.H.__new__(serveur.H)           # même gestionnaire que le serveur local, sans socket
    h.directory = serveur.ROOT
    h.client_address = (environ.get("REMOTE_ADDR", "0.0.0.0"), 0)
    h.server = None
    h.command = environ.get("REQUEST_METHOD", "GET")
    h.path = path + ("?" + rest if rest else "")
    h.request_version = "HTTP/1.1"
    h.requestline = f"{h.command} {h.path} HTTP/1.1"
    h.close_connection = True
    raw = "".join(f"{k[5:].replace('_', '-').title()}: {v}\r\n" for k, v in environ.items() if k.startswith("HTTP_"))
    if environ.get("CONTENT_TYPE"):
        raw += f"Content-Type: {environ['CONTENT_TYPE']}\r\n"
    length = int(environ.get("CONTENT_LENGTH") or 0)
    raw += f"Content-Length: {length}\r\n\r\n"
    h.headers = parse_headers(io.BytesIO(raw.encode("latin-1", "replace")))
    h.rfile = io.BytesIO(environ["wsgi.input"].read(length) if length else b"")
    out = io.BytesIO()
    h.wfile = out

    method = getattr(h, "do_" + h.command, None)
    if method is None:
        start_response("405 Method Not Allowed", [("Content-Type", "text/plain")])
        return [b"methode non geree"]
    method()
    if hasattr(h, "_headers_buffer") and h._headers_buffer:   # en-têtes pas encore écrits
        h.flush_headers()

    data = out.getvalue()
    head, _, body = data.partition(b"\r\n\r\n")
    lines = head.decode("latin-1").split("\r\n")
    status = lines[0].split(" ", 1)[1] if lines and " " in lines[0] else "500 Internal Server Error"
    skip = {"server", "date", "connection", "transfer-encoding"}
    headers = [tuple(l.split(": ", 1)) for l in lines[1:] if ": " in l and l.split(": ", 1)[0].lower() not in skip]
    start_response(status, headers)
    return [body]
