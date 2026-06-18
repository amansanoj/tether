/**
 * Minimal QR Code generator (Mode Byte, ECC-L, versions 1–10).
 * Produces an SVG string. No external dependencies.
 *
 * Based on the QR code specification; stripped down for short URLs only.
 */

// --- GF(256) arithmetic for Reed-Solomon ---
const EXP = new Uint8Array(256);
const LOG = new Uint8Array(256);
{
  let v = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = v;
    LOG[v] = i;
    v = v << 1;
    if (v >= 256) v ^= 0x11d;
  }
  EXP[255] = EXP[0];
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[(LOG[a] + LOG[b]) % 255];
}

function rsGenPoly(n: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < n; i++) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data: Uint8Array, eccCount: number): Uint8Array {
  const gen = rsGenPoly(eccCount);
  const result = new Uint8Array(eccCount);
  for (let i = 0; i < data.length; i++) {
    const coef = data[i] ^ result[0];
    result.copyWithin(0, 1);
    result[eccCount - 1] = 0;
    if (coef !== 0) {
      for (let j = 0; j < eccCount; j++) {
        result[j] ^= gfMul(gen[j + 1], coef);
      }
    }
  }
  return result;
}

// --- QR version info (ECC-L only, versions 1–10) ---
interface VersionInfo {
  totalCodewords: number;
  eccPerBlock: number;
  dataCodewords: number;
  blocks: number;
  size: number;
}

// ECC Level L parameters for versions 1-10
const VERSIONS: VersionInfo[] = [
  { totalCodewords: 26, eccPerBlock: 7, dataCodewords: 19, blocks: 1, size: 21 },  // v1
  { totalCodewords: 44, eccPerBlock: 10, dataCodewords: 34, blocks: 1, size: 25 }, // v2
  { totalCodewords: 70, eccPerBlock: 15, dataCodewords: 55, blocks: 1, size: 29 }, // v3
  { totalCodewords: 100, eccPerBlock: 20, dataCodewords: 80, blocks: 1, size: 33 }, // v4
  { totalCodewords: 134, eccPerBlock: 26, dataCodewords: 108, blocks: 1, size: 37 }, // v5
  { totalCodewords: 172, eccPerBlock: 18, dataCodewords: 136, blocks: 2, size: 41 }, // v6
  { totalCodewords: 196, eccPerBlock: 20, dataCodewords: 156, blocks: 2, size: 45 }, // v7
  { totalCodewords: 242, eccPerBlock: 24, dataCodewords: 194, blocks: 2, size: 49 }, // v8
  { totalCodewords: 292, eccPerBlock: 30, dataCodewords: 232, blocks: 2, size: 53 }, // v9
  { totalCodewords: 346, eccPerBlock: 18, dataCodewords: 274, blocks: 4, size: 57 }, // v10
];

function selectVersion(dataLen: number): { version: number; info: VersionInfo } {
  for (let i = 0; i < VERSIONS.length; i++) {
    // Byte mode overhead: 4 (mode) + charCountBits + data*8
    const charCountBits = i < 9 ? 8 : 16;
    const availBits = VERSIONS[i].dataCodewords * 8;
    const needed = 4 + charCountBits + dataLen * 8;
    if (needed <= availBits) return { version: i + 1, info: VERSIONS[i] };
  }
  // Fallback: use version 10 (max ~274 bytes for ECC-L)
  return { version: 10, info: VERSIONS[9] };
}

// Alignment pattern positions by version (versions 2+)
const ALIGNMENT_POSITIONS: number[][] = [
  [],        // v1
  [6, 18],   // v2
  [6, 22],   // v3
  [6, 26],   // v4
  [6, 30],   // v5
  [6, 34],   // v6
  [6, 22, 38], // v7
  [6, 24, 42], // v8
  [6, 26, 46], // v9
  [6, 28, 52], // v10
];

// Format info bits for ECC-L, masks 0-7
const FORMAT_BITS: number[] = [
  0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976,
];

function encodeData(text: string, info: VersionInfo, version: number): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  const charCountBits = version < 10 ? 8 : 16;

  // Build bit stream
  const bits: number[] = [];
  const pushBits = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };

  // Mode indicator: Byte = 0100
  pushBits(0b0100, 4);
  // Character count
  pushBits(bytes.length, charCountBits);
  // Data
  for (const b of bytes) pushBits(b, 8);
  // Terminator (up to 4 zeros)
  const capacity = info.dataCodewords * 8;
  const termLen = Math.min(4, capacity - bits.length);
  pushBits(0, termLen);
  // Pad to byte boundary
  while (bits.length % 8 !== 0) bits.push(0);
  // Pad codewords
  const padBytes = [0xec, 0x11];
  let padIdx = 0;
  while (bits.length < capacity) {
    pushBits(padBytes[padIdx % 2], 8);
    padIdx++;
  }

  // Convert to bytes
  const dataCodewords = new Uint8Array(info.dataCodewords);
  for (let i = 0; i < info.dataCodewords; i++) {
    let val = 0;
    for (let b = 0; b < 8; b++) val = (val << 1) | (bits[i * 8 + b] || 0);
    dataCodewords[i] = val;
  }

  // Split into blocks and compute ECC
  const blockSize = Math.floor(info.dataCodewords / info.blocks);
  const extraBlocks = info.dataCodewords - blockSize * info.blocks;
  const dataBlocks: Uint8Array[] = [];
  const eccBlocks: Uint8Array[] = [];

  let offset = 0;
  for (let b = 0; b < info.blocks; b++) {
    const size = blockSize + (b >= info.blocks - extraBlocks ? 1 : 0);
    const block = dataCodewords.slice(offset, offset + size);
    dataBlocks.push(block);
    eccBlocks.push(rsEncode(block, info.eccPerBlock));
    offset += size;
  }

  // Interleave
  const result = new Uint8Array(info.totalCodewords);
  let idx = 0;
  const maxDataLen = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxDataLen; i++) {
    for (const block of dataBlocks) {
      if (i < block.length) result[idx++] = block[i];
    }
  }
  for (let i = 0; i < info.eccPerBlock; i++) {
    for (const block of eccBlocks) {
      if (i < block.length) result[idx++] = block[i];
    }
  }

  return result;
}

function createMatrix(size: number): { modules: boolean[][]; reserved: boolean[][] } {
  const modules: boolean[][] = Array.from({ length: size }, () => Array(size).fill(false));
  const reserved: boolean[][] = Array.from({ length: size }, () => Array(size).fill(false));
  return { modules, reserved };
}

function placeFinderPattern(modules: boolean[][], reserved: boolean[][], row: number, col: number): void {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const mr = row + r;
      const mc = col + c;
      if (mr < 0 || mr >= modules.length || mc < 0 || mc >= modules.length) continue;
      reserved[mr][mc] = true;
      if (r >= 0 && r <= 6 && c >= 0 && c <= 6) {
        modules[mr][mc] =
          r === 0 || r === 6 || c === 0 || c === 6 ||
          (r >= 2 && r <= 4 && c >= 2 && c <= 4);
      }
    }
  }
}

function placeAlignmentPattern(modules: boolean[][], reserved: boolean[][], row: number, col: number): void {
  for (let r = -2; r <= 2; r++) {
    for (let c = -2; c <= 2; c++) {
      const mr = row + r;
      const mc = col + c;
      if (reserved[mr][mc]) return; // Don't overwrite finder patterns
    }
  }
  for (let r = -2; r <= 2; r++) {
    for (let c = -2; c <= 2; c++) {
      const mr = row + r;
      const mc = col + c;
      reserved[mr][mc] = true;
      modules[mr][mc] =
        Math.abs(r) === 2 || Math.abs(c) === 2 || (r === 0 && c === 0);
    }
  }
}

function placeTimingPatterns(modules: boolean[][], reserved: boolean[][], size: number): void {
  for (let i = 8; i < size - 8; i++) {
    if (!reserved[6][i]) {
      reserved[6][i] = true;
      modules[6][i] = i % 2 === 0;
    }
    if (!reserved[i][6]) {
      reserved[i][6] = true;
      modules[i][6] = i % 2 === 0;
    }
  }
}

function reserveFormatArea(reserved: boolean[][], size: number): void {
  // Around top-left finder
  for (let i = 0; i < 9; i++) {
    reserved[8][i] = true;
    reserved[i][8] = true;
  }
  // Around top-right finder
  for (let i = 0; i < 8; i++) reserved[8][size - 1 - i] = true;
  // Around bottom-left finder
  for (let i = 0; i < 7; i++) reserved[size - 1 - i][8] = true;
  // Dark module
  reserved[size - 8][8] = true;
}

function placeData(modules: boolean[][], reserved: boolean[][], data: Uint8Array, size: number): void {
  let bitIdx = 0;
  const totalBits = data.length * 8;

  // Traverse in 2-column sections from right to left
  let col = size - 1;
  while (col >= 0) {
    if (col === 6) col--; // Skip timing column
    const isUpward = ((size - 1 - col) >> 1) % 2 === 0;

    for (let row = 0; row < size; row++) {
      const actualRow = isUpward ? size - 1 - row : row;
      for (let dc = 0; dc <= 1; dc++) {
        const c = col - dc;
        if (c < 0) continue;
        if (reserved[actualRow][c]) continue;
        if (bitIdx < totalBits) {
          const byteIdx = Math.floor(bitIdx / 8);
          const bitPos = 7 - (bitIdx % 8);
          modules[actualRow][c] = ((data[byteIdx] >> bitPos) & 1) === 1;
          bitIdx++;
        }
      }
    }
    col -= 2;
  }
}

function applyMask(modules: boolean[][], reserved: boolean[][], size: number, mask: number): boolean[][] {
  const result = modules.map((row) => [...row]);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (reserved[r][c]) continue;
      let invert = false;
      switch (mask) {
        case 0: invert = (r + c) % 2 === 0; break;
        case 1: invert = r % 2 === 0; break;
        case 2: invert = c % 3 === 0; break;
        case 3: invert = (r + c) % 3 === 0; break;
        case 4: invert = (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; break;
        case 5: invert = ((r * c) % 2) + ((r * c) % 3) === 0; break;
        case 6: invert = (((r * c) % 2) + ((r * c) % 3)) % 2 === 0; break;
        case 7: invert = (((r + c) % 2) + ((r * c) % 3)) % 2 === 0; break;
      }
      if (invert) result[r][c] = !result[r][c];
    }
  }
  return result;
}

function penaltyScore(modules: boolean[][], size: number): number {
  let score = 0;

  // Rule 1: consecutive same-color in rows/columns
  for (let r = 0; r < size; r++) {
    let count = 1;
    for (let c = 1; c < size; c++) {
      if (modules[r][c] === modules[r][c - 1]) {
        count++;
        if (count === 5) score += 3;
        else if (count > 5) score += 1;
      } else {
        count = 1;
      }
    }
  }
  for (let c = 0; c < size; c++) {
    let count = 1;
    for (let r = 1; r < size; r++) {
      if (modules[r][c] === modules[r - 1][c]) {
        count++;
        if (count === 5) score += 3;
        else if (count > 5) score += 1;
      } else {
        count = 1;
      }
    }
  }

  // Rule 2: 2x2 blocks
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = modules[r][c];
      if (v === modules[r][c + 1] && v === modules[r + 1][c] && v === modules[r + 1][c + 1]) {
        score += 3;
      }
    }
  }

  return score;
}

function placeFormatBits(modules: boolean[][], size: number, mask: number): void {
  const bits = FORMAT_BITS[mask];
  // Horizontal (near top-left)
  for (let i = 0; i <= 5; i++) modules[8][i] = ((bits >> (14 - i)) & 1) === 1;
  modules[8][7] = ((bits >> 8) & 1) === 1;
  modules[8][8] = ((bits >> 7) & 1) === 1;
  modules[7][8] = ((bits >> 6) & 1) === 1;
  for (let i = 0; i <= 5; i++) modules[5 - i][8] = ((bits >> (i)) & 1) === 1;

  // Right side of top-left and bottom-left
  for (let i = 0; i < 7; i++) modules[size - 1 - i][8] = ((bits >> i) & 1) === 1;
  for (let i = 0; i < 8; i++) modules[8][size - 8 + i] = ((bits >> (14 - 7 - i)) & 1) === 1;

  // Dark module
  modules[size - 8][8] = true;
}

/**
 * Generate an SVG QR code for the given text.
 * Returns an SVG string (XML).
 */
export function generateQRCodeSVG(text: string, moduleSize = 4, quietZone = 4): string {
  const { version, info } = selectVersion(text.length);
  const size = info.size;

  // Encode data
  const codewords = encodeData(text, info, version);

  // Build matrix
  const { modules, reserved } = createMatrix(size);

  // Place patterns
  placeFinderPattern(modules, reserved, 0, 0);
  placeFinderPattern(modules, reserved, 0, size - 7);
  placeFinderPattern(modules, reserved, size - 7, 0);

  // Alignment patterns
  const positions = ALIGNMENT_POSITIONS[version - 1] || [];
  if (positions.length >= 2) {
    for (const r of positions) {
      for (const c of positions) {
        placeAlignmentPattern(modules, reserved, r, c);
      }
    }
  }

  placeTimingPatterns(modules, reserved, size);
  reserveFormatArea(reserved, size);

  // Place data
  placeData(modules, reserved, codewords, size);

  // Try all masks, pick best
  let bestMask = 0;
  let bestScore = Infinity;
  let bestModules = modules;

  for (let mask = 0; mask < 8; mask++) {
    const masked = applyMask(modules, reserved, size, mask);
    const tempModules = masked.map((row) => [...row]);
    placeFormatBits(tempModules, size, mask);
    const score = penaltyScore(tempModules, size);
    if (score < bestScore) {
      bestScore = score;
      bestMask = mask;
      bestModules = masked;
    }
  }

  // Apply format info to best result
  placeFormatBits(bestModules, size, bestMask);

  // Generate SVG
  const totalSize = (size + quietZone * 2) * moduleSize;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalSize} ${totalSize}" width="${totalSize}" height="${totalSize}">`;
  svg += `<rect width="${totalSize}" height="${totalSize}" fill="#ffffff"/>`;

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (bestModules[r][c]) {
        const x = (c + quietZone) * moduleSize;
        const y = (r + quietZone) * moduleSize;
        svg += `<rect x="${x}" y="${y}" width="${moduleSize}" height="${moduleSize}" fill="#000000"/>`;
      }
    }
  }

  svg += `</svg>`;
  return svg;
}
