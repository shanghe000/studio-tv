// Only recompress the PNG's filtered scanline stream. Decoding into a browser
// canvas would discard e.g. high bit depth, exact transparent RGB and profiles.
const MiB = 1024 * 1024;
const minFileSize = MiB / 4;
// A full 4096×4096 RGBA8 image at deflate level 0 exceeds 64 MiB by its row and container overhead.
const maxFileSize = 80 * MiB;
const maxScanlineBytes = 128 * MiB;
const signature = [137, 80, 78, 71, 13, 10, 26, 10];
const crcTable = Uint32Array.from({length: 256}, (_, byte) => {
 let crc = byte;
 for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
 return crc >>> 0;
});

function updateCrc(crc: number, bytes: Uint8Array) {
 for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
 return crc;
}

// These chunks still describe the exact same pixels. Unknown unsafe-to-copy
// extensions (including signatures/provenance) and animation use the original.
const pixelMetadata = new Set(['PLTE', 'tRNS', 'cHRM', 'gAMA', 'iCCP', 'sBIT', 'sRGB', 'bKGD', 'hIST',
 'pHYs', 'sPLT', 'tIME', 'cICP', 'mDCV', 'cLLI', 'eXIf']);
const depthsByColor: Record<number, number[]> = {0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16]};
const channelsByColor: Record<number, number> = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4};

async function recompress(file: File): Promise<File> {
 const bytes = new Uint8Array(await file.arrayBuffer());
 if (bytes.length < 45 || !signature.every((byte, i) => bytes[i] === byte)) return file;
 const view = new DataView(bytes.buffer);
 const width = view.getUint32(16), height = view.getUint32(20), depth = bytes[24], color = bytes[25];
 if (!width || !height || !depthsByColor[color]?.includes(depth) || bytes[26] || bytes[27] || bytes[28]) return file;
 const stride = 1 + Math.ceil(width * channelsByColor[color] * depth / 8);
 const expected = stride * height;
 if (expected > maxScanlineBytes) return file;

 let firstData = -1, afterData = -1, ended = false, palette = false, chunkCount = 0, untilYield = MiB;
 const blocks: Uint8Array<ArrayBuffer>[] = [];
 for (let pos = 8; pos < bytes.length;) {
  if (++chunkCount > 32768 || pos + 12 > bytes.length) return file;
  const size = view.getUint32(pos), end = pos + size + 12;
  if (end > bytes.length) return file;
  const tag = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
  if (pos === 8) {
   if (tag !== 'IHDR' || size !== 13) return file;
  } else if (tag === 'IDAT') {
   if (firstData >= 0 && afterData !== pos) return file;
   if (color === 3 && !palette) return file;
   if (firstData < 0) firstData = pos;
   afterData = end;
   if (size) blocks.push(bytes.subarray(pos + 8, end - 4));
  } else if (tag === 'IEND') {
   if (size || end !== bytes.length || !blocks.length) return file;
   ended = true;
  } else {
   if (!pixelMetadata.has(tag) && !/^[a-z][A-Za-z][A-Z][a-z]$/.test(tag)) return file;
   if (tag === 'PLTE') {
    if (palette || firstData >= 0 || size === 0 || size % 3 || size > 768 || color === 0 || color === 4) return file;
    palette = true;
   }
  }
  let crc = -1;
  for (let i = pos + 4; i < end - 4;) {
   const stop = Math.min(end - 4, i + untilYield);
   crc = updateCrc(crc, bytes.subarray(i, stop));
   untilYield -= stop - i;
   i = stop;
   if (untilYield === 0) {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    untilYield = MiB;
   }
  }
  if ((~crc >>> 0) !== view.getUint32(end - 4)) return file;
  pos = end;
 }
 if (!ended) return file;

 let block = 0, offset = 0, decoded = 0, nextFilter = 0;
 let stopped = false;
 const input = new ReadableStream<Uint8Array<ArrayBuffer>>({
  pull(controller) {
   if (stopped || block === blocks.length) { controller.close(); return; }
   // Bound expansion from a single inflater write even for untrusted input.
   const bytes = blocks[block], stop = Math.min(offset + 16384, bytes.length);
   controller.enqueue(bytes.subarray(offset, stop));
   offset = stop;
   if (offset === bytes.length) { block++; offset = 0; }
  }
 });
 const validate = new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
  transform(chunk, controller) {
   const end = decoded + chunk.length;
   // Stop supplying compressed input, but drain already-buffered native codec
   // writes. Canceling an active native stream can race its final callbacks.
   if (stopped || end > expected) { stopped = true; return; }
   for (; nextFilter < end; nextFilter += stride) {
    if (chunk[nextFilter - decoded] > 4) { stopped = true; return; }
   }
   decoded = end;
   controller.enqueue(chunk);
  }
 });
 const reader = input.pipeThrough(new DecompressionStream('deflate')).pipeThrough(validate)
  .pipeThrough(new CompressionStream('deflate')).getReader();
 const header = new Uint8Array([0, 0, 0, 0, 73, 68, 65, 84]);
 const chunks: BlobPart[] = [file.slice(0, firstData), header];
 let length = 0, crc = updateCrc(-1, header.subarray(4));
 try {
  for (;;) {
   const {done, value} = await reader.read();
   if (done) break;
   length += value.length;
   if (stopped || length + 12 >= afterData - firstData) { stopped = true; continue; }
   crc = updateCrc(crc, value);
   chunks.push(value);
  }
 } finally { reader.releaseLock(); }
 if (stopped || decoded !== expected) return file;
 new DataView(header.buffer).setUint32(0, length);
 const trailer = new Uint8Array(4);
 new DataView(trailer.buffer).setUint32(0, ~crc >>> 0);
 chunks.push(trailer, file.slice(afterData));
 return new File(chunks, file.name, {type: file.type, lastModified: file.lastModified});
}

export function shouldOptimizeCanvasImage(file: File): boolean {
 return file.type === 'image/png' && file.size >= minFileSize && file.size <= maxFileSize &&
  typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
}

const optimized = new WeakMap<File, Promise<File>>();
let pending = Promise.resolve();
// Limit the memory budget across multi-file drops, without serializing uploads.
export async function optimizeCanvasImage(file: File): Promise<File> {
 if (!shouldOptimizeCanvasImage(file)) return file;
 const known = optimized.get(file);
 if (known) return known;
 const result = pending.then(() => recompress(file)).catch(() => file);
 optimized.set(file, result);
 pending = result.then(output => { optimized.set(output, result); });
 return result;
}
