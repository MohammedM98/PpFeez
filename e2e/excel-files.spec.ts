import { expect, test, type Page } from '@playwright/test';

/*
 * 0.5.2 — several Excel files per customer (SPEC 6.8.4): start a new file (carried balance by default),
 * the customer's files list (current / previous, make current, remove from the list), the destination
 * of a manual add, and the list surviving "إلغاء الربط". Mock: هشام الزعبي (8) has one file with #1-3
 * and payout 1 in it.
 */

const chip = (page: Page) => page.getByTestId('customer-excel').getByRole('button', { name: /ملف Excel للعميل/ });
const toast = (page: Page, text: string | RegExp) => page.locator('[role=alertdialog]').filter({ hasText: text });
const row = (page: Page, text: string) => page.locator('main table tbody tr').filter({ hasText: text });
const menu = async (page: Page, item: string | RegExp) => {
  await chip(page).click();
  await page.getByRole('menuitem', { name: item }).click();
};

for (const theme of ['dark', 'light'] as const) {
  test(`0.5.2 several files per customer (${theme})`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`/?theme=${theme}#/customers/8`);
    await expect(chip(page)).toContainText('لم تُصدَّر 6');

    // a transfer number that doesn't exist is refused, nothing is created
    await menu(page, 'بدء ملف جديد…');
    let d = page.getByRole('dialog', { name: /بدء ملف جديد/ });
    await d.getByText('من رقم حوالة #').click();
    await d.getByRole('textbox', { name: 'رقم الحوالة #' }).fill('99');
    await d.getByRole('button', { name: 'اختيار مكان الحفظ وإنشاء' }).click();
    await expect(d.getByRole('alert')).toContainText('لا حوالة معتمدة برقم #99');

    // the default: a carried balance; the new file becomes current and everything before is covered
    await d.getByText('رصيد مرحّل فقط').click();
    await page.screenshot({ animations: 'disabled', path: `e2e/screenshots/${theme}-46-excel-new-file.png` });
    await d.getByRole('button', { name: 'اختيار مكان الحفظ وإنشاء' }).click();
    await expect(toast(page, 'بدأ ملف جديد، وصار الملف الحالي')).toBeVisible();
    await expect(chip(page)).toContainText('محدَّث');
    await expect(row(page, '#7').locator('[data-excel]')).toHaveAttribute('data-excel', 'exported');

    // the files list: the new one current, the old one previous
    await menu(page, /ملفات العميل/);
    d = page.getByRole('dialog', { name: 'ملفات هشام الزعبي' });
    const items = d.getByRole('list', { name: 'ملفات العميل' }).getByRole('listitem');
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toContainText('الحالي');
    await expect(items.nth(0)).toContainText('برصيد مرحّل');
    await expect(items.nth(1)).toContainText('سابق');
    await page.screenshot({ animations: 'disabled', path: `e2e/screenshots/${theme}-47-excel-files.png` });
    await d.getByRole('button', { name: 'تم' }).click();

    // a manual add can go to the previous file, where #7 is not yet
    await row(page, '#7').getByRole('checkbox').check({ force: true });
    await page.keyboard.press('Escape');
    await page.locator('body').press('e');
    const add = page.getByRole('dialog', { name: 'إضافة إلى ملف العميل' });
    await expect(add).toContainText('موجودة أصلاً في ملف العميل: 1');
    await add.getByRole('button', { name: /الوجهة/ }).click();
    await page.getByRole('option', { name: /ملف سابق: كشف حساب - هشام الزعبي$/ }).click();
    await expect(add).toContainText('ستُضاف سطر واحد');
    await page.screenshot({ animations: 'disabled', path: `e2e/screenshots/${theme}-48-excel-destination.png` });
    await add.getByRole('button', { name: 'إضافة سطر واحد' }).click();
    await expect(toast(page, 'أُضيف سطر واحد إلى ملف العميل')).toBeVisible();

    // back to the previous file as current: its own export state shows (#7 is in it now)
    await menu(page, /ملفات العميل/);
    d = page.getByRole('dialog', { name: 'ملفات هشام الزعبي' });
    await d.getByRole('button', { name: 'اجعله الحالي' }).click();
    await expect(toast(page, /الملف الحالي/)).toBeVisible();
    await expect(d.getByRole('list', { name: 'ملفات العميل' }).getByRole('listitem').nth(0)).toContainText('بكل الحركات');
    // the other one can leave the list (the file itself stays)
    await d.getByRole('button', { name: /^إزالة .* من القائمة$/ }).click();
    await expect(d.getByRole('list', { name: 'ملفات العميل' }).getByRole('listitem')).toHaveCount(1);
    await d.getByRole('button', { name: 'تم' }).click();
    await expect(chip(page)).toContainText('لم تُصدَّر 5');
    await expect(row(page, '#7').locator('[data-excel]')).toHaveAttribute('data-excel', 'exported');

    // unlinking keeps the list: the file can become current again from it
    await menu(page, 'إلغاء الربط');
    await page.getByRole('dialog').getByRole('button', { name: 'إلغاء الربط' }).click();
    await expect(chip(page)).toContainText('غير مرتبط');
    await menu(page, /ملفات العميل السابقة/);
    await page.getByRole('dialog', { name: 'ملفات هشام الزعبي' }).getByRole('button', { name: 'اجعله الحالي' }).click();
    await page.getByRole('dialog', { name: 'ملفات هشام الزعبي' }).getByRole('button', { name: 'تم' }).click();
    await expect(chip(page)).toContainText('لم تُصدَّر 5');
    expect(errors).toEqual([]);
  });
}
