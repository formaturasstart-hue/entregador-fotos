# Entregador de fotos da Start

Servidor pequeno (Node 22, sem dependências) que entrega as fotos do sistema **Agenda de Álbuns**
a partir de uma VPS, em vez da Vercel. Passo a passo de instalação para o Mateus: `docs/ENTREGADOR.md`
no projeto principal.

## O que ele faz

| Endereço | O que é |
|---|---|
| `GET /api/foto/<id>?s=320\|640\|1600\|orig&a=<assinatura>[&dl=nome]` | A mesma rota que existe na Vercel. Confere a assinatura (HMAC do id com `FOTO_SECRET`), busca no Google Drive (só leitura), **guarda uma cópia no disco** e entrega. Da segunda vez sai do disco (`X-Cache: HIT`). `/foto/<id>` também funciona. |
| `GET /zip?ids=a,b,c&exp=<unix>&nome=<arquivo>&pasta=<subpasta>&a=<assinatura>` | ZIP das fotos originais em streaming. O link é gerado pelo sistema (`urlZipEntregador`, vale 1 h): a Vercel valida o formando e redireciona para cá. |
| `GET /saude` | JSON com `ok`, teste do Drive, disco e contadores. 200 ok / 503 problema. É o que o vigia da página de status olha. |

- O sistema aponta para cá quando `NEXT_PUBLIC_FOTOS_BASE` está definido na Vercel. Sem a variável, nada muda.
- `FOTO_SECRET` tem que ser **o mesmo** nos dois lados.
- Cache em `cache/<2 letras>/<id>.<tamanho>` (+ `.meta` com o tipo). Faxina a cada 15 min: acima de `CACHE_MAX_GB`
  apaga os menos usados; com menos de `RESERVA_DISCO_GB` livres, entrega sem guardar (`X-Cache: BYPASS`).
- Pedidos simultâneos da mesma foto viram **um** download. No máximo `DRIVE_SIMULTANEOS` (12) conexões com o Drive.
- Limite por IP: 3 000 pedidos/min e 600 fotos novas/min (o que já está no disco não conta). Acima disso, 429.
- Miniaturas: `Cache-Control: public, max-age=604800, immutable`; originais: `public, max-age=86400`. CORS aberto
  (`*`), porque as fotos entram no `<canvas>` do diagramador. Os links continuam protegidos pela assinatura.

## Arquivos

| Arquivo | Para quê |
|---|---|
| `servidor.mjs` | o servidor (rotas, cache, limites, saúde) |
| `drive.mjs` | token OAuth da conta de serviço (JWT assinado na mão) e chamadas ao Drive v3 |
| `zip.mjs` | ZIP em streaming (mesmo formato do `src/lib/zip-stream.ts` do sistema) |
| `Dockerfile`, `compose.yml`, `Caddyfile` | contêineres: entregador + Caddy (HTTPS automático) |
| `instalar.sh` | instala tudo numa VPS Ubuntu zerada (Docker, firewall, atualizações automáticas, `.env`, sobe) |
| `atualizar.sh` | `git pull` + reconstrói o contêiner do entregador |
| `testar.mjs`, `testar-estresse.mjs` | testes com um Drive falso: `node testar.mjs` e `node testar-estresse.mjs` |
| `.env.exemplo` | modelo do `.env` (o `.env` de verdade nunca vai para o GitHub) |

## Variáveis (.env)

| Nome | Obrigatória | O que é |
|---|---|---|
| `DOMINIO` | sim | ex.: `fotos.startfotos.com.br` (o Caddy pede o certificado para ele) |
| `FOTO_SECRET` | sim | igual ao da Vercel |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | sim | o JSON da conta de serviço em uma linha (igual ao da Vercel) |
| `CACHE_MAX_GB` | não (60) | teto do cache |
| `RESERVA_DISCO_GB` | não (3) | abaixo disso não guarda |
| `DRIVE_SIMULTANEOS` | não (12) | downloads simultâneos do Drive |
| `MAX_ZIP` | não (200) | fotos por ZIP |
| `LOG` | não | `detalhado` registra também os acertos de cache |

## Operação (na VPS, em `/opt/entregador`)

```
docker compose ps                     # está no ar?
docker compose logs -f entregador     # acompanhar
docker compose logs -f caddy          # certificado/HTTPS
bash atualizar.sh                     # nova versão
docker compose restart entregador     # reiniciar
du -sh cache                          # quanto o cache ocupa
```

Desligar o entregador sem derrubar nada: apague `NEXT_PUBLIC_FOTOS_BASE` na Vercel e faça um redeploy —
as fotos voltam a sair da Vercel na hora. O cache pode ser apagado a qualquer momento (`rm -rf cache/*`);
ele se refaz sozinho.
