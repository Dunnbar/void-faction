# Sons FX de combat

Dépose ici tes fichiers son (`.ogg` ou `.mp3`), puis renseigne leur chemin dans
le **MANIFEST** de `public/js/sfx.js` (champ `src` de chaque entrée).

Tant qu'un `src` est vide (`''`), le son est **désactivé** (aucune erreur, aucun 404).

## Sons attendus (clés du MANIFEST)

| clé           | usage                          | durée idéale | exemple de chemin |
|---------------|--------------------------------|--------------|-------------------|
| `shot-ship`   | tir du vaisseau (Amiral)       | ~100-250 ms  | `/assets/sounds/fx/shot_ship.ogg` |
| `shot-turret` | tir d'une tourelle             | ~100-250 ms  | `/assets/sounds/fx/shot_turret.ogg` |
| `shot-enemy`  | tir d'un ennemi                | ~100-250 ms  | `/assets/sounds/fx/shot_enemy.ogg` |
| `impact`      | impact d'un projectile         | ~120-200 ms  | `/assets/sounds/fx/impact.ogg` |
| `explosion`   | destruction (ennemi/tourelle)  | ~400-700 ms  | `/assets/sounds/fx/explosion.ogg` |
| `ambience`    | nappe de bataille (vue dézoomée) | boucle ~3-8 s (boucle propre) | `/assets/sounds/fx/ambience_combat.ogg` |

## Réglages (dans sfx.js)

- `volume`, `throttleMs` (délai mini entre 2 lectures), `maxVoices` (voix simultanées max),
  `pitch` (variation aléatoire) : par son, dans le MANIFEST.
- `ZOOM_OUT_THRESHOLD` / `FAR_SHOT_PROBABILITY` : seuil de bascule "dézoom" et proportion
  de tirs individuels gardés en vue large (le reste = ambiance).

Le système ne joue jamais tout : cap de voix + throttle + cull hors-écran, et en dézoom
il bascule sur l'ambiance + quelques tirs aléatoires.
