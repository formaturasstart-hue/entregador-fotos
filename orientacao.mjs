// Orientação da miniatura (23/11/2026). Sem bibliotecas: lê só o cabeçalho do JPEG.
//
// Problema: em fotos de câmera (ex.: IMG_1871.JPG de um formando), o Google às vezes gera as
// miniaturas pequenas (320/640) a partir da prévia que a câmera grava dentro do arquivo, que vem
// SEM o giro — a foto em pé aparece deitada — enquanto a de 1600 sai certa. O Drive informa as
// medidas reais (imageMediaMetadata: width, height, rotation); aqui conferimos se a miniatura bate.

const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function orientacaoExif(buf, ini, fim) {
  // ini aponta para "Exif\0\0"; depois vem o cabeçalho TIFF
  const t = ini + 6;
  if (t + 8 > fim) return 1;
  const le = buf[t] === 0x49 && buf[t + 1] === 0x49; // "II" = little-endian
  if (!le && !(buf[t] === 0x4d && buf[t + 1] === 0x4d)) return 1;
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const ifd = t + u32(t + 4);
  if (ifd + 2 > fim) return 1;
  const n = u16(ifd);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > fim) break;
    if (u16(e) === 0x0112) {
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : 1;
    }
  }
  return 1;
}

/** Largura e altura COMO A FOTO APARECE no navegador (aplica a orientação EXIF). null = não é JPEG legível. */
export function medidasJpeg(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let o = 2;
  let orientacao = 1;
  while (o + 4 <= buf.length) {
    if (buf[o] !== 0xff) return null;
    const marca = buf[o + 1];
    if (marca === 0xff) {
      o++;
      continue;
    }
    if (marca === 0xd8 || (marca >= 0xd0 && marca <= 0xd7) || marca === 0x01) {
      o += 2;
      continue;
    }
    const tam = buf.readUInt16BE(o + 2);
    const fim = Math.min(buf.length, o + 2 + tam);
    if (marca === 0xe1 && buf.toString("latin1", o + 4, o + 10) === "Exif\0\0") orientacao = orientacaoExif(buf, o + 4, fim);
    if (SOF.has(marca)) {
      if (o + 9 > buf.length) return null;
      const altura = buf.readUInt16BE(o + 5);
      const largura = buf.readUInt16BE(o + 7);
      return orientacao >= 5 ? { largura: altura, altura: largura } : { largura, altura };
    }
    if (marca === 0xda) return null; // começou a imagem sem achar o tamanho
    o += 2 + tam;
  }
  return null;
}

/** Medidas reais da foto segundo o Drive (rotation = giros de 90°; ímpar troca largura e altura). */
export function medidasReais(m) {
  const w = Number(m?.width) || 0;
  const h = Number(m?.height) || 0;
  if (!w || !h) return null;
  return (((Number(m?.rotation) || 0) % 2) + 2) % 2 === 1 ? { largura: h, altura: w } : { largura: w, altura: h };
}

const quaseQuadrada = (l, a) => Math.abs(Math.log(l / a)) < 0.05;

/**
 * A miniatura está na mesma orientação (em pé / deitada) que a foto de verdade?
 * Na dúvida (não deu para ler, foto quase quadrada, Drive sem medidas) responde true: não mexe.
 */
export function orientacaoConfere(buf, real) {
  if (!real) return true;
  const m = medidasJpeg(buf);
  if (!m || !m.largura || !m.altura) return true;
  if (quaseQuadrada(m.largura, m.altura) || quaseQuadrada(real.largura, real.altura)) return true;
  return m.largura > m.altura === real.largura > real.altura;
}
