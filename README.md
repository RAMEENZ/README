# Matrice d'Eisenhower — Organiseur de tâches

Une application web autonome pour organiser ses tâches selon la **matrice d'Eisenhower**, qui classe le travail selon deux axes : l'**urgence** et l'**importance**.

## Les quatre quadrants

|                    | Urgent               | Pas urgent                  |
| ------------------ | -------------------- | --------------------------- |
| **Important**      | **Faire** maintenant | **Planifier**               |
| **Pas important**  | **Déléguer**         | **Éliminer**                |

## Fonctionnalités

- Ajout de tâches dans le quadrant de votre choix.
- **Glisser-déposer** des tâches d'un quadrant à l'autre (souris et tactile).
- Modification du texte d'une tâche directement en cliquant dessus.
- Marquage des tâches comme terminées, puis nettoyage en un clic.
- **Sauvegarde automatique** dans le navigateur (localStorage) — vos tâches sont conservées d'une session à l'autre, sans compte ni serveur.
- Synchronisation entre onglets ouverts.
- Thème clair / sombre automatique selon les préférences du système.
- Interface responsive (bureau et mobile).

## Utilisation

Aucune installation ni dépendance. Ouvrez simplement `index.html` dans un navigateur :

```bash
# Ouverture directe
open index.html          # macOS
xdg-open index.html      # Linux

# Ou via un petit serveur local
python3 -m http.server 8000
# puis rendez-vous sur http://localhost:8000
```

## Structure du projet

- `index.html` — structure de la page.
- `style.css` — mise en forme, couleurs des quadrants, thème clair/sombre, responsive.
- `app.js` — logique de l'application (gestion des tâches, glisser-déposer, persistance).

Toutes les données restent sur votre appareil ; rien n'est envoyé sur un réseau.
