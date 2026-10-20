#!/usr/bin/env bash
# Atualiza o entregador para a versão mais nova do GitHub e reinicia sem derrubar o Caddy.
# Uso (como root):  cd /opt/entregador && bash atualizar.sh
set -euo pipefail
cd "$(dirname "$0")"
git pull -q --ff-only
docker compose up -d --build entregador
docker image prune -f >/dev/null
sleep 5
docker compose exec -T entregador wget -qO- http://127.0.0.1:8080/saude | head -c 400; echo
