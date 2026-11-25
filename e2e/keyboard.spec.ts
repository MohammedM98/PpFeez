import { expect, test, type Page } from '@playwright/test';

/*
 * 0.6.0 phase 4, SPEC 6.10: the whole daily flow without a mouse — pull, assign, approve, prepare a
 * payout — and the first Tab stop is "تخطَّ إلى الجدول".
 */

/** Tab until the focused element matches, a bounded number of times. */
async function tabTo(page: Page, match: (el: { role: string | null; name: string; tag: string }) => boolean, max = 40, back = false) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press(back ? 'Shift+Tab' : 'Tab');
    const el = await page.evaluate(() => {
      const a = document.activeElement as HTMLElement | null;
      const label = a?.closest('label')?.textContent;
      return { role: a?.getAttribute('role') ?? null, name: (a?.getAttribute('aria-label') || label || a?.textContent || '').trim(), tag: a?.tagName ?? '' };
    });
    if (match(el)) return;
  }
  throw new Error('never reached by Tab');
}

test('0.6.0 pull → assign → approve → record a payout with the keyboard only', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?theme=dark#/transactions');
  await expect(page.locator('table[aria-label="الوارد"] tbody tr[data-key]').first()).toBeVisible();

  // first stop: skip to the table
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'تخطَّ إلى الجدول' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('table[aria-label="الوارد"]'))).toBe(true);

  // pull from the palette
  await page.keyboard.press('Control+k');
  await page.keyboard.type('سحب');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  const pull = page.getByRole('dialog', { name: 'سحب المعاملات' });
  await expect(pull).toBeVisible();
  await tabTo(page, (el) => el.name === 'بدء السحب');
  await page.keyboard.press('Enter');
  await expect(pull).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: /سحب من/ })).toHaveCount(0, { timeout: 15_000 });

  // a transaction with its fee: focus its row, A to assign (+ approve), all by keys
  const row = page.locator('table[aria-label="الوارد"] tbody tr[data-key]').filter({ hasText: 'Emily Carter' });
  const name = 'Emily Carter';
  await page.keyboard.press('Tab'); // back into the page after the dialog
  await row.focus();
  await page.keyboard.press('a');
  const assign = page.getByRole('dialog', { name: 'تخصيص لعميل' });
  await expect(assign.getByRole('combobox', { name: 'العميل' })).toBeFocused();
  await page.keyboard.type('هشام');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await tabTo(page, (el) => el.name.includes('اعتماد مباشرة'));
  await page.keyboard.press('Space');
  await tabTo(page, (el) => el.name.startsWith('تخصيص واعتماد'));
  await page.keyboard.press('Enter');
  await expect(assign).toHaveCount(0);
  await expect(page.locator('[role=alertdialog]').filter({ hasText: /اعتُمدت ونُقلت إلى هشام الزعبي/ })).toBeVisible();
  await expect(page.locator('table[aria-label="الوارد"] tbody tr').filter({ hasText: name })).toHaveCount(0);

  // the palette's "تسجيل دفعة لـ…" opens the standalone payout on the customer's page (SPEC 4.9)
  await page.keyboard.press('Control+k');
  await page.keyboard.type('تسجيل دفعة هشام');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  const prep = page.getByRole('dialog', { name: /تسجيل دفعة لـ هشام الزعبي/ });
  await expect(prep).toBeVisible();
  await expect(prep.getByRole('textbox', { name: 'المبلغ' })).toBeFocused();
  await page.keyboard.type('10.00');
  await tabTo(page, (el) => el.name === 'متابعة');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: /دفعة لـ هشام الزعبي/ })).toContainText('-10.00');
  await page.screenshot({ animations: 'disabled', path: 'e2e/screenshots/dark-56-keyboard-payout.png' });
  await tabTo(page, (el) => el.name === 'تسجيل الدفعة');
  await page.keyboard.press('Enter');
  await expect(page.locator('[role=alertdialog]').filter({ hasText: 'سُجّلت الدفعة' })).toBeVisible();
  expect(errors).toEqual([]);
});
