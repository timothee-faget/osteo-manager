#!/bin/sh
# PostToolUse hook: format the file Claude just edited.
f=$(jq -r '.tool_input.file_path // empty')
[ -f "$f" ] || exit 0
case "$f" in
  *.rs) rustfmt --edition 2024 "$f" ;;
  *.ts|*.tsx|*.js|*.json|*.css|*.md|*.html|*.yml) npx --no-install prettier --write --log-level silent "$f" ;;
esac
exit 0
