// Minimal, deterministic single-file ZIP support for document compaction.
// Radar owns both the writer and reader, so this intentionally supports only
// the narrow ZIP subset it emits: one UTF-8 named entry using raw DEFLATE.

import { deflateRawSync, inflateRawSync } from 'zlib';

const LOCAL_FILE_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const UTF8_FLAG = 0x0800;
const DEFLATE_METHOD = 8;

const CRC32_TABLE = new Uint32Array(256);
for (let n = 0; n < CRC32_TABLE.length; n++) {
  let value = n;
  for (let bit = 0; bit < 8; bit++) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  CRC32_TABLE[n] = value >>> 0;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function entryName(filename) {
  const normalized = String(filename || 'evidence.bin')
    .replaceAll('\\', '/')
    .split('/')
    .at(-1)
    .replaceAll('\0', '')
    .trim();
  return normalized || 'evidence.bin';
}

function assertRange(bytes, offset, length, label) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
    || offset < 0 || length < 0 || offset + length > bytes.length) {
    throw new Error(`invalid document ZIP ${label}`);
  }
}

export function createDocumentArchive(content, filename) {
  const original = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const name = Buffer.from(entryName(filename), 'utf8');
  if (name.length > 0xffff) throw new Error('document ZIP filename is too long');

  const compressed = deflateRawSync(original, { level: 9 });
  const checksum = crc32(original);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(LOCAL_FILE_SIGNATURE, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(UTF8_FLAG, 6);
  local.writeUInt16LE(DEFLATE_METHOD, 8);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(original.length, 22);
  local.writeUInt16LE(name.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(CENTRAL_DIRECTORY_SIGNATURE, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(UTF8_FLAG, 8);
  central.writeUInt16LE(DEFLATE_METHOD, 10);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(original.length, 24);
  central.writeUInt16LE(name.length, 28);

  const centralOffset = local.length + name.length + compressed.length;
  const centralSize = central.length + name.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);

  return Buffer.concat([local, name, compressed, central, name, end]);
}

export function openDocumentArchive(archive) {
  const bytes = Buffer.isBuffer(archive) ? archive : Buffer.from(archive);
  if (bytes.length < 22) throw new Error('invalid document ZIP: truncated archive');

  const endOffset = bytes.length - 22;
  if (bytes.readUInt32LE(endOffset) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE
    || bytes.readUInt16LE(endOffset + 8) !== 1
    || bytes.readUInt16LE(endOffset + 10) !== 1
    || bytes.readUInt16LE(endOffset + 20) !== 0) {
    throw new Error('invalid document ZIP: expected one entry and no comment');
  }

  const centralOffset = bytes.readUInt32LE(endOffset + 16);
  assertRange(bytes, centralOffset, 46, 'central directory');
  if (bytes.readUInt32LE(centralOffset) !== CENTRAL_DIRECTORY_SIGNATURE) {
    throw new Error('invalid document ZIP: missing central directory');
  }

  const flags = bytes.readUInt16LE(centralOffset + 8);
  const method = bytes.readUInt16LE(centralOffset + 10);
  if ((flags & 1) !== 0 || method !== DEFLATE_METHOD) {
    throw new Error('invalid document ZIP: unsupported encryption or compression');
  }

  const expectedCrc = bytes.readUInt32LE(centralOffset + 16);
  const compressedSize = bytes.readUInt32LE(centralOffset + 20);
  const originalSize = bytes.readUInt32LE(centralOffset + 24);
  const localOffset = bytes.readUInt32LE(centralOffset + 42);
  assertRange(bytes, localOffset, 30, 'local header');
  if (bytes.readUInt32LE(localOffset) !== LOCAL_FILE_SIGNATURE) {
    throw new Error('invalid document ZIP: missing local header');
  }

  const localNameLength = bytes.readUInt16LE(localOffset + 26);
  const localExtraLength = bytes.readUInt16LE(localOffset + 28);
  const payloadOffset = localOffset + 30 + localNameLength + localExtraLength;
  assertRange(bytes, payloadOffset, compressedSize, 'payload');

  let original;
  try {
    original = inflateRawSync(bytes.subarray(payloadOffset, payloadOffset + compressedSize), {
      maxOutputLength: originalSize,
    });
  } catch (error) {
    throw new Error(`invalid document ZIP: ${error.message}`);
  }
  if (original.length !== originalSize || crc32(original) !== expectedCrc) {
    throw new Error('invalid document ZIP: restored bytes failed size or CRC verification');
  }
  return original;
}
