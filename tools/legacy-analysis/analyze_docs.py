"""Usage: analyze_docs.py <dir> [sample_size]
Counts patient files by extension, extracts text locally (macOS textutil), has Gemma describe each sampled file's
structure, then merges into one schema. File names and raw text are never printed."""
import subprocess
import sys
from collections import Counter
from pathlib import Path

from llm import ask

root = Path(sys.argv[1])
n_sample = int(sys.argv[2]) if len(sys.argv) > 2 else 12
TEXT_EXT = {".doc", ".docx", ".odt", ".rtf", ".txt"}

files = sorted(p for p in root.rglob("*") if p.is_file() and not p.name.startswith((".", "~$")))
print(f"# Dossier : {len(files)} fichiers ; par extension : {dict(Counter(p.suffix.lower() for p in files))}")
print(f"Profondeur des sous-dossiers : {dict(Counter(len(p.relative_to(root).parts) - 1 for p in files))}\n")

docs = [p for p in files if p.suffix.lower() in TEXT_EXT]
if not docs:
    sys.exit("Aucun document texte exploitable.")


def text_of(p):
    return subprocess.run(["textutil", "-convert", "txt", "-stdout", str(p)], capture_output=True, text=True).stdout


lengths = [len(text_of(p)) for p in docs]
print(f"Longueur du texte (caractères) : min {min(lengths)}, médiane {sorted(lengths)[len(lengths)//2]}, max {max(lengths)}\n")

step = max(1, len(docs) // n_sample)
sample = docs[::step][:n_sample]
structures = []
for i, p in enumerate(sample, 1):
    txt = text_of(p)[:20000]
    s = ask(
        "Voici le texte d'une fiche patient d'ostéopathe (document Word converti en texte, les tableaux sont séparés par des tabulations).\n\n"
        f"{txt}\n\n"
        "Liste la STRUCTURE de la fiche : sections, champs (libellé tel qu'écrit, type de donnée, format, obligatoire/facultatif apparent), "
        "présence d'un historique de séances (et ce que contient chaque séance), tableaux. Aucune valeur personnelle."
    )
    structures.append(s)
    print(f"(fiche échantillon {i}/{len(sample)} analysée)", file=sys.stderr)

print(ask(
    f"Voici {len(structures)} descriptions de structure de fiches patients d'une même ostéopathe :\n\n"
    + "\n\n---\n\n".join(structures)
    + "\n\nFusionne-les en UN schéma de données unifié pour une application : sections, champs (nom, type, format, fréquence d'apparition), "
    "structure d'une séance, variations entre fiches (modèle stable ou évolutif ?), et difficultés prévisibles pour un import automatique.",
    ctx=65536,
))
