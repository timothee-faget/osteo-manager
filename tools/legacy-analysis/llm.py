"""Local Ollama helper + redaction. Nothing leaves the machine except the redacted summary printed to stdout."""
import json
import re
import urllib.request

MODEL = "gemma4:e4b"

RULES = """RÈGLES DE CONFIDENTIALITÉ ABSOLUES (données de santé) :
- Ne recopie JAMAIS un nom, prénom, date de naissance, adresse, téléphone, e-mail, numéro de sécurité sociale, nom de médecin, ni aucun contenu clinique propre à un patient.
- Décris uniquement la STRUCTURE et les TYPES de données, avec des marqueurs génériques : [NOM], [DATE], [MONTANT], [TEXTE LIBRE], etc.
- Tu peux citer : les libellés de champs/colonnes/sections, les valeurs de listes fermées non personnelles (ex. modes de paiement, catégories de dépenses), les formats (ex. JJ/MM/AAAA, AAAA-NNN).
Réponds en français, de façon concise et structurée (Markdown)."""


def ask(prompt: str, ctx: int = 32768) -> str:
    body = json.dumps({
        "model": MODEL,
        "messages": [{"role": "system", "content": RULES}, {"role": "user", "content": prompt}],
        "stream": False,
        "options": {"temperature": 0.2, "num_ctx": ctx},
    }).encode()
    req = urllib.request.Request("http://localhost:11434/api/chat", body, {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=900) as r:
        return redact(json.loads(r.read())["message"]["content"])


_PATTERNS = [
    (re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+"), "[EMAIL]"),
    (re.compile(r"(?:\+33\s?|0)[1-9](?:[\s.-]?\d{2}){4}"), "[TEL]"),
    (re.compile(r"\b[12]\s?\d{2}\s?\d{2}\s?\d{2}\s?\d{3}\s?\d{3}\s?\d{2}\b"), "[NIR]"),
    (re.compile(r"\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b"), "[DATE]"),
]


def redact(text: str) -> str:
    for pat, repl in _PATTERNS:
        text = pat.sub(repl, text)
    return text
