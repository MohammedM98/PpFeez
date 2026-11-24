import { expect, test, type Page } from '@playwright/test';

/*
 * 0.6.0 phase 3, SPEC 6.10 "سرعة الاستخدام": the command palette, keyboard shortcuts and their "?"
 * sheet, editing in the cell with the core's preview, quick assign with recent customers first,
 * saved views, and the last tab / filters coming back.
 */

const nav = (page: Page) => page.getByRole('navigation', { name: 'التنقل الرئيسي' });
const palette = async (page: Page, text: string) => {
  await page.keyboard.press('Control+k');
  const d = page.getByRole('dialog', { name: 'البحث في كل المعاملات' });
  await d.getByRole('searchbox').fill(text);
  return d;
};
const inbox = (page: Page) => page.locator('table[aria-label="الوارد"] tbody tr[data-key]');

for (const theme of ['dark', 'light'] as const) {
  test(`0.6.0 palette, shortcuts, cell edits, views (${theme})`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/?theme=${theme}#/dashboard`);
    await expect(page.getByRole('heading', { name: 'لوحة التحكم' })).toBeVisible();

    // "?" shows the sheet; G then a letter goes to a screen; "/" opens the search
    await page.keyboard.press('Shift+Slash');
    const sheet = page.getByRole('dialog', { name: 'اختصارات لوحة المفاتيح' });
    await expect(sheet).toContainText('تخصيص المحدد');
    await page.screenshot({ animations: 'disabled', path: `e2e/screenshots/${theme}-53-shortcuts.png` });
    await page.keyboard.press('Escape');
    await page.keyboard.press('g');
    await page.keyboard.press('c');
    await expect(page.getByRole('heading', { name: 'العملاء' })).toBeVisible();
    await page.keyboard.press('/');
    await expect(page.getByRole('dialog', { name: 'البحث في كل المعاملات' })).toBeVisible();
    await page.keyboard.press('Escape');

    // palette commands: a customer's page, "تجهيز دفعة لـ…" (opens the dialog there), pull
    let d = await palette(page, 'فتح هشام');
    await d.getByRole('option', { name: /فتح العميل هشام الزعبي/ }).click();
    await expect(page.getByRole('heading', { name: 'هشام الزعبي' })).toBeVisible();
    d = await palette(page, 'تجهيز دفعة هشام');
    await page.screenshot({ animations: 'disabled', path: `e2e/screenshots/${theme}-54-palette-commands.png` });
    await d.getByRole('option', { name: /تجهيز دفعة لـ هشام الزعبي/ }).click();
    await expect(page.getByRole('dialog', { name: /تجهيز دفعة لـ هشام الزعبي/ })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    d = await palette(page, 'سحب');
    await d.getByRole('option', { name: /سحب الآن/ }).click();
    await expect(page.getByRole('dialog', { name: /سحب/ })).toBeVisible();
    await page.keyboard.press('Escape');

    // the customer page comes back on its last tab
    await page.getByRole('tab', { name: 'الدفعات' }).click();
    await page.keyboard.press('g');
    await page.keyboard.press('c');
    await page.locator('main table tbody tr').filter({ hasText: 'هشام الزعبي' }).getByRole('rowheader').click();
    await expect(page.getByRole('tab', { name: 'الدفعات' })).toHaveAttribute('aria-selected', 'true');

    // inbox: J / K move, F2 edits the fee in its cell with the core's preview, Esc leaves it
    await nav(page).getByRole('link', { name: 'المعاملات' }).click();
    await expect(inbox(page).first()).toBeVisible();
    const key = await inbox(page).filter({ hasText: 'تحتاج رسوم' }).first().getAttribute('data-key');
    const needsFee = page.locator(`table[aria-label="الوارد"] tbody tr[data-key="${key}"]`);
    const payer = (await needsFee.locator('td').nth(2).innerText()).trim().split('\n')[0];
    await needsFee.locator('td').nth(2).click();
    await page.keyboard.press('Escape'); // the panel the click opened
    await needsFee.focus();
    await page.keyboard.press('j');
    await page.keyboard.press('k');
    await expect(needsFee).toBeFocused();
    await page.keyboard.press('F2');
    const fee = page.getByRole('textbox', { name: 'رسوم PayPal' });
    await expect(fee).toBeFocused();
    await fee.fill('9.99');
    await expect(needsFee).toContainText('الصافي');
    await page.screenshot({ animations: 'disabled', path: `e2e/screenshots/${theme}-55-cell-edit.png` });
    await page.keyboard.press('Enter');
    await expect(page.locator('[role=alertdialog]').filter({ hasText: 'حُفظت الرسوم' })).toBeVisible();
    await expect(inbox(page).filter({ hasText: payer }).first()).toContainText('9.99');

    // A assigns; the last customer used is offered first next time
    const row = inbox(page).filter({ hasText: payer }).first();
    await row.focus();
    await page.keyboard.press('a');
    const assign = page.getByRole('dialog', { name: 'تخصيص لعميل' });
    await expect(assign.getByRole('combobox', { name: 'العميل' })).toBeFocused();
    await assign.getByRole('combobox', { name: 'العميل' }).fill('هشام');
    await page.getByRole('option', { name: /هشام الزعبي/ }).click();
    await assign.getByRole('button', { name: 'تخصيص' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await inbox(page).first().focus();
    await page.keyboard.press('a');
    // the focus is in the search; the list has the last customer used on top
    const picker = page.getByRole('dialog', { name: 'تخصيص لعميل' }).getByRole('combobox', { name: 'العميل' });
    await expect(picker).toBeFocused();
    await picker.press('ArrowDown');
    await expect(page.getByRole('option').first()).toContainText('هشام الزعبي');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // a saved view: filters back with one click
    await page.locator('main').getByRole('button', { name: /كل العملات/ }).click();
    await page.getByRole('option', { name: 'EUR' }).click();
    await page.getByRole('button', { name: 'طرق العرض' }).click();
    await page.getByRole('textbox', { name: 'اسم العرض' }).fill('يورو فقط');
    await page.getByRole('dialog', { name: 'طرق العرض' }).getByRole('button', { name: 'حفظ' }).click();
    await expect(page.getByRole('dialog', { name: 'طرق العرض' })).toHaveCount(0);
    await page.locator('main').getByRole('button', { name: /EUR/ }).click();
    await page.getByRole('option', { name: 'كل العملات' }).click();
    await page.getByRole('button', { name: 'طرق العرض' }).click();
    await page.getByRole('dialog', { name: 'طرق العرض' }).getByRole('button', { name: 'يورو فقط', exact: true }).click();
    await expect(page.locator('main').getByRole('button', { name: /EUR/ })).toBeVisible();
    expect(errors).toEqual([]);
  });
}
