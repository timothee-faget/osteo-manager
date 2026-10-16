# Analyse locale des données existantes

Scripts qui décrivent la **structure** de l'Excel de comptabilité et des fiches Word sans jamais afficher de données réelles. Le contenu est envoyé uniquement au modèle local Ollama (`gemma4:e4b`).

```sh
python3 -m venv .venv && .venv/bin/pip install openpyxl oletools
.venv/bin/python tools/legacy-analysis/analyze_excel.py private/Compta-2026.xlsm
.venv/bin/python tools/legacy-analysis/analyze_docs.py private/fiches 12
```

Résultat consolidé : [docs/legacy-data.md](../../docs/legacy-data.md).
