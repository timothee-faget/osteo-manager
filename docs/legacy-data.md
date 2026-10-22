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
| Cabinet     | liste (nom du cabinet, `Autre`)            | lieu, qui détermine le taux de rétrocession (0 % / 30 %) |

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

### Particularités constatées (import Excel)

- Les dates sont des numéros de série Excel. L'année du classeur vient de son nom (`Compta-AAAA`) : un classeur démarré d'une copie de l'année précédente garde des mois entiers aux dates de l'an passé, ignorés par l'import.
- Les mois à venir contiennent une ligne de modèle (date d'une autre année, montant et règlement déjà remplis) : ignorée, comme toute ligne hors de l'année du classeur et du mois de la feuille.
- `Sexe` n'est pas fiable : la civilité des patients importés reste vide.
- `Nom` contient parfois aussi le prénom (« NOM Prénom »).
- `Règlement` vide = séance non payée (facture impayée). Un montant vide avec un règlement renseigné n'est pas importé et est signalé.
- Plusieurs copies du même classeur (sauvegarde, récupération automatique) se recoupent : une séance est identifiée par sa date et son patient, la copie la plus fournie fait référence et les écarts sont signalés.
- La table « Infos cabinets » de la feuille `Facture` (colonne « Proprio ») donne le prix et l'adresse de chaque cabinet. Le taux de rétrocession n'y est pas : il est écrit en dur dans les formules de la cellule `Taux Rétrocession` et change d'un mois à l'autre. L'import crée les lieux à 0 %, le taux se règle ensuite dans l'application, et les rétrocessions passées ne sont pas importées.
- Le nom d'un même cabinet peut changer d'un classeur à l'autre : l'écran d'import associe chaque nom à un lieu d'exercice.
- Les factures importées gardent leur numéro `AAAA-MM-NNN`, sont marquées envoyées, et la date d'encaissement est la date de séance. Les chèques importés sont rangés dans une remise par mois.

- Le bloc des charges fixes se trouve sous une cellule qui porte le code du mois (« JAN »), dans une colonne qui varie d'un classeur à l'autre ; les libellés sont libres et changent d'un mois à l'autre. L'import reconnaît loyer, assurance, Doctolib, téléphone (tel, sfr) et Indy, et crée une dépense par virement au 1er du mois (catégories 2035-A : loyers, assurance, frais de gestion, téléphone). Les cotisations sociales (« Charges », « URSSAF »…) sont des estimations calculées (26 % du CA) et ne sont pas importées. Les autres lignes (abonnements personnels, « Autre ») sont listées à l'écran d'import, à saisir à la main si elles comptent. Les mois sans séance ne sont pas importés : leurs charges sont préremplies à l'avance.

### Correspondance pour l'import

- Une ligne du tableau donne : un patient (rapproché par nom, prénom et civilité), une séance, une facture `AAAA-MM-NNN` (année et mois tirés de la feuille, `NNN` = Numéro) et un paiement.
- Cabinet → lieu d'exercice (avec son taux de rétrocession).
- Charges fixes de la synthèse → dépenses du mois (voir les particularités ci-dessus).

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
