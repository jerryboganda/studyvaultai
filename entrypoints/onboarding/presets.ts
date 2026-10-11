/**
 * Bank presets of the welcome tour: pure data and the one function that creates them.
 *
 * A preset is a bank with a tree of folders (Bank > Folder > Topic > Subtopic is one nested table in
 * the vault). Creating a preset is IDEMPOTENT: it looks at what the vault already holds and only
 * adds what is missing, so running it twice, or after the person made some of the folders by hand,
 * never duplicates anything.
 */

export interface PresetNode {
  readonly name: string;
  readonly children?: readonly PresetNode[];
}

export type PresetId = 'blank' | 'general' | 'medicine' | 'radiology';

export interface BankPreset {
  readonly id: PresetId;
  readonly label: string;
  readonly description: string;
  /** The bank (root) and the folders created inside it. Null: create nothing; the Inbox always exists. */
  readonly bank: PresetNode | null;
}

const leaf = (name: string): PresetNode => ({ name });
const leaves = (...names: string[]): PresetNode[] => names.map(leaf);

export const BANK_PRESETS: readonly BankPreset[] = [
  {
    id: 'blank',
    label: 'Blank',
    description: 'Start with only the Inbox. You create banks and folders yourself, when you want.',
    bank: null,
  },
  {
    id: 'general',
    label: 'General study',
    description: 'One bank with folders that suit most subjects and courses.',
    bank: {
      name: 'General study',
      children: leaves(
        'Lecture notes',
        'Readings',
        'Key terms',
        'Formulas and methods',
        'Worked examples',
        'Practice questions',
        'Exam preparation',
      ),
    },
  },
  {
    id: 'medicine',
    label: 'Medicine (general)',
    description: 'Basic sciences, clinical disciplines, and public health and ethics.',
    bank: {
      name: 'Medicine',
      children: [
        {
          name: 'Basic sciences',
          children: leaves(
            'Anatomy',
            'Physiology',
            'Biochemistry',
            'Pathology',
            'Pharmacology',
            'Microbiology and immunology',
          ),
        },
        {
          name: 'Clinical',
          children: leaves(
            'Internal medicine',
            'Surgery',
            'Pediatrics',
            'Obstetrics and gynecology',
            'Psychiatry',
            'Emergency medicine',
          ),
        },
        leaf('Public health and ethics'),
      ],
    },
  },
  {
    id: 'radiology',
    label: 'Diagnostic Radiology',
    description:
      'An example exam taxonomy: physics, the imaging modalities and the organ-system sections.',
    bank: {
      name: 'Diagnostic Radiology',
      children: leaves(
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
      ),
    },
  },
];

export function findPreset(id: string): BankPreset | undefined {
  return BANK_PRESETS.find((p) => p.id === id);
}

// ---------------------------------------------------------------------------------------------
// Preview tree
// ---------------------------------------------------------------------------------------------

/** Address of a node inside its preset: the names from the bank down, joined by "/". */
export type NodeKey = string;

export interface PreviewRow {
  key: NodeKey;
  name: string;
  /** 0 for the bank. */
  depth: number;
  parentKey: NodeKey | null;
  hasChildren: boolean;
}

/** The preview in reading order (a parent before its children). Empty for the blank preset. */
export function previewRows(preset: BankPreset): PreviewRow[] {
  const rows: PreviewRow[] = [];
  const walk = (node: PresetNode, parentKey: NodeKey | null, depth: number) => {
    const key = parentKey === null ? node.name : `${parentKey}/${node.name}`;
    rows.push({
      key,
      name: node.name,
      depth,
      parentKey,
      hasChildren: (node.children?.length ?? 0) > 0,
    });
    for (const child of node.children ?? []) walk(child, key, depth + 1);
  };
  if (preset.bank) walk(preset.bank, null, 0);
  return rows;
}

/** A node is created only when it and every ancestor are switched on. */
export function includedKeys(
  rows: readonly PreviewRow[],
  excluded: ReadonlySet<string>,
): Set<string> {
  const out = new Set<string>();
  for (const row of rows) {
    if (excluded.has(row.key)) continue;
    if (row.parentKey !== null && !out.has(row.parentKey)) continue;
    out.add(row.key);
  }
  return out;
}

/** The folders (not the bank) that "Create" would make or confirm. */
export function plannedFolderCount(preset: BankPreset, excluded: ReadonlySet<string>): number {
  const rows = previewRows(preset);
  const included = includedKeys(rows, excluded);
  return rows.filter((r) => r.parentKey !== null && included.has(r.key)).length;
}

/** Excluded keys that still exist in the preset (a stored list may be from an older preset). */
export function pruneExcluded(preset: BankPreset, excluded: readonly string[]): string[] {
  const known = new Set(previewRows(preset).map((r) => r.key));
  return excluded.filter((k) => known.has(k));
}

export function setIncluded(excluded: readonly string[], key: string, on: boolean): string[] {
  const rest = excluded.filter((k) => k !== key);
  return on ? rest : [...rest, key];
}

// ---------------------------------------------------------------------------------------------
// Creating a preset
// ---------------------------------------------------------------------------------------------

/** What `applyPreset` needs from the vault. The real wiring is in `storagePorts` (Onboarding.tsx). */
export interface PresetPorts {
  /** Live (not deleted) banks. */
  listBanks(): Promise<Array<{ id: string; name: string; isInbox: boolean }>>;
  createBank(name: string): Promise<{ id: string }>;
  /** Live folders of one bank, flat. */
  listFolders(
    bankId: string,
  ): Promise<Array<{ id: string; name: string; parentFolderId: string | null }>>;
  createFolder(input: {
    bankId: string;
    name: string;
    parentFolderId: string | null;
  }): Promise<{ id: string }>;
}

export interface ApplyResult {
  bankId: string;
  bankName: string;
  createdBank: boolean;
  createdFolders: number;
  /** Folders of the plan that were already there. */
  existingFolders: number;
}

/** Names are compared the way a person would: ignoring case and surrounding or doubled spaces. */
const norm = (name: string): string => name.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Create the bank and the included folders that are missing. Sequential on purpose: a folder needs
 * its parent's id, and a failure part-way leaves a valid, smaller tree; running it again completes
 * it. Returns null when the preset creates nothing (blank, or the bank itself switched off).
 */
export async function applyPreset(
  preset: BankPreset,
  excluded: ReadonlySet<string>,
  ports: PresetPorts,
): Promise<ApplyResult | null> {
  const root = preset.bank;
  if (!root) return null;
  const rows = previewRows(preset);
  const included = includedKeys(rows, excluded);
  if (!included.has(root.name)) return null;

  const banks = await ports.listBanks();
  const found = banks.find((b) => !b.isInbox && norm(b.name) === norm(root.name));
  const bank = found ?? (await ports.createBank(root.name));
  const known = new Map<string, string>();
  if (found) {
    for (const f of await ports.listFolders(found.id)) {
      // First one wins: a vault that already holds two same-named siblings stays as it is.
      const key = `${f.parentFolderId ?? ''}\u0000${norm(f.name)}`;
      if (!known.has(key)) known.set(key, f.id);
    }
  }

  const result: ApplyResult = {
    bankId: bank.id,
    bankName: root.name,
    createdBank: found === undefined,
    createdFolders: 0,
    existingFolders: 0,
  };
  const walk = async (children: readonly PresetNode[], parent: string | null, path: string) => {
    for (const node of children) {
      const key = `${path}/${node.name}`;
      if (!included.has(key)) continue;
      const mapKey = `${parent ?? ''}\u0000${norm(node.name)}`;
      let id = known.get(mapKey);
      if (id === undefined) {
        id = (
          await ports.createFolder({ bankId: bank.id, name: node.name, parentFolderId: parent })
        ).id;
        known.set(mapKey, id);
        result.createdFolders += 1;
      } else {
        result.existingFolders += 1;
      }
      await walk(node.children ?? [], id, key);
    }
  };
  await walk(root.children ?? [], null, root.name);
  return result;
}

/** One sentence about what a run did, for the status line and the last step. */
export function describeApplied(r: ApplyResult): string {
  const folders = (n: number) => `${n} ${n === 1 ? 'folder' : 'folders'}`;
  if (r.createdBank) {
    return `Created the bank "${r.bankName}" with ${folders(r.createdFolders)}.`;
  }
  if (r.createdFolders === 0) {
    return `"${r.bankName}" and its ${folders(r.existingFolders)} were already there, so nothing was added.`;
  }
  return `Added ${folders(r.createdFolders)} to the existing bank "${r.bankName}" (${r.existingFolders} ${
    r.existingFolders === 1 ? 'was' : 'were'
  } already there).`;
}
