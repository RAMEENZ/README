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
"""

import json
import os
import threading
import time
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("EISENHOWER_DATA", os.path.join(ROOT, "data"))
DATA_FILE = os.path.join(DATA_DIR, "state.json")
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
        raw = self.rfile.read(length) if length else b"{}"
        try:
            incoming = json.loads(raw.decode("utf-8"))
            tasks = incoming["tasks"]
            if not isinstance(tasks, list):
                raise ValueError("tasks must be a list")
        except (ValueError, KeyError, UnicodeDecodeError):
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid payload"})
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
            self._send_json(HTTPStatus.OK, new_state)

    def log_message(self, *args):
        pass  # serveur silencieux


class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    os.makedirs(DATA_DIR, exist_ok=True)
    with ThreadingHTTPServer((BIND, PORT), Handler) as httpd:
        print(f"Matrice d'Eisenhower : http://{BIND}:{PORT}  (données : {DATA_FILE})")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nArrêt.")


if __name__ == "__main__":
    main()
