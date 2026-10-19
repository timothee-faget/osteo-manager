# Osteo Manager

Application de bureau (Tauri 2 + React/TypeScript + SQLite chiffrée) pour gérer un cabinet d'ostéopathie : patients, séances, factures, comptabilité BNC (2035).
Spec complète : @docs/SPEC.md

## Règles non négociables

- **Dépôt public** : code, historique, issues et PR sont visibles de tous.
- **Données de santé** : ne jamais committer, logger ni mettre dans un test des données réelles de patients. Fixtures = données fictives uniquement. Ne pas lire les fichiers dans `private/` (données réelles).
- **Analyser des données réelles** (Excel, Word dans `private/`) : uniquement via des scripts locaux qui passent le contenu à Ollama (`gemma4:e4b`) avec des consignes d'anonymisation. N'afficher que la structure, jamais les valeurs brutes.
- **Factures immuables** : une facture émise ne se modifie ni ne se supprime ; correction par avoir. Numérotation continue sans trou, attribuée dans une transaction.
- **Montants en centimes** (`i64` en Rust, `number` entier en TS). Jamais de flottants pour l'argent.
- **Recettes = date d'encaissement** (comptabilité de trésorerie), pas date de facture.
- Toute modification de schéma passe par une **migration** versionnée, jamais d'édition d'une migration déjà publiée.
- Aucun appel réseau sauf : SMTP (envoi de mails) et vérification des mises à jour.

## Conventions

- Code, identifiants et commits en **anglais** ; interface utilisateur en **français**.
- Termes métier : patient, session (séance), invoice (facture), credit note (avoir), payment, cheque deposit (remise de chèques), expense, fixed asset (immobilisation), practice location (lieu d'exercice).
- Logique métier et accès DB côté Rust (commandes Tauri) ; le front ne fait que de l'affichage et de la saisie.
- Interface : respecter les règles d'or de [docs/DESIGN.md](docs/DESIGN.md) (variables CSS, hauteurs, statuts, thème clair/sombre).

## Workflow

- Une issue GitHub = une branche (`feat/<n>-slug`, `fix/<n>-slug`) = une PR qui référence `Closes #<n>`.
- Écrire les tests de la logique métier (numérotation, avoirs, calculs comptables) avant l'implémentation.
- Avant de terminer : lint, typecheck et tests au vert.
- Note Obsidian du projet : `~/Documents/Tim's Vault/20-29 Mes Loisirs/21 Développement/21.34 Osteo Manager.md` (historique des versions à compléter après chaque release, liste « À faire » tenue à la main : ne pas réécrire ses entrées).

## Commandes

```sh
npm run tauri dev        # lancer l'app en dev
npm run typecheck        # tsc
npm run lint             # eslint + prettier --check
npm run format           # prettier --write
npm test                 # vitest

cd src-tauri
cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
```

Un hook Claude Code (`.claude/hooks/format.sh`) formate automatiquement chaque fichier édité.
