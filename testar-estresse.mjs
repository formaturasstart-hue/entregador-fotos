// Testes de carga e de falha do entregador (Drive falso). Roda com:  node testar-estresse.mjs
// Cobre: 300 pedidos ao mesmo tempo, original de 40 MB, Drive lento/quebrado, disco cheio,
// cliente desistindo no meio do ZIP, limite por IP e memória do processo.
import http from "node:http";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const SEGREDO = "segredo-de-teste-bem-comprido-123456";
const hmac = (t) => createHmac("sha256", SEGREDO).update(t).digest("hex").slice(0, 32);
const JPEG = Buffer.alloc(40_000, 3);
const GRANDE = Buffer.alloc(40 * 1024 * 1024, 5); // 40 MB
let simultaneos = 0, picoSimultaneos = 0;
const chamadas = { meta: 0, thumb: 0, orig: 0 };
let falhas = 0;
const confere = (nome, cond, extra = "") => {
  console.log(`${cond ? "✔" : "✘"} ${nome}${extra ? ` — ${extra}` : ""}`);
  if (!cond) falhas++;
};

const drive = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  simultaneos++;
  picoSimultaneos = Math.max(picoSimultaneos, simultaneos);
  res.on("close", () => simultaneos--);
  const m = u.pathname.match(/\/files\/([\w-]+)$/);
  if (u.pathname.endsWith("/about")) return res.writeHead(200, { "content-type": "application/json" }).end("{}");
  if (m && u.searchParams.get("alt") === "media") {
    chamadas.orig++;
    if (m[1].startsWith("lento")) return setTimeout(() => res.writeHead(200).end(JPEG), 400_000); // nunca responde a tempo
    if (m[1].startsWith("quebra")) {
      res.writeHead(200, { "content-type": "image/jpeg", "content-length": "100000" });
      res.write(Buffer.alloc(1000));
      return setTimeout(() => res.destroy(), 50); // conexão cai no meio
    }
    if (m[1].startsWith("erro500")) return res.writeHead(500).end("boom");
    if (m[1].startsWith("grande")) {
      res.writeHead(200, { "content-type": "image/jpeg" });
      for (let i = 0; i < GRANDE.length; i += 1024 * 1024) {
        if (!res.write(GRANDE.subarray(i, i + 1024 * 1024))) await new Promise((r) => res.once("drain", r));
      }
      return res.end();
    }
    return res.writeHead(200, { "content-type": "image/jpeg" }).end(JPEG);
  }
  if (m) {
    chamadas.meta++;
    await new Promise((r) => setTimeout(r, 30)); // um pouco de latência real
    return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ name: `${m[1]}.jpg`, thumbnailLink: `http://127.0.0.1:${portaDrive}/thumb/${m[1]}=s220` }));
  }
  if (u.pathname.startsWith("/thumb/")) {
    chamadas.thumb++;
    await new Promise((r) => setTimeout(r, 30));
    return res.writeHead(200, { "content-type": "image/jpeg" }).end(JPEG);
  }
  res.writeHead(404).end();
});
await new Promise((r) => drive.listen(0, "127.0.0.1", r));
const portaDrive = drive.address().port;

async function subir(extraEnv = {}) {
  const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "entregador-estresse-"));
  const porta = 20000 + Math.floor(Math.random() * 5000);
  const proc = spawn(process.execPath, ["servidor.mjs"], {
    cwd: import.meta.dirname,
    env: { ...process.env, PORTA: String(porta), CACHE_DIR: cacheDir, FOTO_SECRET: SEGREDO, DRIVE_TOKEN_TESTE: "t", DRIVE_API_BASE: `http://127.0.0.1:${portaDrive}/drive/v3`, GOOGLE_SERVICE_ACCOUNT_JSON: '{"client_email":"a","private_key":"b"}', ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  proc.stdout.on("data", (d) => (log += d));
  proc.stderr.on("data", (d) => (log += d));
  await new Promise((r) => setTimeout(r, 600));
  return { proc, cacheDir, base: `http://127.0.0.1:${porta}`, log: () => log, parar: async () => { proc.kill("SIGTERM"); await new Promise((r) => setTimeout(r, 300)); await fsp.rm(cacheDir, { recursive: true, force: true }); } };
}
const rss = async (pid) => Number((await fsp.readFile(`/proc/${pid}/status`, "utf8")).match(/VmRSS:\s+(\d+)/)[1]) / 1024;
const foto = (base, id, s, extra = "") => fetch(`${base}/api/foto/${id}?s=${s}&a=${hmac(`foto:${id}`)}${extra}`);

// ---------------------------------------------------------------- carga
{
  const e = await subir();
  const t0 = Date.now();
  const ids = Array.from({ length: 50 }, (_, i) => `fotoXXXX${String(i).padStart(4, "0")}`);
  const pedidos = [];
  for (let k = 0; k < 300; k++) pedidos.push(foto(e.base, ids[k % 50], [320, 640, 1600][k % 3]).then(async (r) => ({ status: r.status, len: (await r.arrayBuffer()).byteLength })));
  const resultados = await Promise.all(pedidos);
  const ms = Date.now() - t0;
  confere("300 pedidos simultâneos (50 fotos × 3 tamanhos) → todos 200 com o conteúdo certo", resultados.every((r) => r.status === 200 && r.len === JPEG.length), `${ms} ms`);
  confere("idas ao Drive = 150 miniaturas (uma por foto/tamanho), não 300", chamadas.thumb === 150, `${chamadas.thumb}`);
  confere("no máximo 12 conexões simultâneas com o Drive (semáforo)", picoSimultaneos <= 12, `pico ${picoSimultaneos}`);
  const t1 = Date.now();
  const de2 = await Promise.all(pedidos.map((_, k) => foto(e.base, ids[k % 50], [320, 640, 1600][k % 3]).then((r) => r.headers.get("x-cache"))));
  confere("mesmos 300 de novo → tudo HIT, rápido", de2.every((x) => x === "HIT") && chamadas.thumb === 150, `${Date.now() - t1} ms`);
  const mem = await rss(e.proc.pid);
  confere("memória do processo após a carga < 150 MB", mem < 150, `${mem.toFixed(0)} MB`);
  await e.parar();
}

// ---------------------------------------------------------------- original grande (40 MB) em streaming
{
  const e = await subir();
  const antes = await rss(e.proc.pid);
  const t0 = Date.now();
  const r = await foto(e.base, "grande0000001", "orig");
  const corpo = Buffer.from(await r.arrayBuffer());
  const durante = await rss(e.proc.pid);
  confere("original de 40 MB → bytes íntegros", r.status === 200 && corpo.length === GRANDE.length && corpo.equals(GRANDE), `${Date.now() - t0} ms`);
  confere("40 MB não ficam na memória (cresceu < 60 MB)", durante - antes < 60, `antes ${antes.toFixed(0)} MB, depois ${durante.toFixed(0)} MB`);
  const r2 = await foto(e.base, "grande0000001", "orig");
  const c2 = Buffer.from(await r2.arrayBuffer());
  confere("40 MB do cache: HIT e Content-Length certo", r2.headers.get("x-cache") === "HIT" && Number(r2.headers.get("content-length")) === GRANDE.length && c2.length === GRANDE.length);
  // 10 downloads simultâneos do mesmo original grande ainda não cacheado
  const t1 = Date.now();
  const lote = await Promise.all(Array.from({ length: 10 }, () => foto(e.base, "grande0000002", "orig").then(async (x) => (await x.arrayBuffer()).byteLength)));
  confere("10 pedidos simultâneos do mesmo original grande → 1 download, 10 entregas íntegras", lote.every((n) => n === GRANDE.length) && chamadas.orig === 2, `${Date.now() - t1} ms, orig=${chamadas.orig}`);
  await e.parar();
}

// ---------------------------------------------------------------- Drive com problemas
{
  const e = await subir({ DRIVE_SIMULTANEOS: "4" });
  const r500 = await foto(e.base, "erro5000001", "orig");
  confere("Drive devolve 500 → 502 para o cliente, sem cache", r500.status === 502 && r500.headers.get("cache-control") === "no-store");
  const rq = await foto(e.base, "quebra000001", "orig");
  const bq = await rq.arrayBuffer().catch(() => null);
  confere("conexão com o Drive cai no meio → erro, não arquivo pela metade", rq.status !== 200 || bq === null);
  const sobras = (await fsp.readdir(path.join(e.cacheDir, "qu")).catch(() => [])).filter((f) => !f.endsWith(".meta"));
  confere("nenhum arquivo quebrado ficou no cache", sobras.length === 0, JSON.stringify(sobras));
  // Drive lento não trava os outros: 4 vagas no semáforo, 2 lentos ocupam 2, os normais passam
  const lentos = [foto(e.base, "lento0000001", "orig"), foto(e.base, "lento0000002", "orig")];
  await new Promise((r) => setTimeout(r, 200));
  const t0 = Date.now();
  const normal = await foto(e.base, "normal000001", 320);
  await normal.arrayBuffer();
  confere("Drive lento em 2 fotos não trava as outras", normal.status === 200 && Date.now() - t0 < 3000, `${Date.now() - t0} ms`);
  lentos.forEach((p) => p.then((r) => r.arrayBuffer().catch(() => {})).catch(() => {}));
  const depois = await foto(e.base, "normal000002", 320);
  confere("servidor continua respondendo normalmente", depois.status === 200);
  await e.parar();
}

// ---------------------------------------------------------------- disco cheio → entrega sem guardar
{
  const e = await subir({ RESERVA_DISCO_GB: "100000" }); // reserva impossível = "disco cheio"
  const r = await foto(e.base, "semdisco0001", 640);
  const b = Buffer.from(await r.arrayBuffer());
  confere("disco cheio → entrega mesmo assim (X-Cache BYPASS), bytes certos", r.status === 200 && r.headers.get("x-cache") === "BYPASS" && b.equals(JPEG));
  const arquivos = await fsp.readdir(e.cacheDir);
  confere("…e não gravou nada no disco", arquivos.length === 0, JSON.stringify(arquivos));
  const s = await (await fetch(`${e.base}/saude`)).json();
  confere("/saude continua ok (disco cheio só desliga o cache)", s.ok === true);
  await e.parar();
}

// ---------------------------------------------------------------- cliente desiste no meio do ZIP
{
  const e = await subir();
  const ids = Array.from({ length: 6 }, (_, i) => `grandeZZZ${String(i).padStart(4, "0")}`);
  const exp = Math.floor(Date.now() / 1000) + 600;
  const url = `${e.base}/zip?ids=${ids.join(",")}&exp=${exp}&nome=teste&a=${hmac(`zip:${exp}:${ids.join(",")}`)}`;
  const ctl = new AbortController();
  const r = await fetch(url, { signal: ctl.signal });
  const leitor = r.body.getReader();
  let lidos = 0;
  while (lidos < 3 * 1024 * 1024) {
    const { value, done } = await leitor.read();
    if (done) break;
    lidos += value.length;
  }
  ctl.abort();
  await new Promise((r) => setTimeout(r, 800));
  const mem = await rss(e.proc.pid);
  const vivo = await fetch(`${e.base}/saude`).then((x) => x.status).catch(() => 0);
  confere("cliente desistiu no meio do ZIP → servidor segue vivo", vivo === 200 && /zip interrompido|cliente desconectou/.test(e.log()), `memória ${mem.toFixed(0)} MB`);
  // ZIP completo de 3 originais grandes (120 MB) com memória estável
  const ids3 = ids.slice(0, 3);
  const url3 = `${e.base}/zip?ids=${ids3.join(",")}&exp=${exp}&nome=teste3&a=${hmac(`zip:${exp}:${ids3.join(",")}`)}`;
  const t0 = Date.now();
  const r3 = await fetch(url3);
  let total = 0;
  const l3 = r3.body.getReader();
  for (;;) {
    const { value, done } = await l3.read();
    if (done) break;
    total += value.length;
  }
  const mem3 = await rss(e.proc.pid);
  confere("ZIP de 3 originais de 40 MB → tamanho esperado, memória < 200 MB", total > 3 * GRANDE.length && total < 3 * GRANDE.length + 2000 && mem3 < 200, `${(total / 1e6).toFixed(0)} MB em ${Date.now() - t0} ms, memória ${mem3.toFixed(0)} MB`);
  await e.parar();
}

// ---------------------------------------------------------------- limite por IP
{
  // a janela do limite é "o minuto do relógio": espera o começo de um para o teste não cruzar a fronteira
  const seg = new Date().getSeconds();
  if (seg > 35) await new Promise((r) => setTimeout(r, (61 - seg) * 1000));
  const e = await subir();
  let r429 = 0, r200 = 0;
  // 650 fotos diferentes do mesmo IP no mesmo minuto → a partir da 601ª ida ao Drive, 429
  for (let lote = 0; lote < 13; lote++) {
    const rs = await Promise.all(Array.from({ length: 50 }, (_, i) => foto(e.base, `ip${String(lote * 50 + i).padStart(10, "0")}`, 320).then(async (r) => { await r.arrayBuffer(); return r.status; })));
    for (const s of rs) {
      if (s === 429) r429++;
      else if (s === 200) r200++;
    }
  }
  confere("abuso: 650 fotos novas num minuto → ~600 passam e o resto leva 429", r200 >= 590 && r200 <= 610 && r429 >= 40, `200=${r200} 429=${r429}`);
  const hit = await foto(e.base, "ip0000000001", 320);
  confere("…mas fotos já em cache continuam sendo entregues (HIT não conta como abuso)", hit.status === 200 && hit.headers.get("x-cache") === "HIT");
  await e.parar();
}

drive.close();
console.log(falhas ? `\n${falhas} teste(s) falharam` : "\nTudo certo no estresse.");
process.exit(falhas ? 1 : 0);
