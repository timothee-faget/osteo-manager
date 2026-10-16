# Données existantes (à importer)

> Structure obtenue en local avec Ollama (`gemma4:e4b`) : aucune donnée réelle n'est reproduite ici.
> Les fichiers réels sont dans `private/` (ignoré par git). Ils couvrent plusieurs années.

## 1. Classeur de comptabilité annuel (`Compta-AAAA.xlsm`)

Un classeur par année, avec des macros VBA.

### Feuilles mensuelles `JAN` … `DEC`

- **Bloc de synthèse** (en haut, à partir de la ligne 4) : total CA, dont espèces, dont chèques, total et taux de rétrocession, « Mon total » (CA − rétrocession). S'y ajoutent les charges fixes du mois (loyer, URSSAF, Doctolib, assurance, abonnements, autres) et leur total, ainsi que deux provisions :
  - `(total − charges) × 0,45` → provision d'impôt ;
  - `total × 0,26` → provision URSSAF.
- **Tableau Excel nommé** `Janvier`, `Février`… (données à partir de la ligne ~11) :

| Colonne     | Type                                       | Notes                                                    |
| ----------- | ------------------------------------------ | -------------------------------------------------------- |
| Numéro      | entier                                     | `=ROW()-10` : **repart à 1 chaque mois**                 |
| Date        | date                                       | date de la séance                                        |
| Sexe        | `Mme` / `M`                                | civilité                                                 |
| Nom, Prénom | texte                                      | patient                                                  |
| Montant     | nombre                                     | 60 € la plupart du temps                                 |
| Règlement   | `Espèces` / `Chèque` / `Virement` / `Wero` |                                                          |
| Impression  | 0 / 1                                      | facture imprimée ou remise                               |
| Cabinet     | liste (`Clara`, `Autre`)                   | lieu, qui détermine le taux de rétrocession (0 % / 30 %) |

### Feuille `Facture`

Note d'honoraires générée via des `VLOOKUP` sur une table « Infos cabinets » (adresse de chaque lieu). Elle contient :

- les coordonnées de la praticienne, son **RPPS** et son SIRET ;
- le patient ;
- la date et l'heure de la séance ;
- la ligne « Consultation d'ostéopathie » ;
- le montant ;
- la mention « non pris en charge par la Sécurité sociale ».

La macro `EnregistrerFacture` (`Ctrl+Maj+F`) exporte la zone `to_print` en PDF dans `FACTURES/<mois>/<numéro>_<nom>.pdf`.

### Feuille `Résumé`

Par mois : total, « Mon total », total et taux de rétrocession, nombre de séances (`ROWS()` du tableau).

### Correspondance pour l'import

- Une ligne du tableau donne : un patient (rapproché par nom, prénom et civilité), une séance, une facture `AAAA-MM-NNN` (année et mois tirés de la feuille, `NNN` = Numéro) et un paiement.
- Cabinet → lieu d'exercice (avec son taux de rétrocession).
- Charges fixes de la synthèse → dépenses du mois.

## 2. Fiches patients (Word `.docx`)

Un fichier par patient, sur un modèle stable.

**Identification** : nom, prénom, date de naissance, téléphone, profession, activité sportive, médecin traitant.

**Antécédents** (texte libre) : `MED` (médicaux), `CHIR` (chirurgicaux), `TRAUMA` (traumatiques), `Traitement` (en cours), `Contexte BPS` (bio-psycho-social).

**Revue des systèmes** (texte libre court) : `ORL`, `CARDIO PULMO`, `DIGESTIF`, `Gyneco`, `Hygiène de vie`.

**Séances** (liste chronologique) : date, motif, contexte / anamnèse, examen / constatations, traitement effectué et suivi. Les notes sont libres et abrégées (ex. « Ttt iliaque D »).

### Difficultés d'import

- Les libellés sont stables, mais leur contenu est du texte libre : le découpage se fera par les libellés de section.
- La séparation entre séances (par date) doit être vérifiée par une personne : un écran de validation est prévu.
- Le rapprochement entre une fiche Word et le patient de l'Excel se fait par nom et prénom, avec la date de naissance quand elle existe.
