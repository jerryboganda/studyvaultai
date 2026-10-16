import { cacheDocumentBytes, upsertDocument } from '@storage';
import { sha256Hex } from '@pdf/fingerprint';
import { createBackupDeps } from '@ui/backup/deps';
import { gallery } from '../shim/chrome';
import plainBackup from '../../packages/backup/src/fixtures/v2-plain.json';
import encryptedBackup from '../../packages/backup/src/fixtures/v3-encrypted.json';
import ankiText from '../../packages/backup/src/fixtures/golden/anki.txt?raw';
import lockedPdf from '../fixtures/locked-notes.pdf?url';
import scannedPdf from '../../tests/fixtures/pdf/real/nasa-msfc-60k-combustion-testbed-2000.pdf?url';

/**
 * Files for the gallery's import, restore and PDF states: a backup of the seeded vault made by the
 * real export, the backup package's frozen fixtures (an old-model plain backup and a
 * passphrase-protected one, kept there as base64, and an Anki text export), a tiny
 * password-protected PDF (gallery/fixtures, password "gallery") and a public-domain scanned PDF
 * from tests/fixtures.
 */
const backup = (fixture: { base64: string }, name: string) =>
  new File([Uint8Array.from(atob(fixture.base64), (c) => c.charCodeAt(0))], name, {
    type: 'application/octet-stream',
  });

export const FILES = {
  /** What "Create backup file" would download right now (Settings > Backup and restore). */
  exported: async () => {
    const out = await createBackupDeps(gallery.manifest.version).exportFull({
      includeCachedPdfs: false,
    });
    return new File([out.bytes as Uint8Array<ArrayBuffer>], out.suggestedFilename, {
      type: 'application/zip',
    });
  },
  oldModelBackup: () => backup(plainBackup, 'studyvault-backup-20261001-090000.zip'),
  encryptedBackup: () => backup(encryptedBackup, 'studyvault-backup-20261001-090000.svbackup'),
  anki: () => new File([ankiText], 'Pharmacology deck.txt', { type: 'text/plain' }),
  lockedPdf: async () =>
    new File([await (await fetch(lockedPdf)).blob()], 'Locked notes.pdf', {
      type: 'application/pdf',
    }),
};

/** Puts `file` in a file input the way choosing it in the browser's file picker does. */
export function chooseFile(input: HTMLInputElement, file: File): void {
  const list = new DataTransfer();
  list.items.add(file);
  input.files = list.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * window.showDirectoryPicker (no picker can open in the gallery): answers with a real folder in this
 * page's origin-private file system, so the backup-folder code writes and reads back a real file.
 */
export function fakeDirectoryPicker(): void {
  Object.assign(window, {
    showDirectoryPicker: async () =>
      (await navigator.storage.getDirectory()).getDirectoryHandle('StudyVault backups', {
        create: true,
      }),
  });
}

/** Keeps a copy of the scanned PDF (no text layer) and returns its document id. */
export async function storeScannedPdf(): Promise<string> {
  const bytes = new Uint8Array(await (await fetch(scannedPdf)).arrayBuffer());
  const id = await sha256Hex(bytes);
  await upsertDocument({
    id,
    title: '60K Combustion Testbed (scanned report)',
    pageCount: 3,
    byteLength: bytes.byteLength,
    originalUrl: null,
    textStatus: 'scanned',
  });
  await cacheDocumentBytes(id, new Blob([bytes], { type: 'application/pdf' }));
  return id;
}
