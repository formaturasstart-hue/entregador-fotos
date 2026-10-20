#!/usr/bin/env bash
# Instalação do entregador de fotos numa VPS Ubuntu (22.04/24.04) zerada. Rodar como root:
#   curl -fsSL https://raw.githubusercontent.com/formaturasstart-hue/entregador-fotos/main/instalar.sh | bash
# Pode rodar de novo à vontade: ele só completa o que faltar.
set -euo pipefail

REPO="${REPO:-https://github.com/formaturasstart-hue/entregador-fotos.git}"
DESTINO="${DESTINO:-/opt/entregador}"

azul() { printf '\n\033[1;34m== %s\033[0m\n' "$*"; }
ok() { printf '\033[1;32m✔ %s\033[0m\n' "$*"; }
erro() { printf '\033[1;31m✘ %s\033[0m\n' "$*" >&2; }

[ "$(id -u)" = 0 ] || { erro "Rode como root (na Hostinger o terminal do navegador já é root)."; exit 1; }

azul "1/6 Pacotes básicos"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl git ufw unattended-upgrades >/dev/null
ok "pacotes instalados"

azul "2/6 Docker"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh >/dev/null
fi
systemctl enable --now docker >/dev/null 2>&1 || true
docker compose version >/dev/null 2>&1 || { erro "Docker Compose não encontrado. Rode de novo o instalador."; exit 1; }
ok "docker $(docker --version | cut -d' ' -f3 | tr -d ,) pronto"

azul "3/6 Firewall e atualizações automáticas de segurança"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443 >/dev/null
ufw --force enable >/dev/null
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
ok "só as portas 22, 80 e 443 ficam abertas; Ubuntu se atualiza sozinho"

azul "4/6 Código do entregador"
if [ -d "$DESTINO/.git" ]; then
  git -C "$DESTINO" pull -q --ff-only
else
  git clone -q "$REPO" "$DESTINO"
fi
cd "$DESTINO"
mkdir -p cache
chown -R 1000:1000 cache
ok "código em $DESTINO"

azul "5/6 Configuração (.env)"
if [ -f .env ]; then
  ok ".env já existe — mantido. (Para refazer: apague com  rm $DESTINO/.env  e rode de novo.)"
else
  echo "Vou fazer 3 perguntas. Cole as respostas e aperte Enter."
  read -r -p "Endereço do entregador [fotos.startfotos.com.br]: " DOMINIO </dev/tty
  DOMINIO="${DOMINIO:-fotos.startfotos.com.br}"
  while :; do
    read -r -s -p "FOTO_SECRET (o MESMO da Vercel; não aparece ao digitar): " FOTO_SECRET </dev/tty; echo
    [ "${#FOTO_SECRET}" -ge 16 ] && break
    erro "Muito curto. Copie da Vercel (Environment Variables → FOTO_SECRET)."
  done
  while :; do
    read -r -p "GOOGLE_SERVICE_ACCOUNT_JSON (o JSON inteiro em UMA linha): " SA_JSON </dev/tty
    case "$SA_JSON" in
      \{*private_key*client_email*\}|\{*client_email*private_key*\}) break ;;
    esac
    erro "Não parece o JSON da conta de serviço. Tem que começar com { e ter client_email e private_key."
  done
  read -r -p "Tamanho máximo do cache em GB [60]: " CACHE_MAX_GB </dev/tty
  CACHE_MAX_GB="${CACHE_MAX_GB:-60}"
  umask 077
  {
    printf 'DOMINIO=%s\n' "$DOMINIO"
    printf 'FOTO_SECRET=%s\n' "$FOTO_SECRET"
    printf 'GOOGLE_SERVICE_ACCOUNT_JSON=%s\n' "$SA_JSON"
    printf 'CACHE_MAX_GB=%s\n' "$CACHE_MAX_GB"
    printf 'LOG=normal\n'
  } >.env
  chmod 600 .env
  ok ".env gravado (só o root lê)"
fi

azul "6/6 Subindo (a primeira vez baixa as imagens; 1–3 min)"
docker compose up -d --build --quiet-pull 2>&1 | grep -v -e '^$' || true
sleep 8
if docker compose exec -T entregador wget -qO- http://127.0.0.1:8080/saude | grep -q '"ok": true'; then
  ok "entregador respondendo e falando com o Google Drive"
else
  erro "O entregador subiu mas /saude não deu ok. Veja:  docker compose logs entregador --tail 50"
  docker compose exec -T entregador wget -qO- http://127.0.0.1:8080/saude || true
fi

DOM=$(grep -E '^DOMINIO=' .env | cut -d= -f2-)
IP=$(curl -fsS -4 https://api.ipify.org || hostname -I | awk '{print $1}')
cat <<EOF

================================================================
 Pronto. Agora:
 1) No DNS (Cloudflare), crie o registro A:  $DOM  →  $IP   (nuvem CINZA)
 2) Espere uns minutos e abra  https://$DOM/saude  (tem que mostrar "ok": true)
 3) Na Vercel, crie NEXT_PUBLIC_FOTOS_BASE = https://$DOM  e faça um redeploy

 Comandos úteis (sempre dentro de $DESTINO):
   docker compose logs -f entregador      ver o que está acontecendo
   docker compose ps                      ver se está no ar
   bash atualizar.sh                      atualizar para a versão nova
================================================================
EOF
