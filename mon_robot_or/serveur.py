"""Gold_finger — serveur local (Python standard, rien à installer).

Sert la page et relaie les données (le navigateur ne peut pas les lire directement à cause du CORS) :
  /api/candles?tf=15m&limit=300   bougies PAXG/USDT de Binance (≈ prix de l'or spot)
  /api/calendar                   calendrier économique ForexFactory de la semaine
  /api/news                       titres d'actualité (FXStreet + Investing.com)
  /api/dxy                        indice dollar (variation du jour)
  /api/ia/...                     relais vers Google Gemini avec la clé du serveur (le navigateur ne la voit jamais)

  /api/claude                     relais vers Claude (Anthropic) avec la clé du serveur

Clés côté serveur (la page marche sans rien saisir, le navigateur ne les voit jamais) :
  Gemini : ta clé seule dans cle_gemini.txt à côté de ce script (ou variable GEMINI_API_KEY)
  Claude : ta clé API seule dans cle_claude.txt (ou variable ANTHROPIC_API_KEY) — nécessite `pip install anthropic`

Lancement :  python serveur.py      puis ouvrir http://localhost:8010
"""
import http.server
import json
import os
import re
import socketserver
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

import comptes

PORT = int(os.environ.get("PORT", "8010"))
# en hébergement (variable PORT fournie par l'hébergeur) on écoute toutes les adresses ; en local, seulement ce PC
HOST = os.environ.get("HOST", "0.0.0.0" if "PORT" in os.environ else "127.0.0.1")
ROOT = os.path.dirname(os.path.abspath(__file__))
UA = {"User-Agent": "Mozilla/5.0 (Gold_finger)"}
CACHE = {}


def fetch(url, ttl):
    now = time.time()
    if url in CACHE and now - CACHE[url][0] < ttl:
        return CACHE[url][1]
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=15) as r:
        data = r.read()
    CACHE[url] = (now, data)
    return data


# marché -> source des bougies. Binance (crypto, et PAXG ≈ or spot) ou Yahoo Finance (forex, futures indices/matières premières)
MARKETS = {
    "gold": ("binance", "PAXGUSDT"), "silver": ("yahoo", "SI=F"), "oil": ("yahoo", "CL=F"),
    "btc": ("binance", "BTCUSDT"), "eth": ("binance", "ETHUSDT"),
    "eurusd": ("yahoo", "EURUSD=X"), "gbpusd": ("yahoo", "GBPUSD=X"), "usdjpy": ("yahoo", "JPY=X"),
    "nas100": ("yahoo", "NQ=F"), "sp500": ("yahoo", "ES=F"), "us30": ("yahoo", "YM=F"),
}
YAHOO_TF = {"5m": ("5m", "5d"), "15m": ("15m", "5d"), "1h": ("1h", "60d"), "4h": ("1h", "60d"), "1d": ("1d", "2y")}


def yahoo(symbol, tf):
    interval, rng = YAHOO_TF[tf]
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(symbol)}?interval={interval}&range={rng}"
    r = json.loads(fetch(url, 20))["chart"]["result"][0]
    q = r["indicators"]["quote"][0]
    out = []
    for i, t in enumerate(r.get("timestamp") or []):
        o, h, l, c = q["open"][i], q["high"][i], q["low"][i], q["close"][i]
        if None in (o, h, l, c):
            continue
        out.append(dict(time=t, open=o, high=h, low=l, close=c, volume=q["volume"][i] or 0))
    if tf == "4h":  # Yahoo n'a pas de 4 h : on regroupe les bougies 1 h par tranches de 4 h (UTC)
        agg = []
        for k in out:
            b = k["time"] - k["time"] % 14400
            if agg and agg[-1]["time"] == b:
                a = agg[-1]; a["high"] = max(a["high"], k["high"]); a["low"] = min(a["low"], k["low"]); a["close"] = k["close"]; a["volume"] += k["volume"]
            else:
                agg.append(dict(k, time=b))
        out = agg
    return out


def candles(tf, limit, market="gold"):
    if tf not in ("1m", "5m", "15m", "1h", "4h", "1d") or market not in MARKETS:
        raise ValueError("tf / marché")
    limit = max(10, min(1000, limit))
    src, sym = MARKETS[market]
    if src == "yahoo":
        return yahoo(sym, "15m" if tf == "1m" else tf)[-limit:]
    raw = json.loads(fetch(f"https://data-api.binance.vision/api/v3/klines?symbol={sym}&interval={tf}&limit={limit}", 20))
    return [dict(time=k[0] // 1000, open=float(k[1]), high=float(k[2]), low=float(k[3]), close=float(k[4]), volume=float(k[5]))
            for k in raw]


def calendar():
    raw = json.loads(fetch("https://nfs.faireconomy.media/ff_calendar_thisweek.json", 900))
    return [e for e in raw if e.get("impact") in ("High", "Medium")]


def news():
    out = []
    for src, url in (("FXStreet", "https://www.fxstreet.com/rss/news"), ("Investing", "https://www.investing.com/rss/news_285.rss")):
        try:
            root = ET.fromstring(fetch(url, 300))
            for it in root.iter("item"):
                t = (it.findtext("title") or "").strip()
                d = re.sub(r"<[^>]+>", "", it.findtext("description") or "").strip()[:300]
                out.append(dict(source=src, title=t, description=d, link=it.findtext("link") or "", date=it.findtext("pubDate") or ""))
        except Exception as e:  # une source en panne ne bloque pas l'autre
            out.append(dict(source=src, title=f"(source indisponible : {e})", description="", link="", date=""))
    return out


def dxy():
    """Indice dollar (ICE DX-Y.NYB, Yahoo) : dernier prix et variation du jour en %."""
    m = json.loads(fetch("https://query1.finance.yahoo.com/v8/finance/chart/DX-Y.NYB?interval=1d&range=5d", 300))["chart"]["result"][0]["meta"]
    prev = m.get("chartPreviousClose") or m.get("previousClose")
    price = m["regularMarketPrice"]
    return dict(price=price, change=round((price - prev) / prev * 100, 3) if prev else m.get("regularMarketChangePercent", 0))


GEMINI = "https://generativelanguage.googleapis.com/v1beta/"
STATIC = {"/index.html", "/moteur.js", "/ia.js", "/analyse.js", "/app.js", "/marches.js"}   # seuls fichiers servis (jamais la clé ni le .py)


def server_key():
    k = os.environ.get("GEMINI_API_KEY", "").strip()
    if not k:
        try:
            with open(os.path.join(ROOT, "cle_gemini.txt"), encoding="utf-8") as f:
                k = f.read().strip()
        except OSError:
            k = ""
    return k


def gemini(path, body=None):
    """Appel Gemini avec la clé du serveur ; renvoie (code HTTP, octets JSON)."""
    req = urllib.request.Request(GEMINI + path, data=body, method="POST" if body is not None else "GET",
                                 headers={"Content-Type": "application/json", "x-goog-api-key": server_key()})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


# ---------------------------------------------------------------- Claude (Anthropic) — clé dans cle_claude.txt
FALLBACK_MODELS = ("claude-opus-5-5", "claude-sonnet-5-5")   # modèles qui acceptent fallbacks="default"


def claude_key():
    k = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not k:
        try:
            with open(os.path.join(ROOT, "cle_claude.txt"), encoding="utf-8") as f:
                k = f.read().strip()
        except OSError:
            k = ""
    return k


def claude_client(key=None):
    import anthropic  # pip install anthropic
    return anthropic.Anthropic(api_key=key or claude_key())


def claude_models(key=None):
    return [m.id for m in claude_client(key).models.list() if m.id.startswith("claude-")]


def claude_call(req, key=None):
    """req = {model, system, messages:[{role, parts:[{text}|{image:{mime,data}}]}], search, effort}
    key = clé de l'utilisateur (en-tête X-Claude-Key, jamais enregistrée) ou, à défaut, celle du serveur.
    Renvoie {text, model, sources}."""
    model = req.get("model") or "claude-haiku-5-5"   # le moins cher par défaut
    msgs = []
    for m in req.get("messages", []):
        blocks = []
        for p in m.get("parts", []):
            if "image" in p:
                blocks.append({"type": "image", "source": {"type": "base64", "media_type": p["image"]["mime"], "data": p["image"]["data"]}})
            elif p.get("text"):
                blocks.append({"type": "text", "text": p["text"]})
        if blocks:
            msgs.append({"role": "assistant" if m.get("role") == "assistant" else "user", "content": blocks})
    kw = dict(model=model, max_tokens=16000, messages=msgs, output_config={"effort": req.get("effort") or "medium"})
    if req.get("system"):
        kw["system"] = req["system"]
    if req.get("search"):
        # la version avec filtrage dynamique n'existe pas sur Haiku : version de base pour lui
        tool = "web_search_20250305" if "haiku" in model else "web_search_20260209"
        kw["tools"] = [{"type": tool, "name": "web_search", "max_uses": 3}]
    if model in FALLBACK_MODELS:  # si le modèle refuse pour raison de sécurité, l'API relance sur un autre modèle
        kw["betas"] = ["server-side-fallback-2026-07-01"]
        kw["fallbacks"] = "default"
    client = claude_client(key)
    create = client.beta.messages.create
    resp = create(**kw)
    for _ in range(5):  # la recherche web peut mettre le tour en pause : on le reprend
        if resp.stop_reason != "pause_turn":
            break
        kw["messages"] = msgs + [{"role": "assistant", "content": resp.content}]
        resp = create(**kw)
    if resp.stop_reason == "refusal":
        raise RuntimeError("Claude a refusé cette demande.")
    text = "".join(b.text for b in resp.content if b.type == "text")
    sources = []
    for b in resp.content:
        if b.type == "web_search_tool_result" and isinstance(b.content, list):
            sources += [r.title or r.url for r in b.content if getattr(r, "type", "") == "web_search_result"]
    if not text:
        raise RuntimeError(f"réponse vide ({resp.stop_reason})")
    return {"text": text, "model": resp.model, "sources": sources[:4]}


def claude_error(e):
    """Erreurs du SDK -> (code HTTP, message clair en français)."""
    import anthropic
    if isinstance(e, anthropic.AuthenticationError):
        return 401, "clé Claude invalide (vérifie-la dans Réglages)"
    if isinstance(e, anthropic.PermissionDeniedError):
        return 403, "cette clé Claude n'a pas accès à ce modèle"
    if isinstance(e, anthropic.NotFoundError):
        return 404, "modèle Claude introuvable"
    if isinstance(e, anthropic.RateLimitError):
        return 429, "limite de requêtes Claude atteinte, réessaie dans un moment"
    if isinstance(e, anthropic.BadRequestError):
        msg = e.message
        if "credit balance" in msg.lower():
            return 400, "crédit API Claude épuisé : ajoute du crédit sur platform.claude.com (Billing)"
        return 400, msg
    if isinstance(e, anthropic.APIStatusError):
        return e.status_code, e.message
    if isinstance(e, anthropic.APIConnectionError):
        return 502, "impossible de joindre l'API Claude (connexion)"
    return 500, str(e)



LOGIN_PAGE = """<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connexion — Gold_finger</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d12;color:#e6e8eb;font:15px system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px;box-sizing:border-box}
form{width:min(360px,100%);background:#11141b;border:1px solid #222733;border-radius:16px;padding:26px}
h1{margin:0 0 18px;font-size:22px;color:#f5b81c}label{display:block;font-size:13px;color:#8b949e;margin:12px 0 5px}
input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:10px;border:1px solid #2a303c;background:#0d1117;color:#e6e8eb;font:inherit}
button{margin-top:18px;width:100%;padding:11px;border:0;border-radius:10px;background:#f5b81c;color:#111;font-weight:700;font:inherit;cursor:pointer}
#err{color:#f85149;font-size:13px;min-height:18px;margin-top:10px}</style></head><body>
<form id="f"><h1>🥇 Gold_finger</h1><label for="u">Identifiant</label><input id="u" autocomplete="username" required>
<label for="p">Mot de passe</label><input id="p" type="password" autocomplete="current-password" required>
<button>Se connecter</button><div id="err"></div></form>
<script>document.getElementById('f').onsubmit=async e=>{e.preventDefault();
const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:u.value,mdp:p.value})});
if(r.ok)location.href='/';else{const j=await r.json().catch(()=>({}));err.textContent=j.error||'Identifiant ou mot de passe incorrect.';}};</script>
</body></html>"""


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def send_raw(self, code, data):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    # ---------------------------------------------------------------- connexion (seulement si des comptes existent)
    def ip(self):
        return (self.headers.get("X-Forwarded-For") or self.client_address[0]).split(",")[0].strip()

    def session_user(self):
        for part in (self.headers.get("Cookie") or "").split(";"):
            k, _, v = part.strip().partition("=")
            if k == "gf_session":
                return comptes.read_token(v)
        return None

    def set_cookie(self, value, max_age):
        secure = "; Secure" if self.headers.get("X-Forwarded-Proto", "") == "https" else ""
        return f"gf_session={value}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}{secure}"

    def guard(self, path):
        """True si la requête peut passer ; sinon la réponse (redirection / 401) est déjà envoyée."""
        if not comptes.USERS or path in ("/login", "/api/login") or self.session_user():
            return True
        if path.startswith("/api/"):
            self.send_json({"error": "connexion requise"}, 401)
        else:
            self.send_response(302); self.send_header("Location", "/login"); self.send_header("Content-Length", "0"); self.end_headers()
        return False

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == "/api/login":
            ip = self.ip()
            if comptes.blocked(ip):
                return self.send_json({"error": "Trop d'essais. Réessaie dans 15 minutes."}, 429)
            try:
                d = json.loads(self.rfile.read(min(int(self.headers.get("Content-Length", 0)), 10_000)) or b"{}")
            except ValueError:
                d = {}
            uid = str(d.get("id", "")).strip().lower()
            if comptes.check(uid, str(d.get("mdp", ""))):
                b = json.dumps({"ok": True}).encode()
                self.send_response(200); self.send_header("Content-Type", "application/json")
                self.send_header("Set-Cookie", self.set_cookie(comptes.make_token(uid), comptes.SESSION_DAYS * 86400))
                self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
                return
            comptes.failed(ip)
            return self.send_json({"error": "Identifiant ou mot de passe incorrect."}, 401)
        if u.path == "/api/logout":
            self.send_response(200); self.send_header("Set-Cookie", self.set_cookie("", 0)); self.send_header("Content-Length", "0"); self.end_headers()
            return
        if not self.guard(u.path):
            return
        if u.path == "/api/claude":
            key = self.user_claude_key() or claude_key()
            if not key:
                return self.send_json({"error": {"message": "pas de clé Claude : mets la tienne dans Réglages"}}, 400)
            try:
                req = json.loads(self.rfile.read(min(int(self.headers.get("Content-Length", 0)), 25_000_000)) or b"{}")
                return self.send_json(claude_call(req, key))
            except Exception as e:
                code, msg = claude_error(e)
                return self.send_json({"error": {"message": msg}}, code)
        if u.path != "/api/ia/generate":
            return self.send_json({"error": "introuvable"}, 404)
        if not server_key():
            return self.send_json({"error": {"message": "pas de clé Gemini sur le serveur (cle_gemini.txt)"}}, 400)
        model = urllib.parse.parse_qs(u.query).get("model", [""])[0]
        if not re.fullmatch(r"[A-Za-z0-9.\-]+", model):
            return self.send_json({"error": {"message": "modèle invalide"}}, 400)
        body = self.rfile.read(min(int(self.headers.get("Content-Length", 0)), 25_000_000))
        return self.send_raw(*gemini(f"models/{model}:generateContent", body))

    def log_message(self, *a):
        pass

    def user_claude_key(self):
        k = (self.headers.get("X-Claude-Key") or "").strip()
        return k if re.fullmatch(r"[A-Za-z0-9_\-]{20,300}", k) else ""

    def send_json(self, obj, code=200):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == "/login":
            if not comptes.USERS:
                self.send_response(302); self.send_header("Location", "/"); self.send_header("Content-Length", "0"); self.end_headers()
                return
            b = LOGIN_PAGE.encode()
            self.send_response(200); self.send_header("Content-Type", "text/html; charset=utf-8"); self.send_header("Content-Length", str(len(b)))
            self.end_headers(); self.wfile.write(b)
            return
        if not self.guard(u.path):
            return
        q = urllib.parse.parse_qs(u.query)
        try:
            if u.path == "/api/candles":
                return self.send_json(candles(q.get("tf", ["15m"])[0], int(q.get("limit", ["300"])[0]), q.get("market", ["gold"])[0]))
            if u.path == "/api/calendar":
                return self.send_json(calendar())
            if u.path == "/api/news":
                return self.send_json(news())
            if u.path == "/api/dxy":
                return self.send_json(dxy())
            if u.path == "/api/ia/status":
                return self.send_json({"serverKey": bool(server_key()), "claudeKey": bool(claude_key()), "user": self.session_user() if comptes.USERS else None})
            if u.path == "/api/claude/models":
                key = self.user_claude_key() or claude_key()
                if not key:
                    return self.send_json({"error": {"message": "pas de clé Claude"}}, 400)
                try:
                    return self.send_json(claude_models(key))
                except Exception as e:
                    code, msg = claude_error(e)
                    return self.send_json({"error": {"message": msg}}, code)
            if u.path == "/api/ia/models":
                if not server_key():
                    return self.send_json({"error": {"message": "pas de clé Gemini sur le serveur"}}, 400)
                return self.send_raw(*gemini("models?pageSize=1000"))
        except Exception as e:
            return self.send_json({"error": str(e)}, 502)
        if u.path == "/":
            self.path = "/index.html"
        elif u.path not in STATIC:
            return self.send_json({"error": "introuvable"}, 404)
        return super().do_GET()


if __name__ == "__main__":
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer((HOST, PORT), H) as s:
        print(f"Gold_finger : http://localhost:{PORT}  (Ctrl+C pour arrêter)")
        s.serve_forever()
