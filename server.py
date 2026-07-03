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
import smtplib
import sys
import threading
import time
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
    def do_GET(self):
        if self.path.split("?")[0] == "/api/state":
            with _lock:
                self._send_json(HTTPStatus.OK, load_state())
            return
        if self._is_blocked(self.path):
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        super().do_GET()

    def do_HEAD(self):
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

    if REMINDER["enabled"]:
        threading.Thread(target=reminder_loop, daemon=True).start()
        print(
            "[rappel] activé — envoi quotidien vers {} à {}h".format(
                REMINDER["to"], REMINDER["hour"]
            )
        )
    else:
        print("[rappel] désactivé (définir SMTP_HOST et REMINDER_TO pour l'activer)")

    with ThreadingHTTPServer((BIND, PORT), Handler) as httpd:
        print(f"Matrice d'Eisenhower : http://{BIND}:{PORT}  (données : {DATA_FILE})")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nArrêt.")


if __name__ == "__main__":
    main()
