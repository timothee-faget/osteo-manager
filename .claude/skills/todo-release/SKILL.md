---
name: todo-release
description: Traite les nouvelles tâches de la liste « À faire » de la note Obsidian du projet, de bout en bout - questions, issues GitHub, une PR par issue, merge, puis release de l'app et mise à jour de la note. À utiliser quand l'utilisateur tape /todo-release, demande de « traiter la todo », de « regarder s'il y a de nouvelles tâches dans la note » ou de « tout faire jusqu'à la release ».
---

# /todo-release

Enchaîne : note du vault → questions → issues → une PR par issue → merge → release → note à jour.
Il y a **un seul point d'arrêt** : la validation du plan (étape 3). Une fois le « go » donné, enchaîner jusqu'au bout sans redemander, y compris les merges. C'est une exception voulue à la règle « demander avant de merger », valable uniquement pendant un run de cette skill.

Les règles de `CLAUDE.md` restent prioritaires (données de santé, factures immuables, centimes, migrations).

## Repères

- Note : `~/Documents/Tim's Vault/20-29 Mes Loisirs/21 Développement/21.34 Osteo Manager.md`
- Dépôt `timothee-faget/osteo-manager`, releases publiques `timothee-faget/osteo-manager-releases`
- Board : projet n° 1 de `timothee-faget`, id `PVT_kwHOBlWjns4BnY6J`, champ Status `PVTSSF_lAHOBlWjns4BnY6Jzhl9xGk`, options Todo `f75ad846`, In Progress `47fc9ee4`, Done `98236657`

Changer le statut d'une issue sur le board, en deux commandes séparées (pas de `$(…)` ni de variable : un run non interactif n'autorise que les commandes qui commencent par `gh`) :

```sh
gh project item-list 1 --owner timothee-faget --format json --limit 300 --jq '.items[] | select(.content.number==<n>) | .id'
gh project item-edit --project-id PVT_kwHOBlWjns4BnY6J --id <id lu ci-dessus> --field-id PVTSSF_lAHOBlWjns4BnY6Jzhl9xGk --single-select-option-id <option>
```

## 1. Lire la note

Dans la section `### À faire`, retenir les cases `- [ ]` (avec leurs sous-puces) qui n'ont pas encore de référence `(#n)`. Ignorer les autres sections.
Croiser avec `gh issue list --state open` pour ne pas recréer une issue existante.
Rien de nouveau → le dire en une phrase et s'arrêter.

## 2. Comprendre

Pour chaque tâche, lire le code concerné, `docs/SPEC.md` et `docs/DESIGN.md` si c'est de l'interface. Estimer ce qu'il faut toucher (front seul, commande Rust, migration).

Poser les questions **en une seule fois** (AskUserQuestion), seulement quand :

- la tâche admet plusieurs lectures qui changent le résultat ;
- elle touche une règle non négociable ou une décision déjà prise (mémoire `project-status`, section « Décisions prises » de la note) ;
- elle demande une migration de données existantes.

Ne pas redemander ce qui est déjà tranché.

## 3. Plan à valider (seul arrêt)

Présenter, en français :

- les issues prévues : titre en anglais, `feat` ou `fix`, label existant (`patients`, `billing`, `accounting`, `email`, `infra`, `bug`…), et les lignes de la note couvertes par chacune (regrouper les petites tâches liées, comme #108–#115) ;
- l'ordre de traitement ;
- la version prévue : au moins une `feat` → mineure (`0.10.0` → `0.11.0`), sinon patch (`0.10.1`) ;
- les migrations éventuelles.

Attendre le « go ». Ajuster si l'utilisateur corrige.

## 4. Créer les issues

- `gh issue create --label <label> --title ... --body ...` : contexte puis critères d'acceptation, en anglais.
- `gh project item-add 1 --owner timothee-faget --url <url>`, statut Todo.
- Dans la note, suffixer chaque ligne couverte de ` (#n)`. Ne rien réécrire d'autre.

## 5. Traiter chaque issue

Pour chaque issue, dans l'ordre :

1. `git switch main && git pull`, puis `git switch -c feat/<n>-slug` (ou `fix/`). Statut In Progress.
2. Tests d'abord pour la logique métier (Rust ou Vitest), puis l'implémentation. Schéma modifié → nouvelle migration dans `src-tauri/src/db.rs`. Interface → règles de `docs/DESIGN.md`. Garder `src/test/fakeBackend.ts` à jour si une commande change.
3. Vérifier en local :
   ```sh
   npm run lint && npm run typecheck && npm test
   cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
   ```
4. Si l'interface change, faire les captures (voir « Vérification visuelle »), les regarder, corriger ce qui cloche.
5. Commit en anglais (`feat: ...` / `fix: ...`), push, `gh pr create` avec `Closes #<n>` et un résumé court.
6. `gh pr checks <pr> --watch`. Rouge → corriger et repousser ; après 3 échecs sur la même PR, s'arrêter et rendre compte. Le clippy de la CI est plus récent que le local : il peut signaler des lints en plus.
7. Verte → `gh pr merge <pr> --squash --delete-branch`, statut Done.

Si une tâche se révèle bien plus grosse que prévu ou oblige à revenir sur une décision prise : s'arrêter et demander, sans merger.

## 6. Release

Suivre `docs/RELEASE.md` :

1. `git switch main && git pull && git switch -c chore/release-x.y.z`.
2. Même version dans `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, puis les lockfiles : `npm install --package-lock-only` et `cd src-tauri && cargo update -p osteo-manager`.
3. Commit `chore: release x.y.z`, PR (corps : « Version x.y.z in package.json, Cargo.toml, tauri.conf.json and the lockfiles. Includes #a to #b. » + migrations éventuelles), CI verte, squash-merge.
4. `git switch main && git pull && git tag vx.y.z && git push origin vx.y.z`.
5. Suivre le workflow `Release` : `gh run list --workflow release.yml --limit 1`, puis `gh run watch <id>` (~15 min). Échec → lire les logs (`gh run view <id> --log-failed`), rendre compte, ne pas retagger sans accord.
6. Notes de version en français : `gh release edit vx.y.z --repo timothee-faget/osteo-manager-releases --notes-file <fichier>`. Même forme que les précédentes (`gh release view v0.10.0 --repo timothee-faget/osteo-manager-releases`) : rubriques en gras par module, une puce par changement visible, phrase sur la migration s'il y en a une, puis le pied habituel :

   ```
   ---

   Installation et premier lancement : voir le README du dépôt.
   Si l'application est déjà installée, elle propose la mise à jour toute seule.
   ```

## 7. Clôture

- Note du vault : cocher `[x]` les lignes livrées ; ajouter une ligne au tableau « Historique des versions » (version, date, résumé d'une ligne) ; ajouter dans « En attente de mon côté » ce que l'utilisateur doit vérifier dans l'app (migration sur données réelles, rendu non vérifiable dans le harness…).
- Mémoire `project-status` : une ligne datée (issues, PR, version publiée).
- Compte rendu final, court : issues et PR, version publiée, captures faites, points à vérifier à la main.

## Vérification visuelle

Le harness `harness/` (dans ce dossier) monte le vrai `<App/>` sur `src/test/fakeBackend.ts` avec des données fictives, sans Tauri. **Ne jamais lancer `npm run tauri dev`** : il utilise le dossier de données de l'app installée.

```sh
npx vite build --config .claude/skills/todo-release/harness/vite.config.mjs
python3 -m http.server 4799 -d .claude/skills/todo-release/harness/dist   # en arrière-plan ; file:// ne marche pas
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars \
  --window-size=1400,900 --virtual-time-budget=4000 \
  --screenshot=<scratchpad>/home-light.png "http://localhost:4799/?theme=light"
```

Paramètres d'URL (`harness/main.tsx`) :

- `theme=light|dark` : toujours le préciser, sinon Chrome suit le thème de macOS ;
- `click=Patients|FONTAINE Léa` : clique des boutons par le début de leur texte, l'un après l'autre ;
- `k=texte` : ouvre ⌘K et tape le texte ;
- `open=Tarifs|*` : déplie des sous-catégories des paramètres.

Capturer chaque écran touché en clair et en sombre, les lire avec Read. Si l'écran a besoin de données que le harness n'a pas, les ajouter dans `harness/main.tsx` (fictives uniquement) et les committer avec la PR.

Ce harness ne détecte pas les problèmes propres à Tauri (CSP, IPC) : les signaler dans « En attente » si la PR y touche.

## Garde-fous

- Jamais de données réelles : ne pas lire `private/`, données fictives dans les tests et le harness.
- Ne jamais modifier une migration déjà publiée.
- Dans la note, ne toucher qu'aux lignes traitées, au tableau des versions et à « En attente ». Ne jamais reformuler les entrées de l'utilisateur.
- Commits et PR avec les lignes d'attribution demandées par le système.
