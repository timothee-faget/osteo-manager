# Osteo Manager — Spécification

> Application de bureau pour gérer un cabinet d'ostéopathie : fiches patients, séances, facturation, comptabilité (déclaration contrôlée / 2035).
> Utilisatrice unique : une ostéopathe libérale. Pas de distribution à des tiers prévue.

## 1. Principes directeurs

| Principe                       | Conséquence                                                                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| **Données de santé**           | Toutes les données restent **en local** sur l'ordinateur de la praticienne, chiffrées. Aucun serveur → pas d'obligation HDS. |
| **Sécurité**                   | Base chiffrée, app verrouillée par mot de passe, verrouillage auto après inactivité, sauvegardes chiffrées.                  |
| **Conformité facturation**     | Numérotation continue sans trou, facture émise = immuable, correction par avoir.                                             |
| **Comptabilité de trésorerie** | Les recettes comptent à la **date d'encaissement**, pas de facturation (régime BNC déclaration contrôlée).                   |
| **Mises à jour**               | L'app se met à jour automatiquement à partir des releases signées.                                                           |
| **Simplicité**                 | Pas d'agenda (Doctolib est déjà utilisé). Interface en français.                                                             |

## 2. Stack technique

- **Tauri 2** (app de bureau, auto-update intégré)
- **React + TypeScript** (Vite) pour l'interface
- **SQLite chiffrée** (SQLCipher) côté Rust, migrations versionnées
- Génération PDF : crate `krilla` côté Rust, police Inter (OFL) embarquée
- Envoi d'e-mails : SMTP depuis la boîte de la praticienne (crate `lettre`), identifiants dans le trousseau du système

## 3. Modules fonctionnels

### 3.1 Paramètres

- Identité de la praticienne : nom, numéro **RPPS** (ADELI facultatif), SIRET, adresse, téléphone, e-mail, logo.
- **Lieux d'exercice** : nom, adresse (imprimée sur la facture) et **taux de rétrocession** (0 % par défaut). Elle a aujourd'hui son propre cabinet, mais a été collaboratrice avec rétrocession (0 % / 30 %) et pourrait le redevenir. Le domicile du patient et l'entreprise sont des types de lieu.
- **Tarifs** : tarif standard (60 € aujourd'hui) et tarif « à domicile ». Le montant reste modifiable séance par séance.
- **Taux de provision** réglables : impôt (45 % de CA − charges) et URSSAF (26 % du CA encaissé, net des rétrocessions), valeurs reprises de l'Excel.
- Mentions de facture : « TVA non applicable, art. 261-4-1° du CGI », « Acte non pris en charge par la Sécurité sociale », conditions de paiement.

### 3.2 Fiches patients

Calquées sur ses fiches Word actuelles (voir [legacy-data.md](legacy-data.md)) :

- **Identification** : civilité, nom, prénom, date de naissance, téléphone, e-mail (pour l'envoi des factures), adresse, profession, activité sportive, médecin traitant.
- **Patient mineur** : représentant(s) légal(aux) et autorisation.
- **Antécédents** (texte libre) : médicaux, chirurgicaux, traumatiques, traitement en cours, contexte bio-psycho-social.
- **Revue des systèmes** (texte libre) : ORL, cardio-pulmonaire, digestif, gynécologique, hygiène de vie.
- Historique des séances (voir 3.3).
- **Pièces jointes** (radios, ordonnances, comptes-rendus) stockées chiffrées.
- **Vue consultation** : bandeau compact des infos civiles (modifiables via « Modifier la fiche ») ; à gauche la séance en cours puis les séances passées avec leur note complète ; à droite les antécédents et la revue des systèmes, toujours éditables, puis les pièces jointes.
- _Futur_ : schéma du corps annotable.
- RGPD : export complet d'un dossier patient ; conservation longue (archivage, pas de suppression automatique).

### 3.3 Séances

- Date et heure, lieu, motif et une note libre unique.
- Tarif pré-rempli selon le lieu (standard ou domicile), modifiable.
- **Valider une séance génère automatiquement la facture** (sans l'envoyer).

### 3.4 Facturation

- Facture PDF avec toutes les mentions obligatoires (praticienne, ADELI, SIRET, patient, date, prestation, montant, mention TVA).
- Numérotation **`AAAA-MM-NNN`** (ex. `2026-04-012`) : une série continue par mois, comme dans son Excel. Le numéro est attribué à l'émission et jamais réutilisé.
- Libellé « Consultation d'ostéopathie », civilité du patient, « Note d'honoraires acquittée » une fois payée.
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
- **Charges récurrentes** (loyer, URSSAF, Doctolib, assurance, abonnements…) : un modèle génère la dépense chaque mois, à confirmer ou ajuster.
- **Rétrocessions** : si un lieu a un taux, l'app calcule la rétrocession due chaque mois (CA encaissé du lieu × taux) et la passe en dépense une fois payée.
- **Registre des immobilisations et des amortissements** (exigé en déclaration contrôlée) : matériel, table, informatique, etc.

### 3.7 Comptabilité et exports

- **Livre-journal** des recettes et des dépenses (chronologique, avec le mode de paiement).
- Synthèse annuelle des montants à reporter sur la **2035 / 2035-A / 2035-B**.
- Exports CSV et PDF.

### 3.8 Tableau de bord

- CA encaissé du mois et de l'année, nombre de séances, panier moyen.
- Montant total des impayés et nombre de chèques à remettre.
- Dépenses, rétrocessions et résultat estimé.
- **Provisions** à mettre de côté (impôt, URSSAF) selon les taux réglables.
- Répartition du CA par lieu.
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

Plusieurs années de données. Les formats sont décrits dans [legacy-data.md](legacy-data.md).

- **Comptabilité** : un classeur Excel par an → patients, séances, factures (`AAAA-MM-NNN` reconstitué depuis la feuille et le numéro), paiements, lieux et rétrocessions, charges fixes mensuelles.
- **Fiches patients** : un `.docx` par patient → identification, antécédents, revue des systèmes et séances, découpés selon les libellés de section.
- Rapprochement des patients entre Excel et Word (nom + prénom, et date de naissance si disponible).
- **Écran de vérification** avant validation, et import rejouable sans créer de doublons.

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

| Jalon                                 | Contenu                                                                                              |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **M0 — Fondations**                   | Socle Tauri/React/SQLCipher, CI, verrouillage, sauvegarde, pipeline de mise à jour                   |
| **M1 — Patients & facturation (MVP)** | Paramètres, fiches, séances, factures PDF, paiements, recherche                                      |
| **M2 — Comptabilité**                 | Dépenses, immobilisations, remises de chèques, impayés, livre-journal, exports 2035, tableau de bord |
| **M3 — E-mails**                      | SMTP, envoi unitaire et groupé, relances                                                             |
| **M4 — Import**                       | Excel de facturation, fiches Word                                                                    |

## 6. Questions ouvertes

- [x] OS : **macOS**, sans signature Apple (contournement de Gatekeeper au premier lancement).
- [x] Releases : binaires publiés dans un **repo public dédié**, le code reste privé.
- [x] Fiches et Excel : structure analysée, voir [legacy-data.md](legacy-data.md).
- [x] Moteur de génération PDF : `krilla` (Rust), police Inter embarquée.
