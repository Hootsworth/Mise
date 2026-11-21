/**
 * Pure zero-dependency ISO/IEC 18004 Byte-Mode QR Code SVG generator (Versions 1–20, Level M).
 */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x >= 256) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) {
    EXP[i] = EXP[i - 255];
  }
})();

function gfMul(a, b) {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];
}

function rsGeneratorPoly(ecCount) {
  let gen = new Uint8Array([1]);
  for (let i = 0; i < ecCount; i++) {
    const next = new Uint8Array(gen.length + 1);
    const factor = EXP[i];
    for (let j = 0; j < gen.length; j++) {
      next[j] ^= gen[j];
      next[j + 1] ^= gfMul(gen[j], factor);
    }
    gen = next;
  }
  return gen;
}

function rsComputeEc(data, ecCount) {
  const gen = rsGeneratorPoly(ecCount);
  const res = new Uint8Array(ecCount);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ res[0];
    res.copyWithin(0, 1);
    res[ecCount - 1] = 0;
    if (factor !== 0) {
      for (let j = 0; j < ecCount; j++) {
        res[j] ^= gfMul(gen[j + 1], factor);
      }
    }
  }
  return res;
}

// Level M: [ecPerBlock, g1Blocks, g1DataCW, g2Blocks, g2DataCW] for Versions 1..20
const LEVEL_M_TABLE = [
  null,
  [10, 1, 16, 0, 0],
  [16, 1, 28, 0, 0],
  [26, 1, 44, 0, 0],
  [18, 2, 32, 0, 0],
  [24, 2, 43, 0, 0],
  [16, 4, 27, 0, 0],
  [18, 4, 31, 0, 0],
  [22, 2, 38, 2, 39],
  [22, 3, 36, 2, 37],
  [26, 4, 43, 1, 44],
  [30, 1, 50, 4, 51],
  [22, 6, 36, 2, 37],
  [22, 8, 37, 1, 38],
  [24, 4, 40, 5, 41],
  [24, 5, 41, 5, 42],
  [28, 7, 45, 3, 46],
  [28, 10, 46, 1, 47],
  [26, 9, 43, 4, 44],
  [26, 3, 44, 11, 45],
  [26, 3, 41, 13, 42]
];

const ALIGNMENT_CENTERS = [
  null,
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66],
  [6, 26, 48, 70],
  [6, 26, 50, 74],
  [6, 30, 54, 78],
  [6, 30, 56, 82],
  [6, 30, 58, 86],
  [6, 34, 62, 90]
];

function selectVersion(byteLen) {
  for (let v = 1; v < LEVEL_M_TABLE.length; v++) {
    const [, g1, d1, g2, d2] = LEVEL_M_TABLE[v];
    const dataCW = g1 * d1 + g2 * d2;
    const countBits = v <= 9 ? 8 : 16;
    const totalBitsNeeded = 4 + countBits + byteLen * 8;
    if (totalBitsNeeded <= dataCW * 8) {
      return v;
    }
  }
  throw new Error(`QR payload too long (${byteLen} bytes > Version 20 Level M capacity).`);
}

function encodeDataCodewords(bytes, version) {
  const [, g1, d1, g2, d2] = LEVEL_M_TABLE[version];
  const totalDataCW = g1 * d1 + g2 * d2;
  const bits = [];
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) {
      bits.push((val >>> i) & 1);
    }
  };

  pushBits(0b0100, 4); // Byte mode indicator
  pushBits(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) pushBits(b, 8);

  const capBits = totalDataCW * 8;
  const termLen = Math.min(4, capBits - bits.length);
  pushBits(0, termLen);
  while (bits.length % 8 !== 0) bits.push(0);

  const out = new Uint8Array(totalDataCW);
  let byteIdx = 0;
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    out[byteIdx++] = v;
  }
  let padToggle = 0;
  while (byteIdx < totalDataCW) {
    out[byteIdx++] = padToggle === 0 ? 0xec : 0x11;
    padToggle ^= 1;
  }
  return out;
}

function buildFinalBitStream(dataCW, version) {
  const [ecCount, g1, d1, g2, d2] = LEVEL_M_TABLE[version];
  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;

  for (let i = 0; i < g1; i++) {
    const blk = dataCW.subarray(offset, offset + d1);
    offset += d1;
    dataBlocks.push(blk);
    ecBlocks.push(rsComputeEc(blk, ecCount));
  }
  for (let i = 0; i < g2; i++) {
    const blk = dataCW.subarray(offset, offset + d2);
    offset += d2;
    dataBlocks.push(blk);
    ecBlocks.push(rsComputeEc(blk, ecCount));
  }

  const interleaved = [];
  const maxDataLen = Math.max(d1, d2);
  for (let col = 0; col < maxDataLen; col++) {
    for (const blk of dataBlocks) {
      if (col < blk.length) interleaved.push(blk[col]);
    }
  }
  for (let col = 0; col < ecCount; col++) {
    for (const ec of ecBlocks) {
      interleaved.push(ec[col]);
    }
  }

  const bitStream = [];
  for (const b of interleaved) {
    for (let i = 7; i >= 0; i--) bitStream.push((b >>> i) & 1);
  }
  return bitStream;
}

function bchFormatBits(maskPattern) {
  // Error Correction M = 00
  const data = (0b00 << 3) | maskPattern;
  let rem = data << 10;
  const poly = 0x537;
  for (let bit = 14; bit >= 10; bit--) {
    if ((rem >>> bit) & 1) {
      rem ^= poly << (bit - 10);
    }
  }
  return ((data << 10) | rem) ^ 0x5412;
}

function bchVersionBits(version) {
  let rem = version << 12;
  const poly = 0x1f25;
  for (let bit = 17; bit >= 12; bit--) {
    if ((rem >>> bit) & 1) {
      rem ^= poly << (bit - 12);
    }
  }
  return (version << 12) | rem;
}

function createBaseMatrix(version) {
  const size = 21 + 4 * (version - 1);
  const grid = Array.from({ length: size }, () => new Uint8Array(size));
  const isFunc = Array.from({ length: size }, () => new Uint8Array(size));

  const setFunc = (r, c, val) => {
    if (r < 0 || r >= size || c < 0 || c >= size) return;
    grid[r][c] = val ? 1 : 0;
    isFunc[r][c] = 1;
  };

  const drawFinder = (r0, c0) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = r0 + dr;
        const c = c0 + dc;
        if (r < 0 || r >= size || c < 0 || c >= size) continue;
        const inOuter = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const inCore = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        const isSep = dr === -1 || dr === 7 || dc === -1 || dc === 7;
        setFunc(r, c, !isSep && (inOuter || inCore));
      }
    }
  };

  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    setFunc(6, i, i % 2 === 0);
    setFunc(i, 6, i % 2 === 0);
  }

  // Alignment patterns
  const centers = ALIGNMENT_CENTERS[version] || [];
  for (const cr of centers) {
    for (const cc of centers) {
      const overlapsFinder =
        (cr <= 8 && cc <= 8) || (cr <= 8 && cc >= size - 8) || (cr >= size - 8 && cc <= 8);
      if (overlapsFinder) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dist = Math.max(Math.abs(dr), Math.abs(dc));
          setFunc(cr + dr, cc + dc, dist === 0 || dist === 2);
        }
      }
    }
  }

  // Reserve format info + dark module
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      isFunc[8][i] = 1;
      isFunc[i][8] = 1;
    }
  }
  for (let i = size - 8; i < size; i++) isFunc[8][i] = 1;
  for (let i = size - 7; i < size; i++) isFunc[i][8] = 1;
  setFunc(4 * version + 9, 8, 1);

  // Version info for Version >= 7
  if (version >= 7) {
    const vBits = bchVersionBits(version);
    for (let i = 0; i < 18; i++) {
      const bit = (vBits >>> i) & 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunc(a, b, bit);
      setFunc(b, a, bit);
    }
  }

  return { size, grid, isFunc };
}

function placeBitStream(size, grid, isFunc, bitStream) {
  let idx = 0;
  let upward = true;
  for (let rightCol = size - 1; rightCol >= 1; rightCol -= 2) {
    if (rightCol === 6) rightCol = 5;
    for (let step = 0; step < size; step++) {
      const r = upward ? size - 1 - step : step;
      for (let dx = 0; dx < 2; dx++) {
        const c = rightCol - dx;
        if (!isFunc[r][c]) {
          grid[r][c] = idx < bitStream.length ? bitStream[idx++] : 0;
        }
      }
    }
    upward = !upward;
  }
}

function applyMaskAndFormat(baseGrid, isFunc, size, maskPattern) {
  const mat = baseGrid.map((row) => Uint8Array.from(row));
  const maskBit = (r, c) => {
    switch (maskPattern) {
      case 0: return (r + c) % 2 === 0;
      case 1: return r % 2 === 0;
      case 2: return c % 3 === 0;
      case 3: return (r + c) % 3 === 0;
      case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
      case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
      case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
      default: return false;
    }
  };

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!isFunc[r][c] && maskBit(r, c)) {
        mat[r][c] ^= 1;
      }
    }
  }

  const fmt = bchFormatBits(maskPattern);
  // LSB-first bit index 0..14
  for (let i = 0; i < 6; i++) {
    const bit = (fmt >>> i) & 1;
    mat[i][8] = bit;
    mat[8][size - 1 - i] = bit;
  }
  mat[7][8] = (fmt >>> 6) & 1;
  mat[8][8] = (fmt >>> 7) & 1;
  mat[8][7] = (fmt >>> 8) & 1;
  mat[8][size - 7] = (fmt >>> 6) & 1;
  mat[8][size - 8] = (fmt >>> 7) & 1;
  mat[size - 7][8] = (fmt >>> 8) & 1;
  for (let i = 9; i < 15; i++) {
    const bit = (fmt >>> i) & 1;
    mat[8][14 - i] = bit;
    mat[size - 15 + i][8] = bit;
  }

  return mat;
}

function scoreMaskPenalty(mat, size) {
  let penalty = 0;

  // Rule 1: runs of 5+ same-color modules
  for (let r = 0; r < size; r++) {
    let runColor = mat[r][0];
    let runLen = 1;
    for (let c = 1; c < size; c++) {
      if (mat[r][c] === runColor) {
        runLen++;
        if (runLen === 5) penalty += 3;
        else if (runLen > 5) penalty += 1;
      } else {
        runColor = mat[r][c];
        runLen = 1;
      }
    }
  }
  for (let c = 0; c < size; c++) {
    let runColor = mat[0][c];
    let runLen = 1;
    for (let r = 1; r < size; r++) {
      if (mat[r][c] === runColor) {
        runLen++;
        if (runLen === 5) penalty += 3;
        else if (runLen > 5) penalty += 1;
      } else {
        runColor = mat[r][c];
        runLen = 1;
      }
    }
  }

  // Rule 2: 2x2 blocks
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = mat[r][c];
      if (v === mat[r][c + 1] && v === mat[r + 1][c] && v === mat[r + 1][c + 1]) {
        penalty += 3;
      }
    }
  }

  // Rule 3: 1011101 + 4 light modules
  const matches11 = (seq) =>
    seq.length === 11 &&
    ((seq[0] === 1 && seq[1] === 0 && seq[2] === 1 && seq[3] === 1 && seq[4] === 1 && seq[5] === 0 && seq[6] === 1 && seq[7] === 0 && seq[8] === 0 && seq[9] === 0 && seq[10] === 0) ||
      (seq[0] === 0 && seq[1] === 0 && seq[2] === 0 && seq[3] === 0 && seq[4] === 1 && seq[5] === 0 && seq[6] === 1 && seq[7] === 1 && seq[8] === 1 && seq[9] === 0 && seq[10] === 1));

  for (let r = 0; r < size; r++) {
    for (let c = 0; c <= size - 11; c++) {
      if (matches11(mat[r].subarray(c, c + 11))) penalty += 40;
    }
  }
  const colWin = new Uint8Array(11);
  for (let c = 0; c < size; c++) {
    for (let r = 0; r <= size - 11; r++) {
      for (let k = 0; k < 11; k++) colWin[k] = mat[r + k][c];
      if (matches11(colWin)) penalty += 40;
    }
  }

  // Rule 4: dark ratio balance
  let dark = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) dark += mat[r][c];
  }
  const pct = (dark * 100) / (size * size);
  const k = Math.floor(Math.abs(pct - 50) / 5);
  penalty += k * 10;

  return penalty;
}

/**
 * Encodes UTF-8 text into a Byte-Mode QR matrix at Error Correction Level M.
 */
export function encodeQrMatrix(text) {
  const str = String(text || "");
  if (!str) {
    throw new Error("QR payload cannot be empty.");
  }
  const bytes = new TextEncoder().encode(str);
  const version = selectVersion(bytes.length);
  const dataCW = encodeDataCodewords(bytes, version);
  const bitStream = buildFinalBitStream(dataCW, version);
  const { size, grid, isFunc } = createBaseMatrix(version);
  placeBitStream(size, grid, isFunc, bitStream);

  let bestMat = null;
  let bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = applyMaskAndFormat(grid, isFunc, size, mask);
    const penalty = scoreMaskPenalty(candidate, size);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMat = candidate;
    }
  }

  const modules = bestMat.map((row) => Array.from(row, (v) => v === 1));
  return { size, version, modules };
}

/**
 * Renders a high-contrast black-on-white SVG QR code with a 4-module quiet zone.
 */
export function renderQrSvg(text, { size = 220, label = "Scan UPI QR code" } = {}) {
  const { size: matrixSize, modules } = encodeQrMatrix(text);
  const quiet = 4;
  const viewSize = matrixSize + quiet * 2;
  const parts = [];
  for (let r = 0; r < matrixSize; r++) {
    for (let c = 0; c < matrixSize; c++) {
      if (modules[r][c]) {
        parts.push(`M${c + quiet},${r + quiet}h1v1h-1z`);
      }
    }
  }
  const safeLabel = String(label || "QR code").replace(/[&<>"]/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;"
  }[ch]));
  const px = Math.max(120, Number(size) || 220);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewSize} ${viewSize}" width="${px}" height="${px}" role="img" aria-label="${safeLabel}" shape-rendering="crispEdges"><rect width="${viewSize}" height="${viewSize}" fill="#ffffff"/><path d="${parts.join("")}" fill="#000000"/></svg>`;
}
