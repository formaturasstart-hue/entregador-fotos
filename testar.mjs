// Teste local do entregador com um Google Drive de mentira. Roda com:  node testar.mjs
// Sobe (1) um Drive falso, (2) o entregador apontando para ele, e confere assinatura,
// cache (2ª vez não bate no Drive), originais, ZIP e /saude. Não precisa de internet.
import http from "node:http";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { crc32 } from "./zip.mjs";

const SEGREDO = "segredo-de-teste-bem-comprido-123456";
const hmac = (t) => createHmac("sha256", SEGREDO).update(t).digest("hex").slice(0, 32);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(5000, 7), Buffer.from([0xff, 0xd9])]);
const ORIG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), Buffer.alloc(300_000, 9), Buffer.from([0xff, 0xd9])]);
const chamadas = { meta: 0, thumb: 0, orig: 0 };

// JPEG mínimo com o tamanho no SOF (e a orientação EXIF opcional), para o teste do giro
function jpegDe(largura, altura, orientacao = 0) {
  const partes = [Buffer.from([0xff, 0xd8])];
  if (orientacao) {
    const tiff = Buffer.alloc(26);
    tiff.write("MM", 0, "latin1");
    tiff.writeUInt16BE(42, 2);
    tiff.writeUInt32BE(8, 4);
    tiff.writeUInt16BE(1, 8);
    tiff.writeUInt16BE(0x0112, 10);
    tiff.writeUInt16BE(3, 12);
    tiff.writeUInt32BE(1, 14);
    tiff.writeUInt16BE(orientacao, 18);
    const corpo = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
    const cab = Buffer.from([0xff, 0xe1, 0, 0]);
    cab.writeUInt16BE(corpo.length + 2, 2);
    partes.push(cab, corpo);
  }
  const sof = Buffer.from([0xff, 0xc0, 0, 17, 8, 0, 0, 0, 0, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  sof.writeUInt16BE(altura, 5);
  sof.writeUInt16BE(largura, 7);
  partes.push(sof, Buffer.from([0xff, 0xda, 0, 2]), Buffer.alloc(800, 5), Buffer.from([0xff, 0xd9]));
  return Buffer.concat(partes);
}
// "giro…"/"velha…": foto em pé (6000×4000 com giro de 90°) cujas miniaturas 320/640 vêm DEITADAS
// e a de 1600 em pé — como a IMG_1871.JPG de 23/11/2026. "exifok…": miniatura deitada nos pixels
// mas com orientação EXIF 6 (o navegador mostra em pé) → não mexe.
const ehGiro = (id) => /^(giro|velha|exifok)/.test(id);
const miniaturaGiro = (id, s) => (id.startsWith("exifok") ? jpegDe(s, Math.round(s / 1.5), 6) : s >= 1600 ? jpegDe(1067, 1600) : jpegDe(s, Math.round(s / 1.5)));

// ---- Drive falso ----
const drive = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (req.headers.authorization !== "Bearer token-teste") return res.writeHead(401).end("sem token");
  const m = u.pathname.match(/^\/drive\/v3\/files\/([\w-]+)$/);
  if (u.pathname === "/drive/v3/about") return res.writeHead(200, { "content-type": "application/json" }).end('{"user":{}}');
  if (m && u.searchParams.get("alt") === "media") {
    chamadas.orig++;
    if (m[1] === "sumiu12345") return res.writeHead(404).end();
    return res.writeHead(200, { "content-type": "image/jpeg" }).end(ORIG);
  }
  if (m) {
    chamadas.meta++;
    if (m[1] === "sumiu12345") return res.writeHead(404).end();
    const semThumb = m[1] === "semthumb123";
    return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ name: `Foto ${m[1]}.jpg`, mimeType: "image/jpeg", ...(ehGiro(m[1]) ? { imageMediaMetadata: { width: 6000, height: 4000, rotation: 1 } } : {}), thumbnailLink: semThumb ? undefined : `http://127.0.0.1:${portaDrive}/thumb/${m[1]}=s220` }));
  }
  if (u.pathname.startsWith("/thumb/")) {
    chamadas.thumb++;
    const [idT, sT] = u.pathname.slice(7).split("=s");
    if (ehGiro(idT)) return res.writeHead(200, { "content-type": "image/jpeg" }).end(miniaturaGiro(idT, Number(sT)));
    return res.writeHead(200, { "content-type": "image/jpeg", "x-tamanho": u.pathname.split("=s")[1] }).end(JPEG);
  }
  res.writeHead(404).end();
});
await new Promise((r) => drive.listen(0, "127.0.0.1", r));
const portaDrive = drive.address().port;

// ---- Entregador ----
const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "entregador-teste-"));
const porta = 18080 + Math.floor(Math.random() * 1000);
const proc = spawn(process.execPath, ["servidor.mjs"], {
  cwd: import.meta.dirname,
  env: { ...process.env, PORTA: String(porta), CACHE_DIR: cacheDir, FOTO_SECRET: SEGREDO, DRIVE_TOKEN_TESTE: "token-teste", DRIVE_API_BASE: `http://127.0.0.1:${portaDrive}/drive/v3`, GOOGLE_SERVICE_ACCOUNT_JSON: '{"client_email":"teste@x","private_key":"x"}' },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
proc.stdout.on("data", (d) => (log += d));
proc.stderr.on("data", (d) => (log += d));
await new Promise((r) => setTimeout(r, 700));

const base = `http://127.0.0.1:${porta}`;
let falhas = 0;
const confere = (nome, cond, extra = "") => {
  console.log(`${cond ? "✔" : "✘"} ${nome}${extra ? ` — ${extra}` : ""}`);
  if (!cond) falhas++;
};
const foto = (id, s, a = hmac(`foto:${id}`), extra = "") => fetch(`${base}/api/foto/${id}?s=${s}&a=${a}${extra}`);

try {
  // assinatura
  confere("sem assinatura → 403", (await foto("abcdefghij1", 320, "")).status === 403);
  confere("assinatura errada → 403", (await foto("abcdefghij1", 320, "0".repeat(32))).status === 403);
  confere("id curto → 403", (await fetch(`${base}/api/foto/abc?s=320&a=${hmac("foto:abc")}`)).status === 403);

  // miniatura: 1ª vez MISS (bate no Drive), 2ª vez HIT (não bate)
  let r = await foto("abcdefghij1", 320);
  let corpo = Buffer.from(await r.arrayBuffer());
  confere("miniatura 320 → 200 image/jpeg", r.status === 200 && r.headers.get("content-type") === "image/jpeg" && corpo.equals(JPEG));
  confere("1ª vez: X-Cache MISS e Drive consultado", r.headers.get("x-cache") === "MISS" && chamadas.thumb === 1);
  confere("cache 7 dias + CORS", r.headers.get("cache-control").includes("604800") && r.headers.get("access-control-allow-origin") === "*");
  r = await foto("abcdefghij1", 320);
  corpo = Buffer.from(await r.arrayBuffer());
  confere("2ª vez: X-Cache HIT, Drive NÃO consultado, mesmo conteúdo", r.headers.get("x-cache") === "HIT" && chamadas.thumb === 1 && corpo.equals(JPEG));
  r = await foto("abcdefghij1", 999);
  confere("tamanho inválido vira 640 (nova chave → MISS)", r.status === 200 && r.headers.get("x-cache") === "MISS" && chamadas.thumb === 2);
  confere("caminho curto /foto/<id> também funciona", (await fetch(`${base}/foto/abcdefghij1?s=320&a=${hmac("foto:abcdefghij1")}`)).headers.get("x-cache") === "HIT");

  // 20 pedidos simultâneos da mesma foto nova → só 1 download
  const antes = chamadas.thumb;
  const lote = await Promise.all(Array.from({ length: 20 }, () => foto("paralela0001", 640)));
  confere("20 pedidos simultâneos → 1 ida ao Drive", lote.every((x) => x.status === 200) && chamadas.thumb === antes + 1, `${chamadas.thumb - antes} ida(s)`);

  // original com download
  r = await foto("abcdefghij1", "orig", undefined, "&dl=Minha%20Foto%20Linda.jpg");
  corpo = Buffer.from(await r.arrayBuffer());
  confere("original → bytes certos + Content-Disposition", corpo.equals(ORIG) && r.headers.get("content-disposition") === 'attachment; filename="Minha_Foto_Linda.jpg"' && chamadas.orig === 1);
  r = await foto("abcdefghij1", "orig");
  await r.arrayBuffer();
  confere("original 2ª vez: HIT", r.headers.get("x-cache") === "HIT" && chamadas.orig === 1);

  // sem miniatura → cai para o original
  r = await foto("semthumb123", 320);
  corpo = Buffer.from(await r.arrayBuffer());
  confere("foto sem miniatura → entrega o original", r.status === 200 && corpo.equals(ORIG));

  // foto inexistente
  r = await foto("sumiu12345", 320);
  confere("foto que não existe → 404", r.status === 404 && r.headers.get("cache-control") === "no-store");

  // HEAD
  r = await fetch(`${base}/api/foto/abcdefghij1?s=320&a=${hmac("foto:abcdefghij1")}`, { method: "HEAD" });
  confere("HEAD responde com Content-Length e sem corpo", r.status === 200 && Number(r.headers.get("content-length")) === JPEG.length && (await r.arrayBuffer()).byteLength === 0);

  // ZIP
  const ids = ["abcdefghij1", "paralela0001", "sumiu12345"];
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const urlZip = (a, e = exp) => `${base}/zip?ids=${ids.join(",")}&exp=${e}&nome=fotos-teste&pasta=BAILE&a=${a}`;
  confere("zip com assinatura errada → 403", (await fetch(urlZip("0".repeat(32)))).status === 403);
  confere("zip vencido → 403", (await fetch(urlZip(hmac(`zip:${exp - 7200}:${ids.join(",")}`), exp - 7200))).status === 403);
  r = await fetch(urlZip(hmac(`zip:${exp}:${ids.join(",")}`)));
  const zip = Buffer.from(await r.arrayBuffer());
  const entradas = zip.toString("latin1").split("PK\x01\x02").length - 1;
  const fim = zip.subarray(zip.length - 22);
  confere("zip → 200 application/zip, 2 fotos (a inexistente pulada), nome certo", r.status === 200 && r.headers.get("content-type") === "application/zip" && entradas === 2 && fim.readUInt16LE(10) === 2 && r.headers.get("content-disposition") === 'attachment; filename="fotos-teste.zip"', `${entradas} entradas`);
  confere("zip: pasta e nome dentro", zip.includes(Buffer.from("BAILE/Foto abcdefghij1.jpg")));
  confere("zip: CRC do original bate", zip.includes(Buffer.from([0x50, 0x4b, 0x07, 0x08, ...Buffer.from(new Uint32Array([crc32(0, ORIG)]).buffer)])));

  // saúde
  r = await fetch(`${base}/saude`);
  const saude = await r.json();
  confere("/saude ok, com disco e contadores", r.status === 200 && saude.ok === true && saude.drive.ok && saude.disco.livre_gb > 0 && saude.contadores.hits >= 3 && saude.contadores.misses >= 3, `hits=${saude.contadores.hits} misses=${saude.contadores.misses}`);
  confere("raiz responde texto", (await (await fetch(base)).text()).includes("ativo"));
  confere("rota desconhecida → 404", (await fetch(`${base}/qualquer`)).status === 404);

  // giro (23/11/2026)
  const { medidasJpeg } = await import("./orientacao.mjs");
  const medidas = async (resp) => medidasJpeg(Buffer.from(await resp.arrayBuffer()));
  let d = await medidas(await foto("giro123456", 640));
  confere("miniatura 640 deitada de foto em pé → entrega a de 1600, em pé", d && d.altura > d.largura, JSON.stringify(d));
  d = await medidas(await foto("giro123456", 640));
  confere("…e a 2ª vez sai do cache já em pé", d && d.altura > d.largura);
  d = await medidas(await foto("exifok12345", 320));
  confere("miniatura com orientação EXIF certa → não troca", d && d.altura > d.largura && d.largura === 213, JSON.stringify(d));
  r = await foto("abcdefghij2", 320);
  confere("foto sem medidas no Drive → entrega como veio", r.status === 200 && Buffer.from(await r.arrayBuffer()).equals(JPEG));

  // cache antigo (antes do giro): a deitada errada é apagada depois de entregue; a em pé só é marcada
  await fsp.mkdir(path.join(cacheDir, "ve"), { recursive: true });
  await fsp.writeFile(path.join(cacheDir, "ve", "velha12345.640"), jpegDe(640, 427));
  await fsp.writeFile(path.join(cacheDir, "ve", "velha12345.640.meta"), JSON.stringify({ tipo: "image/jpeg" }));
  await fsp.writeFile(path.join(cacheDir, "ve", "velha99999.640"), jpegDe(427, 640));
  await fsp.writeFile(path.join(cacheDir, "ve", "velha99999.640.meta"), JSON.stringify({ tipo: "image/jpeg" }));
  const metaAntes = chamadas.meta;
  r = await foto("velha12345", 640);
  d = await medidas(r);
  confere("cache antigo deitado: 1º pedido ainda sai do disco (HIT)", r.headers.get("x-cache") === "HIT" && d.largura > d.altura);
  await foto("velha99999", 640);
  await new Promise((res) => setTimeout(res, 400));
  const sobrou = await fsp.readdir(path.join(cacheDir, "ve"));
  confere("…conferida em segundo plano e apagada do cache", !sobrou.includes("velha12345.640"), sobrou.join(","));
  confere("cache antigo em pé: marcado sem consultar o Drive", JSON.parse(await fsp.readFile(path.join(cacheDir, "ve", "velha99999.640.meta"), "utf8")).giro === 2 && chamadas.meta === metaAntes + 1, `consultas=${chamadas.meta - metaAntes}`);
  r = await foto("velha12345", 640);
  d = await medidas(r);
  confere("…e o próximo pedido baixa de novo, já em pé", r.headers.get("x-cache") === "MISS" && d.altura > d.largura);

  // arquivos no disco
  const arquivos = await fsp.readdir(path.join(cacheDir, "ab"));
  confere("cache em disco com .meta", arquivos.includes("abcdefghij1.320") && arquivos.includes("abcdefghij1.320.meta") && arquivos.includes("abcdefghij1.orig"));
} catch (e) {
  falhas++;
  console.error("✘ exceção no teste:", e);
} finally {
  proc.kill("SIGTERM");
  drive.close();
  await new Promise((r) => setTimeout(r, 300));
  await fsp.rm(cacheDir, { recursive: true, force: true });
}
if (falhas || process.argv.includes("--log")) console.log("\n--- log do entregador ---\n" + log);
console.log(falhas ? `\n${falhas} teste(s) falharam` : "\nTudo certo.");
process.exit(falhas ? 1 : 0);
