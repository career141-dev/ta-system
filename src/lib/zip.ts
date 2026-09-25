import { crc32 } from "node:zlib";

/**
 * A ZIP of files, stored as they are (no compression).
 *
 * For the bulk CV download (api/cv/zip). CVs are PDFs and Word files, both
 * already compressed inside, so deflating them again gains next to nothing and
 * a stored ZIP is a few dozen lines rather than a dependency. Names are marked
 * UTF-8 (flag bit 11) so "Nuwan Perera" and "Sébastien" open correctly on
 * Windows and macOS alike.
 *
 * ponytail: no ZIP64 — fine under 4 GB and 65,535 files, far above the route's cap.
 */
export function zipStore(files: { name: string; data: Uint8Array }[], at = new Date()): Buffer {
  const time = (at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1);
  const date = ((at.getFullYear() - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const data = Buffer.from(f.data);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

/**
 * "<Full name>.<ext>" for a CV in the ZIP: the person's exact name, less the
 * characters Windows will not put in a file name, and "(2)" on a repeat.
 */
export function cvFileName(fullName: string, originalName: string | null, used: Set<string>): string {
  const ext = (originalName?.match(/\.([a-z0-9]{2,5})$/i)?.[1] ?? "pdf").toLowerCase();
  const base =
    fullName
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[. ]+$/, "") || "Candidate";
  let name = `${base}.${ext}`;
  for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} (${n}).${ext}`;
  used.add(name.toLowerCase());
  return name;
}
