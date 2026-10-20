// Acesso SOMENTE LEITURA ao Google Drive com a conta de serviço — versão sem bibliotecas.
// Gera o token OAuth na mão (JWT assinado com a chave privada da conta de serviço) e
// chama a API REST do Drive v3 com fetch. Nunca apaga, nunca move: só lê.
import { createSign } from "node:crypto";

const ESCOPO_LEITURA = "https://www.googleapis.com/auth/drive.readonly";
const API = (process.env.DRIVE_API_BASE || "https://www.googleapis.com/drive/v3").replace(/\/$/, "");
const TOKEN_URL = process.env.DRIVE_TOKEN_URL || "https://oauth2.googleapis.com/token";

let credencial = null;
function lerCredencial() {
  if (credencial) return credencial;
  const bruto = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "").trim();
  if (!bruto) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON não definido no .env");
  let j;
  try {
    j = JSON.parse(bruto);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON não é um JSON válido (tem que ser o arquivo inteiro em UMA linha)");
  }
  if (!j.client_email || !j.private_key) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON sem client_email/private_key");
  credencial = { email: j.client_email, chave: j.private_key.replace(/\\n/g, "\n") };
  return credencial;
}

export function emailContaServico() {
  try {
    return lerCredencial().email;
  } catch {
    return null;
  }
}

const b64url = (s) => Buffer.from(s).toString("base64url");

let tokenAtual = null; // { valor, expiraEm }
let pedidoEmAndamento = null;

/** Token OAuth válido por ~1 h; renova sozinho 2 min antes de vencer. */
export async function obterTokenDrive() {
  if (process.env.DRIVE_TOKEN_TESTE) return process.env.DRIVE_TOKEN_TESTE; // só para testes locais
  if (tokenAtual && tokenAtual.expiraEm - Date.now() > 120_000) return tokenAtual.valor;
  if (!pedidoEmAndamento) {
    pedidoEmAndamento = (async () => {
      const { email, chave } = lerCredencial();
      const agora = Math.floor(Date.now() / 1000);
      const cabecalho = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
      const corpo = b64url(JSON.stringify({ iss: email, scope: ESCOPO_LEITURA, aud: TOKEN_URL, iat: agora, exp: agora + 3600 }));
      const assinatura = createSign("RSA-SHA256").update(`${cabecalho}.${corpo}`).sign(chave, "base64url");
      const r = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${cabecalho}.${corpo}.${assinatura}` }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!r.ok) throw new Error(`Google recusou a conta de serviço (HTTP ${r.status}): ${(await r.text()).slice(0, 200)}`);
      const j = await r.json();
      tokenAtual = { valor: j.access_token, expiraEm: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
      return tokenAtual.valor;
    })().finally(() => {
      pedidoEmAndamento = null;
    });
  }
  return pedidoEmAndamento;
}

async function driveGet(caminho, params = {}, timeoutMs = 30_000) {
  const token = await obterTokenDrive();
  const url = new URL(`${API}/${caminho}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("supportsAllDrives", "true");
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs) });
  if (r.status === 404) throw Object.assign(new Error("Foto não encontrada no Drive."), { status: 404 });
  if (r.status === 403) throw Object.assign(new Error("Sem permissão no Drive para este arquivo."), { status: 403 });
  if (!r.ok) throw Object.assign(new Error(`Drive respondeu HTTP ${r.status}.`), { status: 502 });
  return r;
}

/** Metadados básicos (nome, tipo, link de miniatura). */
export async function metadados(fileId) {
  const r = await driveGet(`files/${encodeURIComponent(fileId)}`, { fields: "name,mimeType,size,thumbnailLink" });
  return r.json();
}

/**
 * Miniatura gerada pelo Google (pixels no lado maior). Devolve a Response para streaming.
 * Se o arquivo não tiver miniatura (raro: HEIC/TIFF grandes), devolve null.
 */
export async function baixarMiniatura(fileId, tamanho) {
  const meta = await metadados(fileId);
  if (!meta.thumbnailLink) return null;
  const url = meta.thumbnailLink.replace(/=s\d+(-[a-z]+)*$/i, `=s${tamanho}`);
  const token = await obterTokenDrive();
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw Object.assign(new Error(`Miniatura indisponível (${r.status}).`), { status: 502 });
  return r;
}

/** Arquivo original, em streaming. */
export async function baixarOriginal(fileId) {
  return driveGet(`files/${encodeURIComponent(fileId)}`, { alt: "media" }, 300_000);
}

/** Teste rápido para a página de saúde: a conta de serviço consegue falar com o Drive? */
export async function testarDrive() {
  const r = await driveGet("about", { fields: "user" }, 10_000);
  await r.json();
  return true;
}
