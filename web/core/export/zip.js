const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// 1980-01-01 00:00, the DOS epoch: a fixed timestamp keeps identical inputs byte-identical.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

/**
 * Builds an uncompressed ("stored") ZIP archive.
 * @param {Array<{ name: string, data: Uint8Array | string }>} files
 * @returns {Uint8Array}
 */
export function createZip(files) {
  const encoder = new TextEncoder();
  const entries = files.map(file => {
    const name = encoder.encode(file.name);
    const data = typeof file.data === 'string' ? encoder.encode(file.data) : file.data;
    return { name, data, crc: crc32(data) };
  });
  const localSize = entries.reduce((sum, e) => sum + 30 + e.name.length + e.data.length, 0);
  const centralSize = entries.reduce((sum, e) => sum + 46 + e.name.length, 0);
  const out = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(out.buffer);
  let offset = 0;
  const writeCommon = (at, entry) => {
    view.setUint16(at, 20, true); // version needed
    view.setUint16(at + 2, 0x0800, true); // UTF-8 names
    view.setUint16(at + 4, 0, true); // stored
    view.setUint16(at + 6, DOS_TIME, true);
    view.setUint16(at + 8, DOS_DATE, true);
    view.setUint32(at + 10, entry.crc, true);
    view.setUint32(at + 14, entry.data.length, true);
    view.setUint32(at + 18, entry.data.length, true);
    view.setUint16(at + 22, entry.name.length, true);
    view.setUint16(at + 24, 0, true);
  };
  for (const entry of entries) {
    entry.offset = offset;
    view.setUint32(offset, 0x04034b50, true);
    writeCommon(offset + 4, entry);
    out.set(entry.name, offset + 30);
    out.set(entry.data, offset + 30 + entry.name.length);
    offset += 30 + entry.name.length + entry.data.length;
  }
  const centralStart = offset;
  for (const entry of entries) {
    view.setUint32(offset, 0x02014b50, true);
    view.setUint16(offset + 4, 20, true); // version made by
    writeCommon(offset + 6, entry);
    // comment length, disk number, internal and external attributes stay zero
    view.setUint32(offset + 42, entry.offset, true);
    out.set(entry.name, offset + 46);
    offset += 46 + entry.name.length;
  }
  view.setUint32(offset, 0x06054b50, true);
  view.setUint16(offset + 8, entries.length, true);
  view.setUint16(offset + 10, entries.length, true);
  view.setUint32(offset + 12, offset - centralStart, true);
  view.setUint32(offset + 16, centralStart, true);
  return out;
}
