import {crc32, deflateSync, inflateSync} from 'node:zlib';
import {describe, expect, it, vi} from 'vitest';
import {optimizeCanvasImage} from '../../apps/web/src/service/optimize-canvas-image';

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function chunk(tag: string, data = Buffer.alloc(0)) {
 const body = Buffer.concat([Buffer.from(tag), data]);
 const size = Buffer.alloc(4), checksum = Buffer.alloc(4);
 size.writeUInt32BE(data.length);
 checksum.writeUInt32BE(crc32(body));
 return Buffer.concat([size, body, checksum]);
}
const width = 400, height = 100, stride = 1 + width * 8;
function header(w = width, h = height, interlace = 0) {
 const b = Buffer.alloc(13);
 b.writeUInt32BE(w); b.writeUInt32BE(h, 4); b.set([16, 6, 0, 0, interlace], 8);
 return chunk('IHDR', b);
}
const pixels = Buffer.alloc(stride * height);
for (let y = 0; y < height; y++) {
 for (let x = 0; x < width; x++) {
  const offset = y * stride + 1 + x * 8;
  pixels.writeUInt16BE(x * 71, offset);
  pixels.writeUInt16BE(y * 29, offset + 2);
  pixels.writeUInt16BE(3, offset + 4);
  pixels.writeUInt16BE((x % 3) * 32767, offset + 6);
 }
}
const encoded = deflateSync(pixels, {level: 0});
const data = [chunk('IDAT', encoded.subarray(0, 5000)), chunk('IDAT', encoded.subarray(5000))];
const end = chunk('IEND');
function file(...chunks: Buffer[]) {
 return new File([Buffer.concat([signature, ...chunks])], 'studio-render.png', {type: 'image/png', lastModified: 123});
}
function parse(bytes: Buffer) {
 expect(bytes.subarray(0, 8)).toEqual(signature);
 const chunks = [];
 for (let pos = 8; pos < bytes.length;) {
  const size = bytes.readUInt32BE(pos), next = pos + size + 12;
  const tag = bytes.toString('ascii', pos + 4, pos + 8);
  expect(bytes.readUInt32BE(next - 4)).toBe(crc32(bytes.subarray(pos + 4, next - 4)));
  chunks.push({tag, data: bytes.subarray(pos + 8, next - 4)});
  pos = next;
 }
 return chunks;
}

describe('lossless PNG canvas upload', () => {
 it('preserves all 16 bits, transparent RGB values, color/orientation metadata and their positions', async () => {
  const gamma = Buffer.alloc(4); gamma.writeUInt32BE(45000);
  const exif = Buffer.from('49492a0008000000010012010300010000000600000000000000','hex');
  const image = file(header(), chunk('gAMA',gamma),chunk('eXIf',exif), ...data, chunk('tEXt',Buffer.from('Notes\0Sample')), end);
  const originalRead = vi.spyOn(image, 'arrayBuffer');
  const [out, duplicate] = await Promise.all([optimizeCanvasImage(image), optimizeCanvasImage(image)]);
  expect(originalRead).toHaveBeenCalledTimes(1);
  expect(out).toBe(duplicate);
  expect(await optimizeCanvasImage(out)).toBe(out);
  expect(out).toMatchObject({name:image.name, type:image.type, lastModified:image.lastModified});
  expect(out.size).toBeLessThan(image.size);
  const result = parse(Buffer.from(await out.arrayBuffer()));
  const original = parse(Buffer.from(await image.arrayBuffer()));
  expect(result.map(row=>row.tag)).toEqual(['IHDR','gAMA','eXIf','IDAT','tEXt','IEND']);
  expect(result.filter(row=>row.tag!=='IDAT')).toEqual(original.filter(row=>row.tag!=='IDAT'));
  expect(inflateSync(Buffer.concat(result.filter(row=>row.tag==='IDAT').map(row=>row.data))).equals(pixels)).toBe(true);
 });

 it.each(['acTL','fcTL','fdAT','dSIG','caBX','ZYFA','lpSZ'])('keeps animated, signed or unrecognized unsafe chunk %s untouched', async tag => {
  const image = file(header(), chunk(tag), ...data, end);
  expect(await optimizeCanvasImage(image)).toBe(image);
 });

 it.each([
  ['interlaced', () => file(header(width,height,1), ...data, end)],
  ['excessive dimensions', () => file(header(32768,32768), ...data, end)],
  ['out-of-bounds inflation', () => file(header(1,1), ...data, end)],
  ['truncated scanlines', () => file(header(width,height+1), ...data, end)],
  ['invalid filter', () => {const invalid=Buffer.from(pixels);invalid[55*stride]=9;return file(header(),chunk('IDAT',deflateSync(invalid,{level:0})),end);}],
  ['CRC mismatch', () => {const bad=Buffer.from(data[0]);bad[100]^=1;return file(header(),bad,data[1],end);}],
  ['damaged deflate data with a valid PNG CRC', () => {const bad=Buffer.from(encoded);bad[bad.length-1]^=1;return file(header(),chunk('IDAT',bad),end);}],
  ['missing end', () => file(header(), ...data)],
  ['trailing bytes', () => file(header(), ...data, end, Buffer.from('trailer'))],
  ['nonconsecutive data', () => file(header(),data[0],chunk('tEXt'),data[1],end)],
 ] as const)('falls back on %s', async (_, make) => {
  const image=make(); expect(await optimizeCanvasImage(image)).toBe(image);
 });

 it('passes through other media, small files and ineffective recompression', async () => {
  const small = file(header(),end);
  const video = new File([pixels],'video.mp4',{type:'video/mp4'});
  const packed = file(header(1,1),chunk('tEXt',Buffer.from('Note\0'+'x'.repeat(300000))),chunk('IDAT',deflateSync(Buffer.alloc(9))),end);
  for(const input of [small,video,packed]) expect(await optimizeCanvasImage(input)).toBe(input);
 });

 it('keeps uploads working when browser compression APIs are unavailable', async () => {
  const image = file(header(), ...data, end);
  vi.stubGlobal('CompressionStream',undefined);
  try {expect(await optimizeCanvasImage(image)).toBe(image);} finally {vi.unstubAllGlobals();}
 });
});
