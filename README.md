# Matrice d'Eisenhower — Organiseur de tâches

Une application web pour organiser ses tâches selon la **matrice d'Eisenhower**, qui classe le travail selon deux axes : l'**urgence** et l'**importance**.

## Les quatre quadrants

|                    | Urgent               | Pas urgent                  |
| ------------------ | -------------------- | --------------------------- |
| **Important**      | **Faire** maintenant | **Planifier**               |
| **Pas important**  | **Déléguer**         | **Éliminer**                |

## Fonctionnalités

- Ajout de tâches dans le quadrant de votre choix, avec **date d'échéance** optionnelle.
- **Glisser-déposer** : déplacer une tâche d'un quadrant à l'autre **et réordonner** au sein d'un quadrant (souris et tactile).
- Édition du texte en cliquant dessus, marquage « terminé », **annulation** de suppression.
- **Surlignage des tâches en retard** (échéance dépassée).
- **Recherche** et **tri** (manuel, par échéance, par date d'ajout, A→Z).
- **Thème** clair / sombre / automatique (bouton dédié).
- **Export / import** des tâches au format JSON.
- **Application installable (PWA)** : icône sur l'écran d'accueil, fonctionnement hors-ligne.
- **Synchronisation multi-appareils** via un petit backend (voir ci-dessous). Sans backend, l'appli fonctionne quand même en local (localStorage).

## Utilisation

### Mode simple (local, sans synchronisation)

Aucune dépendance. Ouvrez `index.html`, ou servez le dossier :

```bash
python3 -m http.server 8000   # puis http://localhost:8000
```

Les tâches sont conservées dans le navigateur (localStorage).

### Mode synchronisé (multi-appareils)

Lancez le backend fourni (bibliothèque standard de Python uniquement) : il sert
le site **et** expose une API `/api/state` qui partage les tâches entre tous vos
appareils.

```bash
python3 server.py     # écoute sur 127.0.0.1:8000 par défaut
```

Variables d'environnement : `PORT` (défaut 8000), `BIND` (défaut 127.0.0.1),
`EISENHOWER_DATA` (dossier de stockage, défaut `./data`).

Les tâches sont stockées côté serveur dans `data/state.json` (écriture atomique,
gestion de concurrence par numéro de version).

## Structure du projet

- `index.html` — structure de la page.
- `style.css` — mise en forme, couleurs des quadrants, thèmes, responsive.
- `app.js` — logique (tâches, échéances, glisser-déposer, recherche/tri, thème, synchro, PWA).
- `server.py` — backend statique + API de synchronisation (stdlib Python, sans dépendance).
- `manifest.webmanifest`, `sw.js`, `icon*.png`, `icon.svg` — fichiers de la PWA.

## Confidentialité

En mode local, rien ne quitte l'appareil. En mode synchronisé, les tâches
transitent vers votre propre serveur. L'API n'a pas d'authentification
intégrée : si le site est exposé publiquement, protégez-le (par exemple avec
Cloudflare Access) ou gardez-le sur un réseau privé.
