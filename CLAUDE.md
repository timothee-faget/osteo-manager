# Osteo Manager

Application de bureau (Tauri 2 + React/TypeScript + SQLite chiffrée) pour gérer un cabinet d'ostéopathie : patients, séances, factures, comptabilité BNC (2035).
Spec complète : @docs/SPEC.md

## Règles non négociables

- **Données de santé** : ne jamais committer, logger ni mettre dans un test des données réelles de patients. Fixtures = données fictives uniquement. Ne pas lire les fichiers dans `private/` (données réelles).
- **Factures immuables** : une facture émise ne se modifie ni ne se supprime ; correction par avoir. Numérotation continue sans trou, attribuée dans une transaction.
- **Montants en centimes** (`i64` en Rust, `number` entier en TS). Jamais de flottants pour l'argent.
- **Recettes = date d'encaissement** (comptabilité de trésorerie), pas date de facture.
- Toute modification de schéma passe par une **migration** versionnée, jamais d'édition d'une migration déjà publiée.
- Aucun appel réseau sauf : SMTP (envoi de mails) et vérification des mises à jour.

## Conventions

- Code, identifiants et commits en **anglais** ; interface utilisateur en **français**.
- Termes métier : patient, session (séance), invoice (facture), credit note (avoir), payment, cheque deposit (remise de chèques), expense, fixed asset (immobilisation), practice location (lieu d'exercice).
- Logique métier et accès DB côté Rust (commandes Tauri) ; le front ne fait que de l'affichage et de la saisie.

## Workflow

- Une issue GitHub = une branche (`feat/<n>-slug`, `fix/<n>-slug`) = une PR qui référence `Closes #<n>`.
- Écrire les tests de la logique métier (numérotation, avoirs, calculs comptables) avant l'implémentation.
- Avant de terminer : lint, typecheck et tests au vert.

## Commandes

_À compléter après le scaffold (issue M0)._
