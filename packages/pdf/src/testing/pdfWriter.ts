/**
 * Test-only: a tiny PDF 1.4 writer so fixtures are generated in code (nothing binary is checked in).
 * Standard Helvetica (not embedded), uncompressed content streams, optional RC4-40 encryption
 * (security handler R2) with a user password, optional image-only pages. Never imported by app code.
 */
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

export interface FixtureText {
  x: number;
  y: number;
  text: string;
  size?: number;
  /** 90 writes the line along the page's +y axis (as it appears on a /Rotate 90 page). */
  angle?: 0 | 90;
}

export interface FixturePage {
  width?: number;
  height?: number;
  rotate?: 0 | 90 | 180 | 270;
  texts?: FixtureText[];
  /** Draw a full-page raster image and no text: a scanned page. */
  imageOnly?: boolean;
  /**
   * A scanned page with real content: this 8-bit grayscale raster (row-major, top row first) fills the
   * page, Flate-compressed. No text is written, so the page has no text layer.
   */
  gray?: { width: number; height: number; data: Uint8Array };
}

export interface FixtureOutlineItem {
  title: string;
  /** 1-based page the bookmark opens. */
  page: number;
  /** Distance of the heading from the page's top edge, in points (written as an /XYZ destination). */
  fromTop?: number;
  children?: FixtureOutlineItem[];
}

export interface FixtureOptions {
  title?: string;
  /** Encrypt with RC4-40 (R2); this is the user password required to open the file. */
  userPassword?: string;
  /** Bookmarks (not combined with a password). */
  outline?: FixtureOutlineItem[];
}

const PAD = Uint8Array.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

const latin1 = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const md5 = (...parts: Uint8Array[]): Uint8Array => {
  const h = createHash('md5');
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
};
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = Uint8Array.from({ length: 256 }, (_, i) => i);
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i]! + key[i % key.length]!) & 255;
    [s[i], s[j]] = [s[j]!, s[i]!];
  }
  const out = new Uint8Array(data.length);
  for (let n = 0, i = 0, j = 0; n < data.length; n++) {
    i = (i + 1) & 255;
    j = (j + s[i]!) & 255;
    [s[i], s[j]] = [s[j]!, s[i]!];
    out[n] = data[n]! ^ s[(s[i]! + s[j]!) & 255]!;
  }
  return out;
}

const padPassword = (pw: string): Uint8Array => concat(latin1(pw), PAD).slice(0, 32);
const escapeText = (s: string): string => s.replace(/[\\()]/g, (c) => `\\${c}`);

export function buildPdf(pages: FixturePage[], options: FixtureOptions = {}): Uint8Array {
  // Object numbering: 1 catalog, 2 pages, 3 font, 4 info, 5 image, 6.. per page (page, contents).
  const pageObj = (i: number): number => 6 + i * 2;
  const bodies = new Map<number, { dict: string; stream?: Uint8Array }>();
  bodies.set(1, { dict: '<< /Type /Catalog /Pages 2 0 R >>' });
  bodies.set(2, {
    dict: `<< /Type /Pages /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] /Count ${pages.length} >>`,
  });
  bodies.set(3, {
    dict: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  });
  // Strings of an encrypted file would have to be encrypted too; the title is left out instead.
  bodies.set(4, {
    dict:
      options.userPassword === undefined
        ? `<< /Title (${escapeText(options.title ?? 'Fixture')}) /Producer (sv-test) >>`
        : '<< /Producer (sv-test) >>',
  });
  bodies.set(5, {
    dict: '<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 64 >>',
    stream: Uint8Array.from({ length: 64 }, (_, i) => (i * 13) & 255),
  });

  // Extra objects are numbered after the pages: outline entries, then per-page rasters.
  let nextObj = pageObj(pages.length - 1) + 2;
  const outlineRoot = options.outline?.length ? nextObj++ : 0;
  const grayObj = new Map<number, number>();
  pages.forEach((p, i) => {
    if (p.gray) grayObj.set(i, nextObj++);
  });
  if (outlineRoot) {
    type Flat = {
      id: number;
      item: FixtureOutlineItem;
      parent: number;
      prev: number;
      next: number;
      kids: number[];
    };
    const flat: Flat[] = [];
    const build = (items: FixtureOutlineItem[], parent: number): number[] => {
      const ids = items.map(() => nextObj++);
      items.forEach((item, k) => {
        const f: Flat = {
          id: ids[k]!,
          item,
          parent,
          prev: ids[k - 1] ?? 0,
          next: ids[k + 1] ?? 0,
          kids: [],
        };
        flat.push(f);
        f.kids = build(item.children ?? [], f.id);
      });
      return ids;
    };
    const top = build(options.outline!, outlineRoot);
    bodies.set(outlineRoot, {
      dict: `<< /Type /Outlines /First ${top[0]} 0 R /Last ${top[top.length - 1]} 0 R /Count ${flat.length} >>`,
    });
    for (const f of flat) {
      const kids = f.kids;
      const target = pages[f.item.page - 1];
      const pageHeight = target?.height ?? 792;
      const dest = `[${pageObj(f.item.page - 1)} 0 R /XYZ 72 ${pageHeight - (f.item.fromTop ?? 0)} 0]`;
      bodies.set(f.id, {
        dict:
          `<< /Title (${escapeText(f.item.title)}) /Parent ${f.parent} 0 R` +
          (f.prev ? ` /Prev ${f.prev} 0 R` : '') +
          (f.next ? ` /Next ${f.next} 0 R` : '') +
          (kids.length
            ? ` /First ${kids[0]} 0 R /Last ${kids[kids.length - 1]} 0 R /Count ${kids.length}`
            : '') +
          ` /Dest ${dest} >>`,
      });
    }
    bodies.set(1, { dict: `<< /Type /Catalog /Pages 2 0 R /Outlines ${outlineRoot} 0 R >>` });
  }

  pages.forEach((p, i) => {
    const w = p.width ?? 612;
    const h = p.height ?? 792;
    const gray = p.gray;
    if (gray) {
      const raw = deflateSync(Buffer.from(gray.data));
      bodies.set(grayObj.get(i)!, {
        dict: `<< /Type /XObject /Subtype /Image /Width ${gray.width} /Height ${gray.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode >>`,
        stream: new Uint8Array(raw),
      });
    }
    const content = gray
      ? `q ${w} 0 0 ${h} 0 0 cm /Im1 Do Q`
      : p.imageOnly
        ? `q ${w - 100} 0 0 ${h - 200} 50 100 cm /Im0 Do Q`
        : (p.texts ?? [])
            .map(
              (t) =>
                `BT /F1 ${t.size ?? 12} Tf ${t.angle === 90 ? `0 1 -1 0 ${t.x} ${t.y} Tm` : `1 0 0 1 ${t.x} ${t.y} Tm`} (${escapeText(t.text)}) Tj ET`,
            )
            .join('\n');
    const rotate = p.rotate ? ` /Rotate ${p.rotate}` : '';
    bodies.set(pageObj(i), {
      dict: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}]${rotate} /Resources << /Font << /F1 3 0 R >> /XObject << /Im0 5 0 R${gray ? ` /Im1 ${grayObj.get(i)} 0 R` : ''} >> >> /Contents ${pageObj(i) + 1} 0 R >>`,
    });
    bodies.set(pageObj(i) + 1, { dict: '<< >>', stream: latin1(content) });
  });

  // Encryption (R2, RC4-40, empty owner distinct from user).
  let encryptRef = '';
  let objectKey: ((num: number) => Uint8Array) | null = null;
  const lastObj = nextObj - 1;
  if (options.userPassword !== undefined) {
    const id = md5(latin1(options.title ?? 'fixture'));
    const ownerKey = md5(padPassword(`${options.userPassword}-owner`)).slice(0, 5);
    const O = rc4(ownerKey, padPassword(options.userPassword));
    const P = Uint8Array.from([0xfc, 0xff, 0xff, 0xff]); // -4
    const key = md5(padPassword(options.userPassword), O, P, id).slice(0, 5);
    const U = rc4(key, PAD);
    objectKey = (num) =>
      md5(key, Uint8Array.from([num & 255, (num >> 8) & 255, (num >> 16) & 255, 0, 0])).slice(
        0,
        10,
      );
    const encNum = lastObj + 1;
    bodies.set(encNum, {
      dict: `<< /Filter /Standard /V 1 /R 2 /O <${hex(O)}> /U <${hex(U)}> /P -4 >>`,
    });
    encryptRef = ` /Encrypt ${encNum} 0 R /ID [<${hex(id)}> <${hex(id)}>]`;
  }

  const chunks: Uint8Array[] = [latin1('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')];
  let offset = chunks[0]!.length;
  const offsets = new Map<number, number>();
  const nums = [...bodies.keys()].sort((a, b) => a - b);
  for (const num of nums) {
    const b = bodies.get(num)!;
    offsets.set(num, offset);
    const isEncryptDict = options.userPassword !== undefined && num === nums[nums.length - 1];
    let stream = b.stream;
    if (stream && objectKey && !isEncryptDict) stream = rc4(objectKey(num), stream);
    const dict = stream ? b.dict.replace(/ ?(>>)$/, ` /Length ${stream.length} $1`) : b.dict;
    const head = latin1(`${num} 0 obj\n${dict}\n`);
    const parts = stream
      ? [head, latin1('stream\n'), stream, latin1('\nendstream\nendobj\n')]
      : [head, latin1('endobj\n')];
    const piece = concat(...parts);
    chunks.push(piece);
    offset += piece.length;
  }
  const size = nums[nums.length - 1]! + 1;
  const xref = ['xref', `0 ${size}`, '0000000000 65535 f '];
  for (let n = 1; n < size; n++)
    xref.push(`${String(offsets.get(n) ?? 0).padStart(10, '0')} 00000 n `);
  const trailer = `trailer\n<< /Size ${size} /Root 1 0 R /Info 4 0 R${encryptRef} >>\nstartxref\n${offset}\n%%EOF\n`;
  chunks.push(latin1(`${xref.join('\n')}\n${trailer}`));
  return concat(...chunks);
}

/** Pages of simple prose for tests that need "a normal document". */
export function proseFixture(pageCount: number, linesPerPage = 6): FixturePage[] {
  return Array.from({ length: pageCount }, (_, p) => ({
    texts: Array.from({ length: linesPerPage }, (_, l) => ({
      x: 72,
      y: 720 - l * 18,
      text: `Page ${p + 1} line ${l + 1}: the quick brown fox jumps over the lazy dog.`,
    })),
  }));
}
