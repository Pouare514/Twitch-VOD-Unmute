# Twitch VOD Unmute

Restaure automatiquement l'audio des passages coupés (« muted ») des rediffusions (VODs) Twitch, directement dans le lecteur. 100 % local : rien ne quitte le navigateur.

Quand Twitch coupe un passage pour raisons de droits d'auteur, il remplace les segments audio d'origine par des versions muettes (`42-muted.ts`) — mais les fichiers d'origine restent un moment sur le CDN. L'extension les réinjecte à la volée : la vidéo se regarde avec le son, sans rien télécharger.

## Fonctionnalités

- **Restauration automatique** : les passages récupérables rejouent leur audio d'origine, sans action.
- **Marqueurs sur la barre de lecture** : fine bande verte (récupéré) / rouge (toujours muet), sans gêner le lecteur.
- **Bouton natif à côté de « Share »** (`🔊 90/90`) : ouvre le panneau (état, progression, interrupteur).
- **Sauvegarde `.ts` locale** : chaque plage récupérée se télécharge en un fichier lisible dans VLC.

## Installation (Chrome / Edge / Brave)

**Le plus simple :** télécharge `twitch-vod-unmute-X.Y.Z.zip` depuis la page
[Releases](../../releases), décompresse-le, puis points 2–3 ci-dessous.

1. Télécharge ou clone ce dépôt (ou le zip d'une release).
2. Ouvre `chrome://extensions`, active le **Mode développeur**.
3. **Charger l'extension non empaquetée** → sélectionne ce dossier (`manifest.json`).
4. Ouvre une VOD : `https://www.twitch.tv/videos/<id>`.

Aucune dépendance, aucun build, aucune clé à configurer.

## Utilisation

1. Lis quelques secondes : la carte des plages se construit (pastille `🔊 X/Y`).
2. Les segments verts de la barre de lecture ont retrouvé leur son ; les rouges sont définitivement purgés du CDN.
3. Clic sur la pastille → panneau : état, progression, interrupteur, téléchargements `.ts` par plage.
4. Clic sur un horaire → saut direct au passage.

## Comment ça marche

- Le lecteur Twitch charge le HLS dans un **Dedicated Worker** (Amazon IVS, blob:). L'extension sous-classe `window.Worker` : XHR synchrone du source, préfixe `importScripts(worker-patch.js)`, nouveau Blob. Repli natif si refus.
- **Master SAFE** : si la playlist contient `#EXT-X-STREAM-INF`, on ne touche à rien (la variante non-mutée n'existe pas → `403`).
- **Patch média synchrone** : `*-muted.ts` → `*.ts`, jamais les `.m3u8`. Zéro attente réseau.
- **Filet anti-freeze** : si un segment restauré répond `403/404` (purgé), la version muette est rejouée à la volée — le lecteur ne plante jamais.

## Confidentialité

Tout se passe dans le navigateur : interception, carte des plages, téléchargements. Aucune donnée n'est envoyée quelque part. Aucun compte, aucun serveur.

## Limites connues

- Le CDN purge les originaux en ~6–48 h : passé ce délai, la restauration est impossible (le passage reste muet, c'est normal).
- Si le streamer a exclu la musique de la VOD dans OBS, même l'original est muet.

## Développement

```
manifest.json          Manifeste MV3 (content-scripts MAIN + isolé, service worker)
src/injected.js        Hook page : Worker IVS, timeline, panneau natif, téléchargements
src/worker-patch.js    Patch HLS dans le worker IVS + carte des plages
src/bridge.js          Relais monde isolé : config, stockage persistant
src/background.js      Service worker : réinjection des scripts au besoin
icons/                 Icônes de l'extension
```

Vérifications sans build : `node --check src/*.js` + `python3 -c "import json; json.load(open('manifest.json'))"`.

## Licence

MIT — voir `LICENSE`.
