import type { Page } from '@playwright/test';
import { decryptContainer, resolveCrypto } from '../../packages/backup/src/crypto';
import { subtle } from '../../packages/backup/src/testkit';
import {
  ANTHROPIC_KEY,
  FAKE_KEY,
  OTHER_KEY,
  addAnthropicFallback,
  addFallback,
  aiSwitch,
  enableAi,
  expect,
  metaValue,
  openConsent,
  openExt,
  openSide,
  profilesOf,
  readTable,
  saveHighlight,
  sendAndWaitForDraft,
  setUpAi,
  test,
} from './helpers.aiAnthropic';
import {
  chooseBackup,
  commitRestore,
  createBackup,
  deleteAllData,
  openBackupPage,
  openSection,
  pick,
  readArchive,
  wizard,
} from './helpers.backup';

/**
 * Backups and the AI secrets, in a real loaded extension: with a primary key AND the keys of two
 * fallback providers (one of them Anthropic) saved through the settings page, a plain and an
 * encrypted backup are made through the Backup section, taken apart in Node, and restored into a
 * vault that "Delete all data" emptied. Neither carries a key, a provider setting or the ledger; what
 * the person accepted from the AI (a flashcard marked as AI-made, and the draft it came from) does
 * come back, and the AI section of the restored vault is empty.
 *
 * The encrypted file is opened with the product's own `decryptContainer` and the passphrase, because
 * ciphertext not containing a key proves nothing: the question is what is inside it.
 *
 * Not covered: backups written to the backup folder (backup-folder.spec.ts) and the keys in a sync
 * upload (sync.spec.ts).
 */

test.describe.configure({ timeout: 360_000 });

const PASSPHRASE = 'correct horse battery staple';
const KEYS = [FAKE_KEY, OTHER_KEY, ANTHROPIC_KEY] as const;
/** Row names of the secrets and of the AI settings; none of them is a backup table. */
const SECRET_ROWS = ['aiKey', 'aiProfileKeys', 'aiSettings', 'aiBudget', 'apiKey'] as const;

function expectNoSecrets(text: string, what: string): void {
  for (const key of KEYS) expect(text, `${what} holds ${key}`).not.toContain(key);
  for (const row of SECRET_ROWS) expect(text, `${what} names ${row}`).not.toContain(row);
}

/** No AI key, provider setting or ledger anywhere in the vault database. */
async function expectNoAiSecretsStored(page: Page, what: string): Promise<void> {
  for (const row of ['aiKey', 'aiProfileKeys', 'aiSettings', 'aiBudget']) {
    expect(await metaValue(page, row), `${what}: meta row ${row}`).toBeUndefined();
  }
  expectNoSecrets(JSON.stringify(await readTable(page, 'meta')), `${what}: the meta table`);
}

test.describe('backups and the AI keys', () => {
  test('a plain and an encrypted backup hold no AI key, no fallback key and no AI settings; restored into a wiped vault they bring back the accepted AI card and the draft, and the AI section has no key', async ({
    env,
    provider,
    fallback,
    anthropic,
  }) => {
    // ---- a vault with three keys and one AI card the person accepted -------------------------
    const options = await openExt(env, 'options');
    await setUpAi(options, provider); // FAKE_KEY
    await addFallback(options, { label: 'Backup model', baseUrl: fallback.baseUrl }); // OTHER_KEY
    await addAnthropicFallback(options, { label: 'Claude backup', baseUrl: anthropic.baseUrl });
    expect(await metaValue(options, 'aiKey')).toMatchObject({ apiKey: FAKE_KEY });
    const stored = await metaValue<Record<string, { apiKey: string; origin: string }>>(
      options,
      'aiProfileKeys',
    );
    expect(
      Object.values(stored ?? {})
        .map((k) => k.apiKey)
        .sort(),
    ).toEqual([ANTHROPIC_KEY, OTHER_KEY].sort());
    expect(
      (await metaValue<{ fallbacks: unknown[] }>(options, 'aiSettings'))?.fallbacks,
    ).toHaveLength(2);

    const { page, highlight } = await saveHighlight(env, options, '#p-pearl');
    const side = await openSide(env, page);
    const dialog = await openConsent(side, highlight.id, 'flashcards');
    const draft = await sendAndWaitForDraft(dialog);
    await draft.getByTestId('ai-accept').click();
    await expect(draft.getByTestId('ai-item-accepted')).toContainText('created card');
    expect(provider.completions(), 'the primary provider answered').toHaveLength(1);
    expect(fallback.seen).toEqual([]);
    expect(anthropic.seen).toEqual([]);

    const [aiCard] = await readTable(options, 'cards');
    expect(aiCard).toMatchObject({
      createdBy: 'ai',
      needsHumanVerification: true,
      highlightId: highlight.id,
    });
    const [aiDraft] = await readTable(options, 'aiResults');
    expect(aiDraft?.id).toBe(aiCard?.aiResultId);

    // Another open StudyVault window would hold a deletion up: only the Backup page stays.
    await side.close();
    await page.close();
    await options.close();
    const backup = await openBackupPage(env);

    // ---- a plain and an encrypted backup, taken apart -----------------------------------------
    const plain = await createBackup(backup);
    const encrypted = await createBackup(backup, { passphrase: PASSPHRASE });
    await expect(backup.getByTestId('backup-export-done-leaves-out')).toContainText(
      'the AI provider, address, key and usage (fallback providers and their keys included)',
    );

    const inPlain = readArchive(plain.bytes);
    expect(inPlain.manifest.options.encrypted).toBe(false);
    expect(inPlain.manifest.tables.map((t) => t.name)).not.toContain('meta');
    // What the person accepted is in it (so the checks below are not on an empty file)...
    expect(inPlain.tables.cards).toHaveLength(1);
    expect(inPlain.tables.cards?.[0]).toMatchObject({
      createdBy: 'ai',
      needsHumanVerification: true,
    });
    expect(inPlain.tables.aiResults).toHaveLength(1);
    expect(inPlain.everything).toContain(highlight.exactQuote.slice(0, 40));
    // ...and no secret is.
    expectNoSecrets(inPlain.everything, 'the plain backup');

    expect(encrypted.bytes.subarray(0, 8).toString('latin1')).toBe('SVBKENC1');
    for (const key of KEYS) {
      expect(encrypted.bytes.includes(Buffer.from(key)), `the container holds ${key}`).toBe(false);
    }
    // Ciphertext hides anything, so open it: what is INSIDE must be as clean as the plain file.
    const inner = await decryptContainer(resolveCrypto({ subtle }), encrypted.bytes, PASSPHRASE);
    const opened = readArchive(inner);
    expect(opened.manifest.tables.map((t) => t.name)).not.toContain('meta');
    expect(opened.tables.cards?.[0]).toMatchObject({
      createdBy: 'ai',
      needsHumanVerification: true,
    });
    expect(opened.tables.aiResults).toHaveLength(1);
    expectNoSecrets(opened.everything, 'the decrypted backup');

    // ---- restoring over a vault that still has the keys leaves them alone ---------------------
    await backup.getByTestId('backup-export-done').getByRole('button', { name: 'Done' }).click();
    await chooseBackup(backup, plain);
    await commitRestore(backup, { mode: 'replace', safety: false });
    expect(await metaValue(backup, 'aiKey')).toMatchObject({ apiKey: FAKE_KEY });
    const kept = await metaValue<Record<string, { apiKey: string }>>(backup, 'aiProfileKeys');
    expect(
      Object.values(kept ?? {})
        .map((k) => k.apiKey)
        .sort(),
    ).toEqual([ANTHROPIC_KEY, OTHER_KEY].sort());
    expect(
      (await metaValue<{ fallbacks: unknown[] }>(backup, 'aiSettings'))?.fallbacks,
    ).toHaveLength(2);
    await backup.reload();

    // ---- into a wiped vault: the plain file, then the encrypted one ---------------------------
    const expectRestoredWithoutKeys = async (what: string) => {
      const cards = await readTable(backup, 'cards');
      expect(cards, `${what}: the accepted AI card is back`).toHaveLength(1);
      expect(cards[0]).toMatchObject({
        createdBy: 'ai',
        needsHumanVerification: true,
        front: 'E2E question: what does the passage state?',
        highlightId: highlight.id,
        aiResultId: aiDraft?.id,
        deletedAt: null,
      });
      expect(
        (await readTable(backup, 'aiResults')).map((r) => r.id),
        `${what}: and so is the draft it came from`,
      ).toEqual([aiDraft?.id]);
      await expectNoAiSecretsStored(backup, what);

      // The AI section of the restored vault (its own settings view): the switch is the person's
      // to turn on again, and then it shows no provider, no key and no fallback. With nothing set
      // up the section opens its setup wizard; the status card (Test, key chip, usage) and the
      // "Advanced" panel (fallback providers, usage ledger) only exist once a provider is saved.
      await backup.reload();
      await openSection(backup, 'ai');
      await expect(aiSwitch(backup)).toBeVisible();
      await expect(aiSwitch(backup)).not.toBeChecked();
      await enableAi(backup);
      const setup = backup.getByTestId('ai-setup');
      await expect(setup).toBeVisible();
      await expect(backup.getByTestId('ai-status')).toHaveCount(0);
      await expect(backup.getByTestId('ai-test')).toHaveCount(0);
      await expect(backup.getByTestId('ai-advanced')).toHaveCount(0);
      await expect(profilesOf(backup)).toHaveCount(0);
      await expect(
        setup.getByTestId('ai-provider-choice').locator('input:checked'),
        'no provider is picked',
      ).toHaveCount(0);
      // "Other": the address and the model are empty ...
      await pick(setup.getByTestId('ai-preset-custom'));
      await setup.getByTestId('ai-setup-next').click();
      await expect(setup.getByTestId('ai-base-url')).toHaveValue('');
      await expect(setup.getByTestId('ai-model')).toHaveValue('');
      // ... and with an address typed in (never saved), the key step has no saved key to show.
      await setup.getByTestId('ai-base-url').fill('https://api.example.com/v1');
      await setup.getByTestId('ai-model').fill('any-model');
      await setup.getByTestId('ai-setup-next').click();
      await expect(setup.getByTestId('ai-key-input')).toHaveValue('');
      await expect(setup.getByTestId('ai-key-status')).toHaveCount(0);
      await expect(setup.getByLabel('API key', { exact: true })).toBeVisible();
      await expectNoAiSecretsStored(backup, `${what}, AI switched on`);
      await openSection(backup, 'backup');
      await expect(backup.getByTestId('backup-section')).toBeVisible();
    };

    await deleteAllData(backup);
    await expectNoAiSecretsStored(backup, 'after Delete all data');
    expect(await readTable(backup, 'cards')).toEqual([]);

    await chooseBackup(backup, plain);
    await commitRestore(backup);
    await expectRestoredWithoutKeys('the plain backup');

    await deleteAllData(backup);
    expect(await readTable(backup, 'cards')).toEqual([]);

    await chooseBackup(backup, encrypted);
    const ask = wizard(backup).getByTestId('backup-import-passphrase');
    await expect(ask).toContainText('This backup is locked');
    await ask.getByTestId('backup-import-pass').fill(PASSPHRASE);
    await ask.getByTestId('backup-import-unlock').click();
    await commitRestore(backup);
    await expectRestoredWithoutKeys('the encrypted backup');

    // The restored card is flagged for the person on the review page, as it was before.
    const cardId = String((await readTable(backup, 'cards'))[0]?.id);
    const review = await env.context.newPage();
    await review.goto(`chrome-extension://${env.extensionId}/review.html`);
    await review.getByRole('tab', { name: 'Cards', exact: true }).click();
    await expect(review.getByTestId(`rv-card-${cardId}`)).toContainText('Needs your check');

    // Nothing was sent to any provider by any of this.
    expect(provider.completions()).toHaveLength(1);
    expect(fallback.seen).toEqual([]);
    expect(anthropic.seen).toEqual([]);
  });
});
