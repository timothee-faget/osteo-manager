# Installer Osteo Manager

> Ce texte sert aussi de README au dépôt public des releases.

## Première installation

1. Ouvrir la page **Releases** du dépôt et télécharger le fichier `Osteo Manager_x.y.z_universal.dmg` de la dernière version.
2. Ouvrir le `.dmg` et glisser **Osteo Manager** dans **Applications**.
3. Lancer l'application depuis **Applications**.

### Premier lancement : message de sécurité de macOS

L'application n'est pas signée par Apple (pas de compte développeur payant). Au premier lancement, macOS affiche un message du type « Apple n'a pas pu vérifier qu'Osteo Manager ne contient pas de logiciel malveillant ». C'est normal et ça n'arrive qu'une fois :

1. Cliquer sur **Terminé** (ou **OK**), surtout pas sur « Placer dans la corbeille ».
2. Ouvrir **Réglages Système → Confidentialité et sécurité**.
3. Tout en bas, à côté de « Osteo Manager a été bloquée… », cliquer sur **Ouvrir quand même**, puis confirmer avec le mot de passe de la session Mac.

Si macOS dit que l'application est « endommagée » et ne propose pas « Ouvrir quand même », ouvrir le **Terminal** et taper :

```sh
xattr -cr "/Applications/Osteo Manager.app"
```

puis relancer l'application.

## Mises à jour

Au démarrage, l'application vérifie s'il existe une nouvelle version et propose **Installer et redémarrer**. Rien d'autre à faire : pas de nouveau message de sécurité, les données et le mot de passe restent les mêmes. Si un dossier de sauvegarde est choisi, une sauvegarde est faite au redémarrage ; une copie de la base est aussi faite avant toute évolution de sa structure.

## Données

Les données restent sur le Mac, chiffrées, dans `~/Library/Application Support/fr.osteomanager.app/`. Rien n'est envoyé sur Internet, sauf la vérification des mises à jour (et plus tard l'envoi des factures par e-mail).
