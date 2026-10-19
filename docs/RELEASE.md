# Publier une version

Le code est dans ce dépôt ; les binaires sont publiés dans le dépôt séparé
[`osteo-manager-releases`](https://github.com/timothee-faget/osteo-manager-releases),
que l'app interroge pour ses mises à jour (`latest.json`).

## Publier

1. Mettre le même numéro de version dans `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` et `package.json` (la CI vérifie `tauri.conf.json`).
2. Merger sur `main`, puis :
   ```sh
   git tag v0.2.0 && git push origin v0.2.0
   ```
3. Le workflow `Release` (macOS, binaire universel Apple Silicon + Intel) publie le `.dmg`, l'archive de mise à jour signée et `latest.json`. Compter ~15 min.

Une fois publiée, une version est « latest » immédiatement : toutes les installations la proposeront au prochain lancement.

## Mise en place (une fois)

- **Clé de signature des mises à jour** (sans lien avec Apple) :
  ```sh
  npx tauri signer generate -w ~/.tauri/osteo-manager.key
  ```
  La clé publique (`~/.tauri/osteo-manager.key.pub`) va dans `plugins.updater.pubkey` de `tauri.conf.json`. **Garder la clé privée et son mot de passe en lieu sûr** (gestionnaire de mots de passe) : si elle est perdue, les installations existantes ne pourront plus se mettre à jour et il faudra réinstaller à la main.
- **Dépôt public** `osteo-manager-releases`, avec `docs/INSTALL.md` comme README.
- **Secrets** de ce dépôt (Settings → Secrets and variables → Actions) :
  - `TAURI_SIGNING_PRIVATE_KEY` : contenu de `~/.tauri/osteo-manager.key`
  - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` : son mot de passe
  - `RELEASES_TOKEN` : token GitHub _fine-grained_, limité au dépôt `osteo-manager-releases`, permission **Contents : Read and write**
