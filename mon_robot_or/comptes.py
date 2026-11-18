"""Comptes utilisateurs (identifiant + mot de passe) pour Gold_finger.

Les comptes viennent de la variable d'environnement USERS (sur Hugging Face : Settings → Variables and secrets → New secret)
ou, en local, du fichier utilisateurs.txt à côté de serveur.py. Une ligne par compte :
    identifiant:pbkdf2$200000$<sel>$<empreinte>
Les mots de passe ne sont jamais stockés en clair (PBKDF2-SHA256). Pour créer une ligne :
    python comptes.py ajouter ali
Sans aucun compte défini, le site reste ouvert (pas de connexion demandée).
"""
import base64
import getpass
import hashlib
import hmac
import os
import secrets
import sys
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
ITER = 200_000
SESSION_DAYS = 30


def hash_password(pwd, salt=None, it=ITER):
    salt = salt or secrets.token_hex(16)
    h = hashlib.pbkdf2_hmac("sha256", pwd.encode(), bytes.fromhex(salt), it).hex()
    return f"pbkdf2${it}${salt}${h}"


def load_users():
    raw = os.environ.get("USERS", "")
    if not raw:
        try:
            with open(os.path.join(ROOT, "utilisateurs.txt"), encoding="utf-8") as f:
                raw = f.read()
        except OSError:
            raw = ""
    users = {}
    for line in raw.replace(";", "\n").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and ":" in line:
            uid, h = line.split(":", 1)
            users[uid.strip().lower()] = h.strip()
    return users


USERS = load_users()
# clé qui signe les sessions : variable SESSION_SECRET (conseillé en ligne), sinon aléatoire (sessions perdues au redémarrage)
SECRET = (os.environ.get("SESSION_SECRET") or secrets.token_hex(32)).encode()


def check(uid, pwd):
    h = USERS.get((uid or "").strip().lower())
    if not h:
        hash_password(pwd or "x")            # même temps de calcul qu'un vrai compte
        return False
    try:
        _, it, salt, _ = h.split("$")
        return hmac.compare_digest(hash_password(pwd or "", salt, int(it)), h)
    except ValueError:
        return False


def make_token(uid):
    exp = int(time.time()) + SESSION_DAYS * 86400
    msg = f"{uid}|{exp}".encode()
    sig = hmac.new(SECRET, msg, hashlib.sha256).hexdigest()
    return base64.urlsafe_b64encode(msg).decode() + "." + sig


def read_token(tok):
    """Renvoie l'identifiant si la session est valide, sinon None."""
    try:
        b, sig = tok.split(".", 1)
        msg = base64.urlsafe_b64decode(b.encode())
        if not hmac.compare_digest(hmac.new(SECRET, msg, hashlib.sha256).hexdigest(), sig):
            return None
        uid, exp = msg.decode().split("|")
        return uid if int(exp) > time.time() and uid in USERS else None
    except Exception:
        return None


# anti force brute : 8 essais ratés par adresse IP sur 15 min
_FAILS = {}


def blocked(ip):
    now = time.time()
    _FAILS[ip] = [t for t in _FAILS.get(ip, []) if now - t < 900]
    return len(_FAILS[ip]) >= 8


def failed(ip):
    _FAILS.setdefault(ip, []).append(time.time())


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "ajouter":
        uid = sys.argv[2].strip().lower()
        p1 = getpass.getpass(f"Mot de passe pour {uid} (rien ne s'affiche, c'est normal) : ")
        p2 = getpass.getpass("Encore une fois : ")
        if p1 != p2 or len(p1) < 8:
            sys.exit("Mots de passe différents ou trop courts (8 caractères minimum).")
        print("\nLigne à ajouter (dans le secret USERS sur Hugging Face, ou dans utilisateurs.txt en local) :\n")
        print(f"{uid}:{hash_password(p1)}")
    else:
        print(__doc__)
