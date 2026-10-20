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
    return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ name: `Foto ${m[1]}.jpg`, mimeType: "image/jpeg", thumbnailLink: semThumb ? undefined : `http://127.0.0.1:${portaDrive}/thumb/${m[1]}=s220` }));
  }
  if (u.pathname.startsWith("/thumb/")) {
    chamadas.thumb++;
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
