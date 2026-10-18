# Règles d'or du design

Interface claire et aérée, accents terracotta du site du cabinet. Maquette validée : https://claude.ai/artifact/E41US3k5CJtZA9Lj6teS9h

Toutes les valeurs ci-dessous existent en **variables CSS** dans `src/App.css` (`:root`). Un composant n'écrit jamais une couleur, une hauteur, un rayon ou une taille de texte en dur : il utilise la variable, ou mieux, le style de l'élément HTML déjà défini globalement (`button`, `input`, `table`, `h2`…).

## 1. Dimensions : une seule hauteur par usage

| Élément                                                             | Variable         | Valeur           |
| ------------------------------------------------------------------- | ---------------- | ---------------- |
| Bouton, champ, liste déroulante, recherche                          | `--control-h`    | 2.5rem (37,5 px) |
| Bouton compact (dans une ligne de tableau, une liste « À traiter ») | `--control-h-sm` | 2rem (30 px)     |
| Ligne de tableau (hauteur minimale, en-tête compris)                | `--row-h`        | 2.75rem (41 px)  |
| Pastille de statut, badge                                           | `--pill-h`       | 1.5rem           |
| Icône                                                               | `--icon`         | 1.15rem          |

- Deux contrôles côte à côte ont toujours la même hauteur (ex. la recherche et le bouton de l'en-tête).
- Une zone de texte (`textarea`) est la seule exception : sa hauteur suit le contenu.
- Dans un tableau, tout bouton est compact : la ligne garde `--row-h`.

## 2. Espacements

Échelle unique : `--space-1` à `--space-7` = 0.25 · 0.5 · 0.75 · 1 · 1.5 · 2 · 3 rem.

- Les éléments frères s'espacent avec `gap` (flex/grid), pas avec des marges.
- Entre deux blocs d'une page : `--space-5`. Entre une carte et la suivante dans une grille : `--space-3`.
- Intérieur d'une carte : `--space-5` (`--space-4` sur petit écran).

## 3. Typographie

DM Sans uniquement, poids 400, 500 et 600 (jamais de gras 700).

| Rôle                                         | Variable     | Taille  | Poids   |
| -------------------------------------------- | ------------ | ------- | ------- |
| Titre de page (`h2`)                         | `--text-xl`  | 2rem    | 500     |
| Titre de carte ou de section (`h3`)          | `--text-lg`  | 1.3rem  | 500     |
| Chiffre clé (tuile)                          | `--text-kpi` | 1.75rem | 500     |
| Texte courant, cellules                      | `--text-md`  | 1rem    | 400     |
| Libellés, en-têtes de tableau, boutons       | `--text-sm`  | 0.9rem  | 400–500 |
| Notes, sous-titres, intertitres en capitales | `--text-xs`  | 0.8rem  | 400–600 |

- Tous les montants et dates : chiffres tabulaires (déjà actif sur `body`).
- Intertitres en capitales (groupes de navigation) : `--text-xs`, espacement de lettres 0.08em, couleur `--muted`.

## 4. Couleurs

| Variable                                         | Rôle                                                      |
| ------------------------------------------------ | --------------------------------------------------------- |
| `--bg`                                           | Fond de la page et de la barre latérale                   |
| `--surface`                                      | Cartes, champs, boutons, pastilles                        |
| `--surface-2`                                    | Fonds en creux : onglets, survol, icônes de liste         |
| `--tile`                                         | Tuiles de chiffres clés (couleur unie, jamais de dégradé) |
| `--line`                                         | Filets, bordures de champs et de boutons                  |
| `--ink` / `--ink-soft` / `--muted`               | Texte principal / secondaire / discret                    |
| `--accent`, `--accent-dark`, `--accent-soft`     | Actions, élément actif, focus. Rien de décoratif          |
| `--cta` / `--on-cta`                             | L'action principale de l'en-tête de page (encre foncée)   |
| `--success`, `--warning`, `--danger` (+ `-soft`) | Statuts uniquement                                        |

- Chaque variable a sa valeur sombre (§ 10). Une couleur absente de cette liste n'existe pas.
- La couleur n'est jamais seule porteuse de sens : un statut a toujours son texte.

## 5. Surfaces et rayons

- **Page** : fond `--bg`, sans bordure.
- **Carte** (`.card`) : `--surface`, ombre `--shadow`, rayon `--radius` (1rem), pas de bordure. Une carte regroupe un sujet (une liste, un formulaire), pas chaque élément.
- **Tuile de chiffre clé** (`.kpi`) : fond `--tile` uni, rayon `--radius`, icône dans un rond `--surface`.
- **Tableau** : jamais de fond ni de cadre propre. Posé sur la page ou dans une carte, en-têtes `--muted`, lignes séparées par `--line`.
  - Colonne de montants ou de pourcentages : `.num` sur le `th` **et** les `td` (aligné à droite, jamais coupé).
  - Nom de patient en cellule de texte simple : `.patient` (jamais coupé ; c'est le motif voisin qui passe à la ligne).
- **Formulaire de saisie** (`.expense-form`) : largeur max 48rem, jamais étiré sur toute la page.
- **Rayons** : `--radius` pour cartes, tuiles, groupes ; `--radius-sm` (0.625rem) pour champs, zones de texte, menus ; `--radius-pill` pour boutons, recherches, pastilles, onglets et éléments de navigation.

## 6. Boutons

Quatre variantes, pas une de plus :

| Variante                     | Usage                                                                    |
| ---------------------------- | ------------------------------------------------------------------------ |
| `button` (défaut)            | Action secondaire : contour `--line`, fond `--surface`                   |
| `type="submit"` / `.primary` | Valider un formulaire ou confirmer : fond `--accent`                     |
| `.cta`                       | L'action principale d'une page, dans son en-tête. **Une seule par page** |

- Toute page commence par un `<header>` : le `h2` à gauche, ses actions à droite. L'action qui crée ou lance le travail de la page (« Nouveau patient », « Nouvelle dépense », « Envoyer les factures non envoyées… ») y est en `.cta`, jamais un `.primary` posé dans le corps de la page.
- `.primary` / `submit` est réservé à la validation d'un formulaire ou d'une confirmation.
  | `.link` | Navigation dans le texte (« ← Patients », « Détail… → ») |

- Dans une cellule de tableau, un `.link` s'affiche comme le libellé de la ligne (texte `--ink`, souligné au survol seulement).
- Libellé = ce que fait le bouton (« Envoyer », « Relancer »), à l'infinitif ou à l'impératif.
- Une icône devant le libellé est permise, jamais une icône seule sans `aria-label`.

## 7. Composants partagés

- **Changement d'année** : `YearNav` (`src/YearNav.tsx`). Chevrons `Icon` à gauche de l'année, total éventuel à droite. Jamais de glyphes ◀ ▶.
- **Bloc repliable** hors paramètres : `<details className="disclosure">` avec un `Icon name="chevron"` dans le `summary`, comme `Fold`. Jamais le triangle natif.
- **Recherche** : `.search-field` (icône loupe + `input type="search"`), en pilule, partout où l'on cherche (accueil, recherche rapide, liste des patients).

## 8. Noms de patients

- Dans les listes et en-têtes issus de la fiche patient : **« DUPONT Anne »** (nom en capitales, puis prénom).
- Les listes de factures, avoirs, chèques et impayés affichent le nom **tel qu'imprimé sur la facture** (« Anne Dupont ») : c'est une donnée figée du document, on ne la reformate pas.

## 9. Statuts

Toujours `.status` + une classe de statut, en pastille `--surface` avec texte coloré :

| Classe                                           | Couleur         | Exemples                          |
| ------------------------------------------------ | --------------- | --------------------------------- |
| `status-paid`                                    | `--success`     | Payée                             |
| `status-partially_paid`, `status-unbilled`       | `--warning`     | Partiellement payée, Non facturée |
| `status-unpaid`                                  | `--danger`      | Impayée                           |
| `status-invoiced`, `status-unsent`               | `--accent-dark` | Facturée, Non envoyée             |
| `status-sent`, `status-cancelled`, `status-free` | `--ink-soft`    | Envoyée, Annulée, Gracieuse       |

## 10. Thème clair et sombre

- Réglage Auto / Clair / Sombre dans Paramètres → Apparence (`src/theme.ts`, attribut `data-theme` sur `<html>`). Auto suit macOS.
- Le sombre n'est pas une inversion : fond brun très foncé chaud, cartes un cran plus claires, terracotta éclairci.
- Toute nouvelle variable est définie trois fois : `:root` (clair), `@media (prefers-color-scheme: dark) :root:not([data-theme="light"])`, et `:root[data-theme="dark"]`.

## 11. Icônes

- Composant `Icon` (`src/icons.tsx`) : SVG au trait, grille 24, épaisseur 1.6, taille `--icon`, couleur `currentColor`.
- Usages : navigation, tuiles, lignes « À traiter », recherche, chevrons (repli, année). Pas d'emoji ni de flèche Unicode servant d'icône.

## Avant une PR qui touche l'interface

- [ ] Aucune couleur, hauteur, rayon ou taille de texte en dur hors de `:root`.
- [ ] Contrôles côte à côte de même hauteur ; boutons de tableau compacts.
- [ ] Vérifié en clair **et** en sombre.
- [ ] Au plus un `.cta` par page, dans l'en-tête.
- [ ] Colonnes de montants en `.num`.
