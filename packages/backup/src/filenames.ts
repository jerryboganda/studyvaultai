// Windows-illegal characters plus path separators; everything is replaced, never silently dropped.
// eslint-disable-next-line no-control-regex
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001F\u007F-\u009F]/g;
// bidi controls and zero-width characters: invisible, and used to disguise file names
const INVISIBLE =
  /[\u{200B}-\u{200F}\u{202A}-\u{202E}\u{2060}-\u{2064}\u{2066}-\u{2069}\u{FEFF}]/gu;
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;

export interface FilenameOptions {
  /** Longest result, in characters (not counting an extension). Default 80. */
  maxLength?: number;
  fallback?: string;
}

/**
 * One path segment that is valid on Windows, macOS and Linux and cannot traverse directories:
 * illegal characters become "_", invisible characters vanish, trailing dots/spaces and leading dots
 * are neutralised, reserved device names (CON, NUL, COM1 ...) are prefixed, and the length is cut
 * on a code point boundary. Never returns an empty string.
 */
export function safeFilename(name: string, options: FilenameOptions = {}): string {
  const max = options.maxLength ?? 80;
  let s = name.normalize('NFC').replace(INVISIBLE, '').replace(ILLEGAL, '_');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/^\.+/, (dots) => '_'.repeat(dots.length));
  if ([...s].length > max) s = [...s].slice(0, max).join('');
  s = s.replace(/[. ]+$/, '');
  // "CON", and also "CON.txt": Windows looks at the part before the first dot
  if (RESERVED.test(s.split('.')[0] ?? '')) s = `_${s}`;
  return s.length > 0 ? s : (options.fallback ?? 'untitled');
}

/**
 * Make a list of file names unique on case-insensitive file systems by suffixing " (2)", " (3)"...
 * before the extension. Input order decides who keeps the plain name.
 */
export function uniquePaths(paths: readonly string[]): string[] {
  const used = new Set<string>();
  return paths.map((p) => {
    const dot = p.lastIndexOf('.');
    const slash = p.lastIndexOf('/');
    const hasExt = dot > slash + 1;
    const stem = hasExt ? p.slice(0, dot) : p;
    const ext = hasExt ? p.slice(dot) : '';
    let candidate = p;
    for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${stem} (${n})${ext}`;
    used.add(candidate.toLowerCase());
    return candidate;
  });
}
