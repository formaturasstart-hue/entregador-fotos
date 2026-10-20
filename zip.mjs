// ZIP em streaming, sem compressão (JPEG já é comprimido), sem guardar nada em memória.
// Mesmo formato do src/lib/zip-stream.ts do sistema: "data descriptor" (bit 3), nomes UTF-8.
// Lido normalmente pelo Windows, macOS, Android e iPhone (Arquivos).

const CRC_TABELA = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(crc, dados) {
  let c = crc ^ 0xffffffff;
  for (let i = 0; i < dados.length; i++) c = CRC_TABELA[(c ^ dados[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const u16 = (n) => [n & 0xff, (n >>> 8) & 0xff];
const u32 = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
function dataDos(d) {
  const hora = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() >> 1) & 0x1f);
  const data = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | (d.getDate() & 0x1f);
  return { hora, data };
}

/**
 * Gera o ZIP das entradas, uma de cada vez. `entradas`: [{ nome, abrir: async () => ReadableStream|null }]
 * `escrever(bytes)` é chamado para cada pedaço (deve devolver uma Promise que resolve quando puder continuar).
 */
export async function montarZip(entradas, escrever) {
  const enc = new TextEncoder();
  const central = [];
  let offset = 0;
  let total = 0;
  const { hora, data } = dataDos(new Date());
  const emitir = async (bytes) => {
    const u = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    offset += u.length;
    await escrever(u);
  };
  const usados = new Set();
  for (const e of entradas) {
    let nome = e.nome.split("/").map((p) => p.replace(/[\\:*?"<>|]/g, "_")).filter(Boolean).join("/");
    if (usados.has(nome)) nome = nome.replace(/(\.[^.]*)?$/, (ext) => `_${usados.size}${ext}`);
    usados.add(nome);
    const nomeBytes = enc.encode(nome);
    const corpo = await e.abrir();
    if (!corpo) continue;

    const inicio = offset;
    await emitir([0x50, 0x4b, 0x03, 0x04, ...u16(20), ...u16(0x0808), ...u16(0), ...u16(hora), ...u16(data), ...u32(0), ...u32(0), ...u32(0), ...u16(nomeBytes.length), ...u16(0)]);
    await emitir(nomeBytes);

    let crc = 0;
    let tamanho = 0;
    const leitor = corpo.getReader();
    try {
      for (;;) {
        const { done, value } = await leitor.read();
        if (done) break;
        if (!value?.length) continue;
        crc = crc32(crc, value);
        tamanho += value.length;
        await emitir(value);
      }
    } catch (e) {
      await leitor.cancel().catch(() => {}); // cliente sumiu: fecha o arquivo que estava sendo lido
      throw e;
    }
    await emitir([0x50, 0x4b, 0x07, 0x08, ...u32(crc), ...u32(tamanho), ...u32(tamanho)]);
    central.push(0x50, 0x4b, 0x01, 0x02, ...u16(20), ...u16(20), ...u16(0x0808), ...u16(0), ...u16(hora), ...u16(data), ...u32(crc), ...u32(tamanho), ...u32(tamanho), ...u16(nomeBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(inicio), ...nomeBytes);
    total++;
  }
  const inicioCentral = offset;
  await emitir(central);
  const tamanhoCentral = offset - inicioCentral;
  await emitir([0x50, 0x4b, 0x05, 0x06, ...u16(0), ...u16(0), ...u16(total), ...u16(total), ...u32(tamanhoCentral), ...u32(inicioCentral), ...u16(0)]);
  return total;
}
