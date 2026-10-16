# Osteo Manager — Spécification

> Application de bureau pour gérer un cabinet d'ostéopathie : fiches patients, séances, facturation, comptabilité (déclaration contrôlée / 2035).
> Utilisatrice unique : une ostéopathe libérale. Pas de distribution à des tiers prévue.

## 1. Principes directeurs

| Principe | Conséquence |
|---|---|
| **Données de santé** | Toutes les données restent **en local** sur l'ordinateur de la praticienne, chiffrées. Aucun serveur → pas d'obligation HDS. |
| **Sécurité** | Base chiffrée, app verrouillée par mot de passe, verrouillage auto après inactivité, sauvegardes chiffrées. |
| **Conformité facturation** | Numérotation continue sans trou, facture émise = immuable, correction par avoir. |
| **Comptabilité de trésorerie** | Les recettes comptent à la **date d'encaissement**, pas de facturation (régime BNC déclaration contrôlée). |
| **Mises à jour** | L'app se met à jour automatiquement à partir des releases signées. |
| **Simplicité** | Pas d'agenda (Doctolib est déjà utilisé). Interface en français. |

## 2. Stack technique

- **Tauri 2** (app de bureau, auto-update intégré)
- **React + TypeScript** (Vite) pour l'interface
- **SQLite chiffrée** (SQLCipher) côté Rust, migrations versionnées
- Génération PDF : à trancher dans l'issue dédiée
- Envoi d'e-mails : SMTP depuis la boîte de la praticienne (crate `lettre`), identifiants dans le trousseau du système

## 3. Modules fonctionnels

### 3.1 Paramètres
- Identité de la praticienne : nom, numéro ADELI, SIRET, adresse, téléphone, e-mail, logo.
- **Lieux d'exercice** : un cabinet principal au départ, mais le modèle doit en accepter plusieurs (remplacement, collaboration). Le domicile du patient et l'entreprise sont des types de lieu.
- **Tarifs** : un tarif standard et un tarif « à domicile ». Le montant reste modifiable séance par séance.
- Mentions de facture : « TVA non applicable, art. 261-4-1° du CGI », conditions de paiement.

### 3.2 Fiches patients
- État civil, coordonnées, e-mail (pour l'envoi des factures).
- **Patient mineur** : représentant(s) légal(aux) et autorisation.
- Antécédents, traitements en cours.
- Historique des séances (voir 3.3).
- **Pièces jointes** (radios, ordonnances, comptes-rendus) stockées chiffrées.
- La structure exacte des champs sera calée sur **les modèles actuels de la praticienne** (à fournir).
- *Futur* : schéma du corps annotable.
- RGPD : export complet d'un dossier patient ; conservation longue (archivage, pas de suppression automatique).

### 3.3 Séances
- Date, lieu, motif, notes de séance, conseils donnés.
- Tarif pré-rempli selon le lieu (standard ou domicile), modifiable.
- **Valider une séance génère automatiquement la facture** (sans l'envoyer).

### 3.4 Facturation
- Facture PDF avec toutes les mentions obligatoires (praticienne, ADELI, SIRET, patient, date, prestation, montant, mention TVA).
- Numérotation chronologique continue (ex. `2026-0001`), attribuée à l'émission, jamais réutilisée.
- Une facture émise ne peut plus être modifiée ni supprimée ; on l'annule ou on la corrige par un **avoir**.
- Statut d'envoi : non envoyée / envoyée (avec la date).
- Statut de paiement : impayée / partiellement payée / payée.

### 3.5 Encaissements
- Modes de paiement : **chèque, Wero, espèces, virement**.
- Paiements partiels possibles ; date d'encaissement.
- **Remises de chèques** : sélection des chèques non remis, bordereau de remise (PDF), date de dépôt.
- **Suivi des impayés** : liste triée par ancienneté.

### 3.6 Dépenses et immobilisations
- Saisie d'une dépense : date, fournisseur, montant, mode de paiement, catégorie, **justificatif** (photo ou PDF).
- Les catégories reprennent les lignes de la **2035-A**.
- **Registre des immobilisations et des amortissements** (exigé en déclaration contrôlée) : matériel, table, informatique, etc.

### 3.7 Comptabilité et exports
- **Livre-journal** des recettes et des dépenses (chronologique, avec le mode de paiement).
- Synthèse annuelle des montants à reporter sur la **2035 / 2035-A / 2035-B**.
- Exports CSV et PDF.

### 3.8 Tableau de bord
- CA encaissé du mois et de l'année, nombre de séances, panier moyen.
- Montant total des impayés et nombre de chèques à remettre.
- Dépenses et résultat estimé.
- Comparaison avec l'année N-1.

### 3.9 E-mails
- Configuration SMTP de sa propre adresse (avec un test de connexion).
- Envoi unitaire d'une facture.
- **Envoi groupé** : toutes les factures non envoyées (par ex. en fin de journée), avec un aperçu avant envoi.
- **Relance des impayés** : modèle de mail de relance, envoi unitaire ou groupé, historique des relances.

### 3.10 Recherche rapide
- Raccourci `⌘K` / `Ctrl+K` : recherche de patients (nom, prénom, date de naissance, téléphone) et de factures (numéro).

### 3.11 Sécurité et sauvegarde
- Mot de passe à l'ouverture, d'où est dérivée la clé de chiffrement de la base (Argon2).
- Verrouillage automatique après X minutes d'inactivité (réglable).
- **Sauvegarde automatique chiffrée** (quotidienne et à la fermeture) vers un dossier choisi (disque externe recommandé), avec rotation.
- Restauration d'une sauvegarde depuis l'app.
- ⚠️ Sans le mot de passe, les données sont irrécupérables : prévoir une clé de récupération à imprimer.

### 3.12 Import des anciennes données
- **Facturation** : fichier Excel existant → patients, séances, factures et paiements historiques (en conservant les numéros d'origine).
- **Fiches patients** : documents Word → patients et notes, avec un écran de vérification avant validation.
- Formats précis à définir quand des échantillons **anonymisés** seront disponibles.

### 3.13 Mises à jour
- `tauri-plugin-updater` avec des artefacts signés publiés sur GitHub Releases.
- L'app vérifie au démarrage et propose d'installer la mise à jour.
- Une sauvegarde automatique est faite avant chaque migration de base.

## 4. Hors périmètre (pour l'instant)
- Agenda et prise de rendez-vous (Doctolib).
- Multi-utilisateur, synchronisation, version mobile.
- Télétransmission et tiers payant (non applicables à l'ostéopathie).
- Schéma du corps (plus tard).

## 5. Jalons

| Jalon | Contenu |
|---|---|
| **M0 — Fondations** | Socle Tauri/React/SQLCipher, CI, verrouillage, sauvegarde, pipeline de mise à jour |
| **M1 — Patients & facturation (MVP)** | Paramètres, fiches, séances, factures PDF, paiements, recherche |
| **M2 — Comptabilité** | Dépenses, immobilisations, remises de chèques, impayés, livre-journal, exports 2035, tableau de bord |
| **M3 — E-mails** | SMTP, envoi unitaire et groupé, relances |
| **M4 — Import** | Excel de facturation, fiches Word |

## 6. Questions ouvertes
- [ ] OS de la praticienne (macOS / Windows) : conditionne la signature du code (compte Apple Developer à 99 €/an sur Mac).
- [ ] Le repo est privé, mais l'updater a besoin d'URLs de release publiques : publier les binaires dans un repo public dédié, ou rendre le code public ?
- [ ] Modèles de fiches patients (à fournir).
- [ ] Échantillons anonymisés de l'Excel et des fiches Word.
- [ ] Moteur de génération PDF.
