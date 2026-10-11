import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { Bank, Folder, MAX_FOLDER_DEPTH } from '@shared';
import { listBankInfos, listFolderTree } from '@storage';
import { freshDatabase } from '@storage/test-vault';
import {
  BANK_PRESETS,
  applyPreset,
  describeApplied,
  findPreset,
  includedKeys,
  plannedFolderCount,
  previewRows,
  pruneExcluded,
  setIncluded,
  type PresetPorts,
} from './presets';
import { storagePorts } from './Steps';

const radiology = findPreset('radiology')!;
const medicine = findPreset('medicine')!;

describe('the shipped presets', () => {
  it('has the four starting points, blank first', () => {
    expect(BANK_PRESETS.map((p) => p.id)).toEqual(['blank', 'general', 'medicine', 'radiology']);
    expect(BANK_PRESETS[0]!.bank).toBeNull();
    expect(BANK_PRESETS.map((p) => p.label)).toEqual([
      'Blank',
      'General study',
      'Medicine (general)',
      'Diagnostic Radiology',
    ]);
  });

  it('Diagnostic Radiology is exactly the PRD taxonomy, as folders of one bank', () => {
    expect(radiology.bank?.name).toBe('Diagnostic Radiology');
    expect(radiology.bank?.children?.map((c) => c.name)).toEqual([
      'Physics',
      'Ultrasound',
      'CT',
      'MRI',
      'Nuclear Medicine',
      'Neuroradiology',
      'MSK',
      'Chest',
      'Abdomen',
      'Breast',
      'Pediatrics',
      'Interventional',
    ]);
    expect(radiology.bank?.children?.every((c) => (c.children?.length ?? 0) === 0)).toBe(true);
  });

  it('every name is valid for the vault, unique among siblings, and keys never collide', () => {
    for (const preset of BANK_PRESETS) {
      if (!preset.bank) continue;
      expect(Bank.shape.name.safeParse(preset.bank.name).success, preset.bank.name).toBe(true);
      const keys = new Set<string>();
      const walk = (nodes: readonly { name: string; children?: readonly unknown[] }[]) => {
        const siblings = new Set<string>();
        for (const n of nodes) {
          expect(Folder.shape.name.safeParse(n.name).success, n.name).toBe(true);
          expect(n.name.includes('/'), `${n.name} must not contain "/"`).toBe(false);
          expect(siblings.has(n.name.toLowerCase()), `duplicate ${n.name}`).toBe(false);
          siblings.add(n.name.toLowerCase());
          walk((n.children ?? []) as never);
        }
      };
      walk(preset.bank.children ?? []);
      for (const row of previewRows(preset)) {
        expect(keys.has(row.key)).toBe(false);
        keys.add(row.key);
        expect(row.depth).toBeLessThan(MAX_FOLDER_DEPTH);
      }
    }
  });
});

describe('preview', () => {
  it('lists a parent before its children with depth and parent keys', () => {
    const rows = previewRows(medicine);
    expect(rows[0]).toMatchObject({
      key: 'Medicine',
      depth: 0,
      parentKey: null,
      hasChildren: true,
    });
    const anatomy = rows.find((r) => r.name === 'Anatomy')!;
    expect(anatomy).toMatchObject({
      key: 'Medicine/Basic sciences/Anatomy',
      depth: 2,
      parentKey: 'Medicine/Basic sciences',
    });
    expect(rows.indexOf(anatomy)).toBeGreaterThan(
      rows.findIndex((r) => r.key === 'Medicine/Basic sciences'),
    );
    expect(previewRows(BANK_PRESETS[0]!)).toEqual([]);
  });

  it('unticking a node leaves out its subtree, and ticking it back restores the children', () => {
    const rows = previewRows(medicine);
    const all = includedKeys(rows, new Set());
    expect(all.size).toBe(rows.length);
    const excluded = new Set(['Medicine/Clinical']);
    const some = includedKeys(rows, excluded);
    expect(some.has('Medicine/Clinical')).toBe(false);
    expect(some.has('Medicine/Clinical/Surgery')).toBe(false);
    expect(some.has('Medicine/Basic sciences/Anatomy')).toBe(true);
    // The child's own flag is untouched, so it comes back with its parent.
    expect(
      includedKeys(rows, new Set(['Medicine/Clinical/Surgery'])).has('Medicine/Clinical'),
    ).toBe(true);
    expect(plannedFolderCount(medicine, new Set())).toBe(rows.length - 1);
    expect(plannedFolderCount(medicine, excluded)).toBe(rows.length - 1 - 7);
    expect(plannedFolderCount(medicine, new Set(['Medicine']))).toBe(0);
  });

  it('setIncluded and pruneExcluded keep a clean, duplicate-free list', () => {
    expect(setIncluded([], 'a', false)).toEqual(['a']);
    expect(setIncluded(['a'], 'a', false)).toEqual(['a']);
    expect(setIncluded(['a', 'b'], 'a', true)).toEqual(['b']);
    expect(
      pruneExcluded(radiology, ['Diagnostic Radiology/MRI', 'Diagnostic Radiology/Gone']),
    ).toEqual(['Diagnostic Radiology/MRI']);
  });
});

// ---------------------------------------------------------------------------------------------
// applyPreset over an in-memory vault
// ---------------------------------------------------------------------------------------------

function memoryVault() {
  const banks: Array<{ id: string; name: string; isInbox: boolean }> = [
    { id: 'inbox', name: 'Inbox', isInbox: true },
  ];
  const folders: Array<{
    id: string;
    bankId: string;
    name: string;
    parentFolderId: string | null;
  }> = [];
  const log: string[] = [];
  let n = 0;
  let failAt: number | null = null;
  const ports: PresetPorts = {
    listBanks: async () => banks.map((b) => ({ ...b })),
    createBank: async (name) => {
      log.push(`bank:${name}`);
      const b = { id: `bank${++n}`, name, isInbox: false };
      banks.push(b);
      return { id: b.id };
    },
    listFolders: async (bankId) => folders.filter((f) => f.bankId === bankId),
    createFolder: async (input) => {
      if (failAt !== null && log.filter((l) => l.startsWith('folder:')).length >= failAt) {
        failAt = null;
        throw new Error('Disk full');
      }
      log.push(`folder:${input.name}<${input.parentFolderId ?? ''}`);
      const f = { id: `f${++n}`, ...input };
      folders.push(f);
      return { id: f.id };
    },
  };
  return {
    ports,
    banks,
    folders,
    log,
    failAfter(count: number) {
      failAt = count;
    },
  };
}

describe('applyPreset', () => {
  it('creates the bank, then folders with their parents first', async () => {
    const vault = memoryVault();
    const result = await applyPreset(medicine, new Set(), vault.ports);
    expect(result).toMatchObject({ bankName: 'Medicine', createdBank: true, existingFolders: 0 });
    expect(result?.createdFolders).toBe(previewRows(medicine).length - 1);
    expect(vault.log[0]).toBe('bank:Medicine');
    const basic = vault.folders.find((f) => f.name === 'Basic sciences')!;
    const anatomy = vault.folders.find((f) => f.name === 'Anatomy')!;
    expect(basic.parentFolderId).toBeNull();
    expect(anatomy.parentFolderId).toBe(basic.id);
    expect(vault.folders.every((f) => f.bankId === result?.bankId)).toBe(true);
  });

  it('skips unticked nodes and their children', async () => {
    const vault = memoryVault();
    await applyPreset(
      medicine,
      new Set(['Medicine/Clinical', 'Medicine/Basic sciences/Anatomy']),
      vault.ports,
    );
    const names = vault.folders.map((f) => f.name);
    expect(names).not.toContain('Clinical');
    expect(names).not.toContain('Surgery');
    expect(names).not.toContain('Anatomy');
    expect(names).toContain('Physiology');
    expect(names).toContain('Public health and ethics');
  });

  it('is idempotent: a second run adds nothing and says so', async () => {
    const vault = memoryVault();
    await applyPreset(radiology, new Set(), vault.ports);
    const before = { banks: vault.banks.length, folders: vault.folders.length };
    const again = await applyPreset(radiology, new Set(), vault.ports);
    expect(again).toMatchObject({ createdBank: false, createdFolders: 0, existingFolders: 12 });
    expect({ banks: vault.banks.length, folders: vault.folders.length }).toEqual(before);
    expect(describeApplied(again!)).toMatch(/already there, so nothing was added/);
  });

  it('adds only what is missing next to what the person made, ignoring case and spacing', async () => {
    const vault = memoryVault();
    vault.banks.push({ id: 'mine', name: '  diagnostic   RADIOLOGY ', isInbox: false });
    vault.folders.push(
      { id: 'mine-mri', bankId: 'mine', name: 'mri', parentFolderId: null },
      { id: 'mine-x', bankId: 'mine', name: 'My own folder', parentFolderId: null },
    );
    const result = await applyPreset(radiology, new Set(), vault.ports);
    expect(result).toMatchObject({
      bankId: 'mine',
      createdBank: false,
      createdFolders: 11,
      existingFolders: 1,
    });
    expect(vault.banks.filter((b) => !b.isInbox)).toHaveLength(1);
    expect(vault.folders.filter((f) => f.name.toLowerCase() === 'mri')).toHaveLength(1);
    expect(vault.folders.some((f) => f.name === 'My own folder')).toBe(true);
    expect(describeApplied(result!)).toBe(
      'Added 11 folders to the existing bank "Diagnostic Radiology" (1 was already there).',
    );
  });

  it('never matches the Inbox, even by name', async () => {
    const vault = memoryVault();
    const preset = { ...radiology, bank: { name: 'Inbox', children: [{ name: 'A' }] } };
    const result = await applyPreset(preset, new Set(), vault.ports);
    expect(result?.createdBank).toBe(true);
    expect(vault.banks.filter((b) => b.name === 'Inbox')).toHaveLength(2);
  });

  it('a failure part-way keeps what exists; running again completes it without duplicates', async () => {
    const vault = memoryVault();
    vault.failAfter(5);
    await expect(applyPreset(radiology, new Set(), vault.ports)).rejects.toThrow('Disk full');
    expect(vault.folders).toHaveLength(5);
    expect(vault.banks.filter((b) => !b.isInbox)).toHaveLength(1);

    const result = await applyPreset(radiology, new Set(), vault.ports);
    expect(result).toMatchObject({ createdBank: false, createdFolders: 7, existingFolders: 5 });
    expect(vault.folders).toHaveLength(12);
    expect(new Set(vault.folders.map((f) => f.name)).size).toBe(12);
  });

  it('creates nothing for blank, or when the bank itself is unticked', async () => {
    const vault = memoryVault();
    expect(await applyPreset(BANK_PRESETS[0]!, new Set(), vault.ports)).toBeNull();
    expect(await applyPreset(radiology, new Set(['Diagnostic Radiology']), vault.ports)).toBeNull();
    expect(vault.log).toEqual([]);
  });
});

describe('applyPreset against the real vault', () => {
  beforeEach(async () => {
    await freshDatabase();
  });

  it('creates the Diagnostic Radiology bank once, however often it is run', async () => {
    const first = await applyPreset(
      radiology,
      new Set(['Diagnostic Radiology/Breast']),
      storagePorts,
    );
    expect(first).toMatchObject({ createdBank: true, createdFolders: 11 });
    await applyPreset(radiology, new Set(['Diagnostic Radiology/Breast']), storagePorts);
    const third = await applyPreset(radiology, new Set(), storagePorts);
    expect(third).toMatchObject({ createdBank: false, createdFolders: 1, existingFolders: 11 });

    const banks = (await listBankInfos()).filter((b) => !b.isInbox);
    expect(banks.map((b) => b.name)).toEqual(['Diagnostic Radiology']);
    const tree = await listFolderTree(banks[0]!.id);
    expect(tree.map((n) => n.folder.name).sort()).toEqual(
      [...radiology.bank!.children!.map((c) => c.name)].sort(),
    );
  });

  it('builds nested presets with real parent links', async () => {
    await applyPreset(medicine, new Set(), storagePorts);
    const bank = (await listBankInfos()).find((b) => b.name === 'Medicine')!;
    const tree = await listFolderTree(bank.id);
    const basic = tree.find((n) => n.folder.name === 'Basic sciences')!;
    expect(basic.children.map((c) => c.folder.name)).toContain('Anatomy');
    expect(basic.children[0]!.folder.parentFolderId).toBe(basic.folder.id);
    // And once more: still one bank, same tree.
    await applyPreset(medicine, new Set(), storagePorts);
    expect((await listBankInfos()).filter((b) => b.name === 'Medicine')).toHaveLength(1);
    expect((await listFolderTree(bank.id)).length).toBe(tree.length);
  });
});
