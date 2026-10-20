// Entregador de fotos da Start (19/10/2026) — roda numa VPS, fora da Vercel.
//
// O que ele faz: recebe os mesmos links de foto que o sistema já gera
// (/api/foto/<id>?s=320|640|1600|orig&a=<assinatura>), confere a assinatura
// com o MESMO segredo (FOTO_SECRET), busca a foto no Google Drive (só leitura),
// guarda uma cópia no disco e entrega. Na segunda vez, sai direto do disco:
// mais rápido para o formando e sem gastar o tráfego da Vercel.
//
// Também monta o ZIP da galeria (/zip) com link assinado pelo sistema.
// Sem bibliotecas de fora: só Node 22. Veja README.md.
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { baixarMiniatura, baixarOriginal, metadados, testarDrive, emailContaServico } from "./drive.mjs";
import { montarZip } from "./zip.mjs";

const VERSAO = "1.0.0";
const PORTA = Number(process.env.PORTA || 8080);
const CACHE_DIR = path.resolve(process.env.CACHE_DIR || "./cache");
const CACHE_MAX = (Number(process.env.CACHE_MAX_GB) || 60) * 1e9; // apaga os mais antigos acima disso
const RESERVA_DISCO = (Number(process.env.RESERVA_DISCO_GB) || 3) * 1e9; // abaixo disso, não guarda mais nada
const MAX_ZIP = Number(process.env.MAX_ZIP || 200);
const DRIVE_SIMULTANEOS = Number(process.env.DRIVE_SIMULTANEOS || 12);
const LOG_DETALHADO = process.env.LOG === "detalhado";
const TAMANHOS = new Set([320, 640, 1600]);
const SEGREDO = process.env.FOTO_SECRET;
if (!SEGREDO || SEGREDO.length < 16) {
  console.error("[entregador] FOTO_SECRET ausente ou curto demais. Tem que ser IGUAL ao da Vercel.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Assinaturas (iguais a src/lib/assinatura.ts do sistema)
// ---------------------------------------------------------------------------
const hmac = (texto) => createHmac("sha256", SEGREDO).update(texto).digest("hex").slice(0, 32);
function igual(a, b) {
  if (!a || !b || a.length !== 32 || b.length !== 32) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
const assinaturaFotoValida = (id, a) => igual(hmac(`foto:${id}`), a);
const assinaturaZipValida = (ids, exp, a) => igual(hmac(`zip:${exp}:${ids.join(",")}`), a);
const ID_OK = /^[\w-]{10,}$/;

// ---------------------------------------------------------------------------
// Contadores (aparecem em /saude)
// ---------------------------------------------------------------------------
const contadores = { inicio: new Date().toISOString(), hits: 0, misses: 0, erros: 0, zips: 0, bytes_servidos: 0, bytes_drive: 0, recusados: 0 };
let disco = { livre: null, cache_bytes: 0, cache_arquivos: 0, varrido_em: null };

// ---------------------------------------------------------------------------
// Limite de pedidos por IP (protege a cota do Drive se alguém sair baixando tudo)
// ---------------------------------------------------------------------------
const janelaPorIp = new Map(); // ip -> { minuto, total, misses }
function controlarIp(ip, miss) {
  const minuto = Math.floor(Date.now() / 60_000);
  let j = janelaPorIp.get(ip);
  if (!j || j.minuto !== minuto) {
    j = { minuto, total: 0, misses: 0 };
    janelaPorIp.set(ip, j);
  }
  j.total++;
  if (miss) j.misses++;
  // fotos já guardadas passam sempre (só o que vai ao Drive conta como abuso)
  return j.total <= 3000 && (!miss || j.misses <= 600);
}
setInterval(() => {
  const minuto = Math.floor(Date.now() / 60_000);
  for (const [ip, j] of janelaPorIp) if (j.minuto !== minuto) janelaPorIp.delete(ip);
}, 60_000).unref();

// ---------------------------------------------------------------------------
// Semáforo: no máximo N downloads do Drive ao mesmo tempo
// ---------------------------------------------------------------------------
let ocupados = 0;
const fila = [];
async function comVaga(fn) {
  if (ocupados >= DRIVE_SIMULTANEOS) await new Promise((r) => fila.push(r));
  ocupados++;
  try {
    return await fn();
  } finally {
    ocupados--;
    fila.shift()?.();
  }
}

// ---------------------------------------------------------------------------
// Cache em disco: <CACHE_DIR>/<2 primeiras letras do id>/<id>.<tamanho> (+ .meta com o tipo)
// ---------------------------------------------------------------------------
const caminhoCache = (chave) => path.join(CACHE_DIR, chave.slice(0, 2), chave);
const emAndamento = new Map(); // chave -> Promise<{ arq, tipo } | null>

async function cacheDisponivel() {
  if (disco.livre === null) await medirDisco();
  return disco.livre > RESERVA_DISCO;
}
async function medirDisco() {
  try {
    const s = await fsp.statfs(CACHE_DIR);
    disco.livre = Number(s.bavail) * Number(s.bsize);
  } catch {
    disco.livre = 0;
  }
}

/** Devolve { arq, tipo } do cache, baixando do Drive se precisar. null = sem miniatura. */
function obterDoCache(chave, abrir) {
  const arq = caminhoCache(chave);
  const pronto = emAndamento.get(chave);
  if (pronto) return pronto;
  const p = (async () => {
    try {
      const [st, meta] = await Promise.all([fsp.stat(arq), fsp.readFile(`${arq}.meta`, "utf8")]);
      fsp.utimes(arq, new Date(), new Date()).catch(() => {}); // marca como usado (o faxineiro apaga os mais antigos)
      contadores.hits++;
      return { arq, tipo: JSON.parse(meta).tipo, tamanho: st.size, hit: true };
    } catch {
      /* não está no cache */
    }
    return comVaga(async () => {
      const r = await abrir();
      if (!r) return null;
      const tipo = r.headers.get("content-type") || "image/jpeg";
      contadores.misses++;
      if (!(await cacheDisponivel())) return { direto: r, tipo }; // disco cheio: entrega sem guardar
      await fsp.mkdir(path.dirname(arq), { recursive: true });
      const tmp = `${arq}.tmp-${randomBytes(4).toString("hex")}`;
      try {
        await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(tmp));
        const st = await fsp.stat(tmp);
        await fsp.writeFile(`${arq}.meta`, JSON.stringify({ tipo }));
        await fsp.rename(tmp, arq);
        contadores.bytes_drive += st.size;
        disco.livre -= st.size;
        return { arq, tipo, tamanho: st.size, hit: false };
      } catch (e) {
        fsp.unlink(tmp).catch(() => {});
        throw e;
      }
    });
  })().finally(() => emAndamento.delete(chave));
  emAndamento.set(chave, p);
  return p;
}

// Faxineiro: a cada 15 min mede o cache e apaga os menos usados quando passa do limite
async function faxina() {
  const t0 = Date.now();
  const arquivos = [];
  let total = 0;
  const umaHora = Date.now() - 3600_000;
  async function andar(dir) {
    let itens;
    try {
      itens = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of itens) {
      const p = path.join(dir, it.name);
      if (it.isDirectory()) await andar(p);
      else if (it.name.includes(".tmp-")) {
        const st = await fsp.stat(p).catch(() => null);
        if (st && st.mtimeMs < umaHora) fsp.unlink(p).catch(() => {});
      } else if (!it.name.endsWith(".meta")) {
        const st = await fsp.stat(p).catch(() => null);
        if (!st) continue;
        arquivos.push({ p, tamanho: st.size, mtime: st.mtimeMs });
        total += st.size;
      }
    }
  }
  await andar(CACHE_DIR);
  let apagados = 0;
  if (total > CACHE_MAX) {
    arquivos.sort((a, b) => a.mtime - b.mtime);
    const alvo = CACHE_MAX * 0.9;
    for (const a of arquivos) {
      if (total <= alvo) break;
      await fsp.unlink(a.p).catch(() => {});
      await fsp.unlink(`${a.p}.meta`).catch(() => {});
      total -= a.tamanho;
      apagados++;
    }
  }
  await medirDisco();
  disco = { ...disco, cache_bytes: total, cache_arquivos: arquivos.length - apagados, varrido_em: new Date().toISOString() };
  console.log(`[entregador] faxina: ${arquivos.length - apagados} arquivos, ${(total / 1e9).toFixed(2)} GB em cache, ${apagados} apagados, livre ${(disco.livre / 1e9).toFixed(1)} GB (${Date.now() - t0} ms)`);
}
setTimeout(() => faxina().catch((e) => console.error("[entregador] faxina falhou:", e.message)), 10_000).unref();
setInterval(() => faxina().catch((e) => console.error("[entregador] faxina falhou:", e.message)), 15 * 60_000).unref();

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const CABECALHOS_COMUNS = {
  "X-Content-Type-Options": "nosniff",
  "Access-Control-Allow-Origin": "*", // as fotos entram no <canvas> do diagramador (crossOrigin="anonymous")
  "Cross-Origin-Resource-Policy": "cross-origin",
  "Timing-Allow-Origin": "*",
};
const texto = (res, status, msg, extra = {}) => {
  res.writeHead(status, { ...CABECALHOS_COMUNS, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...extra });
  res.end(msg);
};
const nomeSeguro = (n, padrao) => (n || "").replace(/[^\w.\-]+/g, "_").slice(0, 120) || padrao;
const ipDe = (req) => (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";

function escreverComPausa(res) {
  let fechado = false;
  let pendente = null; // quem está esperando o "drain" quando o cliente some
  res.on("close", () => {
    fechado = true;
    pendente?.(new Error("cliente desconectou"));
    pendente = null;
  });
  return (bytes) =>
    new Promise((resolve, reject) => {
      if (fechado) return reject(new Error("cliente desconectou"));
      if (res.write(bytes)) return resolve();
      pendente = reject;
      res.once("drain", () => {
        pendente = null;
        resolve();
      });
    });
}

async function servirArquivo(req, res, item, cabecalhos) {
  if (item.direto) {
    // disco cheio: repassa do Drive sem guardar
    res.writeHead(200, { ...cabecalhos, "Content-Type": item.tipo, "X-Cache": "BYPASS" });
    if (req.method === "HEAD") return res.end();
    await pipeline(Readable.fromWeb(item.direto.body), res);
    return;
  }
  res.writeHead(200, { ...cabecalhos, "Content-Type": item.tipo, "Content-Length": item.tamanho, "X-Cache": item.hit ? "HIT" : "MISS" });
  if (req.method === "HEAD") return res.end();
  await pipeline(fs.createReadStream(item.arq), res);
  contadores.bytes_servidos += item.tamanho;
}

async function rotaFoto(req, res, id, q) {
  if (!ID_OK.test(id) || !assinaturaFotoValida(id, q.get("a"))) {
    contadores.recusados++;
    return texto(res, 403, "Não autorizado");
  }
  const sParam = q.get("s") ?? "640";
  const orig = sParam === "orig";
  const tamanho = orig ? "orig" : TAMANHOS.has(Number(sParam)) ? Number(sParam) : 640;
  const chave = `${id}.${tamanho}`;
  const ip = ipDe(req);
  const noCache = emAndamento.has(chave) || (await fsp.stat(caminhoCache(chave)).catch(() => null));
  if (!controlarIp(ip, !noCache)) {
    contadores.recusados++;
    return texto(res, 429, "Muitos pedidos; tente de novo em um minuto.", { "Retry-After": "60" });
  }
  const t0 = Date.now();
  const abrir = orig ? () => baixarOriginal(id) : async () => (await baixarMiniatura(id, tamanho)) ?? baixarOriginal(id);
  const item = await obterDoCache(chave, abrir);
  if (!item) return texto(res, 404, "Foto sem miniatura");
  const cabecalhos = {
    ...CABECALHOS_COMUNS,
    "Cache-Control": orig ? "public, max-age=86400" : "public, max-age=604800, immutable",
  };
  const dl = q.get("dl");
  if (dl) cabecalhos["Content-Disposition"] = `attachment; filename="${nomeSeguro(dl, "foto.jpg")}"`;
  if (LOG_DETALHADO || !item.hit) console.log(`[entregador] ${item.hit ? "HIT " : item.direto ? "PASS" : "MISS"} ${String(tamanho).padEnd(4)} ${id} ${Date.now() - t0} ms ${item.tamanho ? Math.round(item.tamanho / 1024) + " KB" : ""}`);
  await servirArquivo(req, res, item, cabecalhos);
}

async function rotaZip(req, res, q) {
  const ids = (q.get("ids") ?? "").split(",").map((s) => s.trim()).filter((s) => ID_OK.test(s));
  const exp = Number(q.get("exp"));
  if (!ids.length) return texto(res, 400, "Nada para baixar");
  if (ids.length > MAX_ZIP) return texto(res, 400, `No máximo ${MAX_ZIP} fotos por ZIP`);
  if (!exp || exp * 1000 < Date.now()) return texto(res, 403, "Link vencido; volte à galeria e baixe de novo.");
  if (!assinaturaZipValida(ids, exp, q.get("a"))) {
    contadores.recusados++;
    return texto(res, 403, "Não autorizado");
  }
  if (!controlarIp(ipDe(req), true)) return texto(res, 429, "Muitos pedidos; tente de novo em um minuto.", { "Retry-After": "60" });
  const pasta = (q.get("pasta") || "").replace(/[\\:*?"<>|/]/g, "_").trim();
  const nomeZip = nomeSeguro(q.get("nome"), "fotos.zip").replace(/(\.zip)?$/i, ".zip");

  // nomes dos arquivos (até 6 consultas ao mesmo tempo); quem falhar fica de fora
  const nomes = new Array(ids.length).fill(null);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(6, ids.length) }, async () => {
      for (;;) {
        const k = i++;
        if (k >= ids.length) return;
        nomes[k] = await metadados(ids[k]).then((m) => m.name || `${ids[k]}.jpg`).catch(() => null);
      }
    }),
  );
  const entradas = ids
    .map((id, k) => ({ id, nome: nomes[k] }))
    .filter((e) => e.nome)
    .map((e) => ({
      nome: pasta ? `${pasta}/${e.nome}` : e.nome,
      abrir: async () => {
        try {
          const item = await obterDoCache(`${e.id}.orig`, () => baixarOriginal(e.id));
          if (!item) return null;
          if (item.direto) return item.direto.body;
          contadores.bytes_servidos += item.tamanho;
          return Readable.toWeb(fs.createReadStream(item.arq));
        } catch (err) {
          console.warn(`[entregador] zip: pulando ${e.id}: ${err.message}`);
          return null;
        }
      },
    }));
  if (!entradas.length) return texto(res, 404, "Fotos não encontradas");

  res.writeHead(200, {
    ...CABECALHOS_COMUNS,
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="${nomeZip}"`,
    "Cache-Control": "no-store",
  });
  if (req.method === "HEAD") return res.end();
  const t0 = Date.now();
  try {
    const n = await montarZip(entradas, escreverComPausa(res));
    contadores.zips++;
    console.log(`[entregador] ZIP ${n} fotos, ${nomeZip}, ${Math.round((Date.now() - t0) / 1000)} s`);
  } catch (e) {
    console.warn(`[entregador] zip interrompido: ${e.message}`);
  }
  res.end();
}

let saudeDrive = { em: 0, ok: false, ms: 0, detalhe: null };
async function rotaSaude(res) {
  if (Date.now() - saudeDrive.em > 60_000) {
    const t0 = Date.now();
    try {
      await testarDrive();
      saudeDrive = { em: Date.now(), ok: true, ms: Date.now() - t0, detalhe: null };
    } catch (e) {
      saudeDrive = { em: Date.now(), ok: false, ms: Date.now() - t0, detalhe: e.message };
    }
  }
  await medirDisco();
  const discoOk = disco.livre > 1e9;
  const ok = saudeDrive.ok && discoOk;
  res.writeHead(ok ? 200 : 503, { ...CABECALHOS_COMUNS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(
    JSON.stringify(
      {
        ok,
        servico: "entregador-fotos",
        versao: VERSAO,
        verificado_em: new Date().toISOString(),
        drive: { ok: saudeDrive.ok, ms: saudeDrive.ms, detalhe: saudeDrive.detalhe, conta: emailContaServico() },
        disco: { ok: discoOk, livre_gb: +(disco.livre / 1e9).toFixed(2), cache_gb: +(disco.cache_bytes / 1e9).toFixed(2), cache_arquivos: disco.cache_arquivos, limite_gb: CACHE_MAX / 1e9, medido_em: disco.varrido_em },
        contadores,
      },
      null,
      2,
    ),
  );
}

async function tratar(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") return texto(res, 405, "Método não permitido", { Allow: "GET, HEAD" });
  const url = new URL(req.url, "http://x");
  const partes = url.pathname.split("/").filter(Boolean);
  if (partes.length === 0) return texto(res, 200, "Entregador de fotos da Start: ativo.\n");
  if (partes[0] === "saude" && partes.length === 1) return rotaSaude(res);
  if (partes[0] === "zip" && partes.length === 1) return rotaZip(req, res, url.searchParams);
  if ((partes[0] === "foto" && partes.length === 2) || (partes[0] === "api" && partes[1] === "foto" && partes.length === 3)) {
    return rotaFoto(req, res, decodeURIComponent(partes[partes.length - 1]), url.searchParams);
  }
  return texto(res, 404, "Não encontrado");
}

const servidor = http.createServer((req, res) => {
  tratar(req, res).catch((e) => {
    // cliente fechou a aba/cancelou o download no meio: normal, não é erro nosso
    if (e?.code === "ERR_STREAM_PREMATURE_CLOSE" || res.destroyed || /cliente desconectou/.test(e?.message ?? "")) {
      if (LOG_DETALHADO) console.log(`[entregador] cliente desistiu: ${req.url}`);
      return res.destroy();
    }
    contadores.erros++;
    const status = e?.status === 404 ? 404 : e?.status === 403 ? 403 : e?.name === "TimeoutError" ? 504 : 502;
    console.error(`[entregador] ${status} ${req.method} ${req.url}: ${e?.message || e}`);
    if (!res.headersSent) texto(res, status, status === 504 ? "O Drive demorou demais para responder." : e?.message || "erro");
    else res.destroy();
  });
});
servidor.keepAliveTimeout = 65_000;
servidor.headersTimeout = 70_000;
servidor.requestTimeout = 0; // o ZIP pode levar minutos

await fsp.mkdir(CACHE_DIR, { recursive: true });
servidor.listen(PORTA, () => {
  console.log(`[entregador] v${VERSAO} na porta ${PORTA} · cache em ${CACHE_DIR} (até ${CACHE_MAX / 1e9} GB) · conta ${emailContaServico() ?? "(sem credencial!)"}`);
});
for (const sinal of ["SIGTERM", "SIGINT"]) {
  process.on(sinal, () => {
    console.log(`[entregador] ${sinal}: encerrando…`);
    servidor.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
