#!/usr/bin/env python3
"""Serveur de la Matrice d'Eisenhower.

Sert les fichiers statiques du site ET expose une petite API de
synchronisation (`/api/state`) permettant de partager les tâches entre
plusieurs appareils. Aucune dépendance : uniquement la bibliothèque
standard de Python 3.

Variables d'environnement :
  PORT              port d'écoute            (défaut : 8000)
  BIND              adresse d'écoute         (défaut : 127.0.0.1)
  EISENHOWER_DATA   dossier de stockage      (défaut : ./data)

  --- Import Google Agenda -> tâches (optionnel, activé si GCAL_ICS_URL) ---
  GCAL_ICS_URL          adresse secrète iCal d'un agenda Google à importer
  GCAL_IMPORT_QUADRANT  quadrant des tâches importées (q1-q4, défaut : q2)
  GCAL_IMPORT_DAYS      fenêtre en jours vers le futur (défaut : 30)
  GCAL_POLL_MIN         intervalle de lecture en minutes (défaut : 30)

  --- Rappels par e-mail (optionnels, activés si SMTP_HOST et REMINDER_TO) ---
  SMTP_HOST         serveur SMTP (ex : smtp.gmail.com)
  SMTP_PORT         port SMTP                (défaut : 587)
  SMTP_USER         identifiant SMTP
  SMTP_PASS         mot de passe / mot de passe d'application
  SMTP_SSL          "1" pour SSL direct (port 465) au lieu de STARTTLS
  SMTP_STARTTLS     "1" pour STARTTLS         (défaut : 1)
  REMINDER_TO       destinataire des rappels (active la fonction)
  REMINDER_FROM     expéditeur               (défaut : SMTP_USER)
  REMINDER_HOUR     heure d'envoi 0-23       (défaut : 8)
  SITE_URL          lien inclus dans l'e-mail (optionnel)

Test manuel :
  python3 server.py --send-reminder-now            # envoie tout de suite
  python3 server.py --send-reminder-now --dry-run  # affiche sans envoyer
"""

import json
import os
import secrets
import smtplib
import sys
import threading
import time
import urllib.request
from datetime import date, timedelta
from email.message import EmailMessage
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("EISENHOWER_DATA", os.path.join(ROOT, "data"))
DATA_FILE = os.path.join(DATA_DIR, "state.json")
BACKUP_DIR = os.path.join(DATA_DIR, "backups")
BACKUP_KEEP = int(os.environ.get("BACKUP_KEEP", "14"))  # jours de rétention
MAX_BODY = 4 * 1024 * 1024  # 4 Mo : taille max d'une requête API
MAX_TASKS = 10000  # garde-fou
PORT = int(os.environ.get("PORT", "8000"))
BIND = os.environ.get("BIND", "127.0.0.1")

# Chemins jamais servis en statique (données, code, dépôt git…).
BLOCKED = ("/data", "/.git", "/server.py")

_lock = threading.Lock()


def load_state():
    try:
        with open(DATA_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict) and isinstance(data.get("tasks"), list):
            data.setdefault("version", 0)
            data.setdefault("updatedAt", 0)
            return data
    except (FileNotFoundError, ValueError):
        pass
    return {"tasks": [], "version": 0, "updatedAt": 0}


def save_state(state):
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = DATA_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, DATA_FILE)  # remplacement atomique


def maybe_backup(state):
    """Écrit une sauvegarde datée (une par jour) et purge les anciennes."""
    try:
        os.makedirs(BACKUP_DIR, exist_ok=True)
        path = os.path.join(BACKUP_DIR, "state-{}.json".format(date.today().isoformat()))
        if not os.path.exists(path):
            with open(path, "w", encoding="utf-8") as f:
                json.dump(state, f, ensure_ascii=False, separators=(",", ":"))
            snaps = sorted(
                fn
                for fn in os.listdir(BACKUP_DIR)
                if fn.startswith("state-") and fn.endswith(".json")
            )
            for fn in snaps[: max(0, len(snaps) - BACKUP_KEEP)]:
                try:
                    os.remove(os.path.join(BACKUP_DIR, fn))
                except OSError:
                    pass
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Rappels par e-mail (planificateur quotidien, bibliothèque standard).
# ---------------------------------------------------------------------------
LAST_SENT_FILE = os.path.join(DATA_DIR, "last_reminder")


def load_reminder_config():
    host = os.environ.get("SMTP_HOST", "").strip()
    to = os.environ.get("REMINDER_TO", "").strip()
    user = os.environ.get("SMTP_USER", "").strip()
    try:
        hour = int(os.environ.get("REMINDER_HOUR", "8"))
    except ValueError:
        hour = 8
    return {
        "enabled": bool(host and to),
        "host": host,
        "port": int(os.environ.get("SMTP_PORT", "587") or "587"),
        "user": user,
        "password": os.environ.get("SMTP_PASS", ""),
        "from": os.environ.get("REMINDER_FROM", user).strip() or user,
        "to": to,
        "ssl": os.environ.get("SMTP_SSL", "").lower() in ("1", "true", "yes"),
        "starttls": os.environ.get("SMTP_STARTTLS", "1").lower() in ("1", "true", "yes"),
        "hour": max(0, min(23, hour)),
        "url": os.environ.get("SITE_URL", "").strip(),
    }


REMINDER = load_reminder_config()


def upcoming_tasks(state):
    """Retourne (en_retard, aujourd'hui, demain) : listes de (date, texte)."""
    today = date.today().isoformat()
    tomorrow = (date.today() + timedelta(days=1)).isoformat()
    overdue, due_today, due_tomorrow = [], [], []
    for t in state.get("tasks", []):
        if not isinstance(t, dict) or t.get("done"):
            continue
        dd = t.get("dueDate")
        if not isinstance(dd, str) or not dd:
            continue
        item = (dd, str(t.get("text", "")).strip() or "(sans titre)")
        if dd < today:
            overdue.append(item)
        elif dd == today:
            due_today.append(item)
        elif dd == tomorrow:
            due_tomorrow.append(item)
    return overdue, due_today, due_tomorrow


def format_reminder(overdue, due_today, due_tomorrow):
    n = len(overdue) + len(due_today) + len(due_tomorrow)
    subject = "🗂️ Eisenhower — {} tâche(s) à suivre".format(n)
    lines = ["Bonjour,", "", "Tes tâches à échéance :", ""]

    def section(title, items):
        if not items:
            return
        lines.append(title)
        for dd, text in sorted(items):
            lines.append("  • {}  ({})".format(text, dd))
        lines.append("")

    section("⚠️  En retard :", overdue)
    section("📅  Aujourd'hui :", due_today)
    section("🔜  Demain :", due_tomorrow)
    if REMINDER["url"]:
        lines.append("— " + REMINDER["url"])
    return subject, "\n".join(lines)


def send_email(subject, body):
    cfg = REMINDER
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = cfg["from"]
    msg["To"] = cfg["to"]
    msg.set_content(body)
    if cfg["ssl"]:
        server = smtplib.SMTP_SSL(cfg["host"], cfg["port"], timeout=30)
    else:
        server = smtplib.SMTP(cfg["host"], cfg["port"], timeout=30)
    try:
        server.ehlo()
        if not cfg["ssl"] and cfg["starttls"]:
            server.starttls()
            server.ehlo()
        if cfg["user"]:
            server.login(cfg["user"], cfg["password"])
        server.send_message(msg)
    finally:
        try:
            server.quit()
        except Exception:
            pass


def run_reminder(dry=False):
    with _lock:
        state = load_state()
    overdue, due_today, due_tomorrow = upcoming_tasks(state)
    if not (overdue or due_today or due_tomorrow):
        print("[rappel] rien à signaler aujourd'hui")
        return True
    subject, body = format_reminder(overdue, due_today, due_tomorrow)
    if dry:
        print("[rappel] (dry-run)\nSujet : {}\n\n{}".format(subject, body))
        return True
    try:
        send_email(subject, body)
        print("[rappel] e-mail envoyé à {}".format(REMINDER["to"]))
        return True
    except Exception as exc:  # noqa: BLE001 — on ne veut jamais planter le serveur
        print("[rappel] ERREUR d'envoi : {}".format(exc))
        return False


def _last_sent_day():
    try:
        with open(LAST_SENT_FILE, "r", encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return ""


def _mark_sent(day):
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(LAST_SENT_FILE, "w", encoding="utf-8") as f:
            f.write(day)
    except OSError:
        pass


def reminder_loop():
    """Une fois par jour, à l'heure configurée, envoie le récapitulatif."""
    while True:
        try:
            today = date.today().isoformat()
            if time.localtime().tm_hour == REMINDER["hour"] and _last_sent_day() != today:
                run_reminder()
                _mark_sent(today)  # au plus une tentative par jour
        except Exception as exc:  # noqa: BLE001
            print("[rappel] boucle : {}".format(exc))
        time.sleep(60)


# ---------------------------------------------------------------------------
# Import Google Agenda -> tâches (lecture d'une adresse iCal secrète).
# Sans OAuth : on lit le flux .ics et on réconcilie des tâches « gcal: ».
# ---------------------------------------------------------------------------
def load_gcal_config():
    url = os.environ.get("GCAL_ICS_URL", "").strip()
    quad = os.environ.get("GCAL_IMPORT_QUADRANT", "q2").strip()
    if quad not in ("q1", "q2", "q3", "q4"):
        quad = "q2"
    try:
        days = int(os.environ.get("GCAL_IMPORT_DAYS", "30"))
    except ValueError:
        days = 30
    try:
        poll = int(os.environ.get("GCAL_POLL_MIN", "30"))
    except ValueError:
        poll = 30
    return {
        "enabled": bool(url),
        "url": url,
        "quadrant": quad,
        "days": max(1, days),
        "poll_min": max(5, poll),
    }


GCAL = load_gcal_config()


def _ics_unescape(s):
    return (
        s.replace("\\n", "\n").replace("\\,", ",").replace("\\;", ";").replace("\\\\", "\\")
    )


def fetch_ics(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Eisenhower/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:  # noqa: S310 (URL fournie par l'admin)
        return r.read().decode("utf-8", "replace")


def parse_ics(text):
    """Extrait les VEVENT : liste de {uid, summary, date 'YYYY-MM-DD'}."""
    raw = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    lines = []
    for ln in raw:  # dépliage RFC 5545 (lignes de continuation)
        if ln[:1] in (" ", "\t") and lines:
            lines[-1] += ln[1:]
        else:
            lines.append(ln)
    events, cur = [], None
    for ln in lines:
        if ln == "BEGIN:VEVENT":
            cur = {}
        elif ln == "END:VEVENT":
            if cur and cur.get("uid") and cur.get("date"):
                cur.setdefault("summary", "(sans titre)")
                events.append(cur)
            cur = None
        elif cur is not None and ":" in ln:
            key, val = ln.split(":", 1)
            name = key.split(";", 1)[0].upper()
            if name == "UID":
                cur["uid"] = val.strip()
            elif name == "SUMMARY":
                cur["summary"] = _ics_unescape(val).strip() or "(sans titre)"
            elif name == "DTSTART":
                dpart = val.strip()[:8]
                if len(dpart) == 8 and dpart.isdigit():
                    cur["date"] = "{}-{}-{}".format(dpart[0:4], dpart[4:6], dpart[6:8])
    return events


def sync_gcal(verbose=False):
    if not GCAL["enabled"]:
        if verbose:
            print("[agenda] import désactivé (définir GCAL_ICS_URL)")
        return False
    try:
        events = parse_ics(fetch_ics(GCAL["url"]))
    except Exception as exc:  # noqa: BLE001
        print("[agenda] import : échec de lecture : {}".format(exc))
        return False

    today = date.today()
    lo, hi = today - timedelta(days=1), today + timedelta(days=GCAL["days"])
    desired = {}
    for ev in events:
        # Garde-fou anti-boucle : ne jamais réimporter nos propres événements
        # (au cas où l'URL pointerait par erreur sur le flux Eisenhower).
        if ev["uid"].endswith("@eisenhower"):
            continue
        try:
            y, m, d = ev["date"].split("-")
            dd = date(int(y), int(m), int(d))
        except (ValueError, KeyError):
            continue
        if lo <= dd <= hi:
            desired["gcal:" + ev["uid"]] = ev

    with _lock:
        state = load_state()
        tasks = state["tasks"]
        changed = False
        kept = []
        for t in tasks:
            tid = t.get("id") if isinstance(t, dict) else None
            if tid and str(tid).startswith("gcal:") and tid not in desired:
                changed = True  # événement disparu de la fenêtre -> on retire
                continue
            kept.append(t)
        existing = {t.get("id"): t for t in kept if isinstance(t, dict)}
        for gid, ev in desired.items():
            if gid in existing:
                t = existing[gid]
                if t.get("text") != ev["summary"] or t.get("dueDate") != ev["date"]:
                    t["text"] = ev["summary"]
                    t["dueDate"] = ev["date"]
                    changed = True
            else:
                kept.append({
                    "id": gid,
                    "text": ev["summary"],
                    "quadrant": GCAL["quadrant"],
                    "done": False,
                    "createdAt": int(time.time() * 1000),
                    "dueDate": ev["date"],
                    "repeat": "none",
                    "tags": ["agenda"],
                    "subtasks": [],
                })
                changed = True
        if changed:
            state["tasks"] = kept
            state["version"] = state.get("version", 0) + 1
            state["updatedAt"] = int(time.time() * 1000)
            save_state(state)
            maybe_backup(state)
            print("[agenda] import : {} événement(s), état mis à jour".format(len(desired)))
        elif verbose:
            print("[agenda] import : {} événement(s), rien à changer".format(len(desired)))
    return True


def gcal_loop():
    time.sleep(5)
    while True:
        try:
            sync_gcal()
        except Exception as exc:  # noqa: BLE001
            print("[agenda] import boucle : {}".format(exc))
        time.sleep(GCAL["poll_min"] * 60)


# ---------------------------------------------------------------------------
# Flux ICS (Google Agenda & autres) — tâches datées, protégé par un jeton.
# ---------------------------------------------------------------------------
ICS_TOKEN_FILE = os.path.join(DATA_DIR, "ics_token")
QUAD_EMOJI = {"q1": "🔥", "q2": "📅", "q3": "🤝", "q4": "🗑️"}
QUAD_NAME = {"q1": "Faire", "q2": "Planifier", "q3": "Déléguer", "q4": "Éliminer"}


def get_ics_token():
    try:
        with open(ICS_TOKEN_FILE, "r", encoding="utf-8") as f:
            tok = f.read().strip()
            if tok:
                return tok
    except OSError:
        pass
    tok = secrets.token_hex(16)
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(ICS_TOKEN_FILE, "w", encoding="utf-8") as f:
            f.write(tok)
        os.chmod(ICS_TOKEN_FILE, 0o600)
    except OSError:
        pass
    return tok


ICS_TOKEN = get_ics_token()


def _ics_escape(s):
    return (
        str(s)
        .replace("\\", "\\\\")
        .replace(";", "\\;")
        .replace(",", "\\,")
        .replace("\n", "\\n")
    )


def build_ics(state):
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Eisenhower//Matrice//FR",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        "X-WR-CALNAME:Matrice d'Eisenhower",
    ]
    for t in state.get("tasks", []):
        if not isinstance(t, dict):
            continue
        dd = t.get("dueDate")
        if not isinstance(dd, str) or dd.count("-") != 2:
            continue
        y, m, d = dd.split("-")
        try:
            end = (date(int(y), int(m), int(d)) + timedelta(days=1)).strftime("%Y%m%d")
        except ValueError:
            continue
        q = t.get("quadrant", "q1")
        summary = "{} {}".format(QUAD_EMOJI.get(q, ""), str(t.get("text", "")).strip())
        if t.get("done"):
            summary = "✔ " + summary
        parts = [QUAD_NAME.get(q, "")]
        tags = t.get("tags") or []
        if tags:
            parts.append("Étiquettes : " + ", ".join("#" + str(x) for x in tags))
        subs = t.get("subtasks") or []
        if subs:
            done = sum(1 for s in subs if s.get("done"))
            parts.append("Sous-tâches : {}/{}".format(done, len(subs)))
            for s in subs:
                parts.append(("[x] " if s.get("done") else "[ ] ") + str(s.get("text", "")))
        desc = "\\n".join(_ics_escape(p) for p in parts if p)
        lines += [
            "BEGIN:VEVENT",
            "UID:{}@eisenhower".format(t.get("id", "x")),
            "DTSTAMP:" + stamp,
            "DTSTART;VALUE=DATE:{}{}{}".format(y, m, d),
            "DTEND;VALUE=DATE:" + end,
            "SUMMARY:" + _ics_escape(summary),
        ]
        if desc:
            lines.append("DESCRIPTION:" + desc)
        lines.append("CATEGORIES:" + _ics_escape(QUAD_NAME.get(q, "")))
        lines.append("END:VEVENT")
    lines.append("END:VCALENDAR")
    return ("\r\n".join(lines) + "\r\n").encode("utf-8")


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    # -- utilitaires ---------------------------------------------------
    def _send_json(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _is_blocked(self, path):
        clean = path.split("?")[0].split("#")[0]
        return any(clean == p or clean.startswith(p + "/") for p in BLOCKED)

    # -- routes --------------------------------------------------------
    def _serve_ics(self):
        if self.path.split("?")[0] != "/calendar/{}.ics".format(ICS_TOKEN):
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        with _lock:
            body = build_ics(load_state())
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/calendar; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_GET(self):
        clean = self.path.split("?")[0]
        if clean.startswith("/calendar/"):
            self._serve_ics()
            return
        if clean == "/api/state":
            with _lock:
                self._send_json(HTTPStatus.OK, load_state())
            return
        if self._is_blocked(self.path):
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        super().do_GET()

    def do_HEAD(self):
        if self.path.split("?")[0].startswith("/calendar/"):
            self._serve_ics()
            return
        if self._is_blocked(self.path):
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        super().do_HEAD()

    def do_PUT(self):
        if self.path.split("?")[0] != "/api/state":
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length > MAX_BODY:
            self._send_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "payload too large"})
            return
        raw = self.rfile.read(length) if length else b"{}"
        try:
            incoming = json.loads(raw.decode("utf-8"))
            tasks = incoming["tasks"]
            if not isinstance(tasks, list):
                raise ValueError("tasks must be a list")
        except (ValueError, KeyError, UnicodeDecodeError):
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid payload"})
            return
        if len(tasks) > MAX_TASKS:
            self._send_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "too many tasks"})
            return

        with _lock:
            current = load_state()
            base = incoming.get("baseVersion")
            # Concurrence optimiste : si un autre appareil a écrit entre
            # temps, on refuse et on renvoie l'état courant (409).
            if base is not None and base != current["version"]:
                self._send_json(HTTPStatus.CONFLICT, current)
                return
            new_state = {
                "tasks": tasks,
                "version": current["version"] + 1,
                "updatedAt": int(time.time() * 1000),
            }
            save_state(new_state)
            maybe_backup(new_state)
            self._send_json(HTTPStatus.OK, new_state)

    def log_message(self, *args):
        pass  # serveur silencieux


class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    os.makedirs(DATA_DIR, exist_ok=True)

    # Mode test : envoie (ou simule) un rappel puis quitte.
    if "--send-reminder-now" in sys.argv:
        ok = run_reminder(dry="--dry-run" in sys.argv)
        sys.exit(0 if ok else 1)

    # Mode test : synchronise l'agenda maintenant puis quitte.
    if "--sync-gcal-now" in sys.argv:
        ok = sync_gcal(verbose=True)
        sys.exit(0 if ok else 1)

    if GCAL["enabled"]:
        threading.Thread(target=gcal_loop, daemon=True).start()
        print(
            "[agenda] import activé — lecture toutes les {} min, vers le quadrant {}".format(
                GCAL["poll_min"], GCAL["quadrant"]
            )
        )
    else:
        print("[agenda] import désactivé (définir GCAL_ICS_URL pour l'activer)")

    if REMINDER["enabled"]:
        threading.Thread(target=reminder_loop, daemon=True).start()
        print(
            "[rappel] activé — envoi quotidien vers {} à {}h".format(
                REMINDER["to"], REMINDER["hour"]
            )
        )
    else:
        print("[rappel] désactivé (définir SMTP_HOST et REMINDER_TO pour l'activer)")

    ics_base = REMINDER["url"] or "http://{}:{}".format(BIND, PORT)
    print("[agenda] flux ICS : {}/calendar/{}.ics".format(ics_base, ICS_TOKEN))

    with ThreadingHTTPServer((BIND, PORT), Handler) as httpd:
        print(f"Matrice d'Eisenhower : http://{BIND}:{PORT}  (données : {DATA_FILE})")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nArrêt.")


if __name__ == "__main__":
    main()
