import { openSync, closeSync, readSync, fstatSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const sha256 = value => createHash('sha256').update(value).digest('hex');

// ASAR is a pickle-encoded JSON header followed by uncompressed file bytes.
// Reading only; never unpack or write into the installed app.
export function openAsar(path) {
  const fd = openSync(path, 'r');
  const initial = fstatSync(fd);
  const read = (size, position) => {
    if (!Number.isSafeInteger(size) || size < 0 || size > 128 * 1024 * 1024 ||
        !Number.isSafeInteger(position) || position < 0 || position + size > initial.size) {
      throw new Error('Invalid ASAR bounds.');
    }
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const n = readSync(fd, buffer, offset, size - offset, position + offset);
      if (!n) throw new Error('Unexpected end of ASAR.');
      offset += n;
    }
    return buffer;
  };
  try {
    const prefix = read(8, 0);
    const headerSize = prefix.readUInt32LE(4);
    if (prefix.readUInt32LE(0) !== 4 || headerSize < 8 || headerSize > 64 * 1024 * 1024) {
      throw new Error('Invalid ASAR pickle header.');
    }
    const header = read(headerSize, 8);
    const jsonSize = header.readUInt32LE(4);
    if (jsonSize < 2 || jsonSize > headerSize - 8) throw new Error('Invalid ASAR JSON length.');
    const tree = JSON.parse(header.subarray(8, 8 + jsonSize).toString('utf8'));
    const dataOffset = 8 + headerSize;
    const files = [];
    function visit(entries, parent = '') {
      if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('Invalid ASAR directory.');
      for (const [name, item] of Object.entries(entries)) {
        if (!name || name === '.' || name === '..' || /[\\/\0]/.test(name)) throw new Error('Invalid ASAR filename.');
        const entryPath = parent + name;
        if (item.files) { visit(item.files, entryPath + '/'); continue; }
        if (item.link || item.unpacked) continue;
        const offset = Number(item.offset);
        if (!/^\d+$/.test(item.offset) || !Number.isSafeInteger(offset) || offset < 0 ||
            !Number.isSafeInteger(item.size) || item.size < 0 || dataOffset + offset + item.size > initial.size) {
          throw new Error(`Invalid ASAR file entry: ${entryPath}`);
        }
        files.push({ path: entryPath, offset: dataOffset + offset, size: item.size, integrity: item.integrity });
      }
    }
    visit(tree.files);
    return {
      files,
      read(entry) {
        const bytes = read(entry.size, entry.offset);
        if (entry.integrity?.algorithm === 'SHA256' && entry.integrity.hash && sha256(bytes) !== entry.integrity.hash) {
          throw new Error(`ASAR file integrity mismatch: ${entry.path}`);
        }
        return bytes;
      },
      fingerprint() {
        const hash = createHash('sha256');
        for (let offset = 0; offset < initial.size; offset += 1024 * 1024) {
          hash.update(read(Math.min(1024 * 1024, initial.size - offset), offset));
        }
        const now = fstatSync(fd);
        if (initial.size !== now.size || initial.mtimeMs !== now.mtimeMs || initial.ino !== now.ino) {
          throw new Error('Codex was updated while being inspected. Run inspect again.');
        }
        return { size: initial.size, sha256: hash.digest('hex') };
      },
      close: () => closeSync(fd)
    };
  } catch (error) { closeSync(fd); throw error; }
}
