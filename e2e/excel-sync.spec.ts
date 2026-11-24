import { expect, test, type Page } from '@playwright/test';

/*
 * 0.5.1 — the customer's Excel file keeps itself up to date (SPEC 6.8.3) and manual adds follow the
 * statement order (SPEC 6.8.3, commit 01a0e29). Mock data: هشام الزعبي (customer 8) has a file with
 * #1-3 and payout 1 in it; #4-8 and the return are not exported (6 lines).
 */

const shot = (page: Page, theme: string, name: string) => page.screenshot({ animations: 'disabled', path: `e2e/screenshots/${theme}-${name}.png` });
const toast = (page: Page, text: string | RegExp) => page.locator('[role=alertdialog]').filter({ hasText: text });
const chip = (page: Page) => page.getByTestId('customer-excel').getByRole('button', { name: /ملف Excel للعميل/ });
const row = (page: Page, text: string | RegExp) => page.locator('main table tbody tr').filter({ hasText: text });
const more = async (page: Page, item: string) => {
  await page.getByRole('button', { name: 'المزيد' }).click();
  await page.getByRole('menuitem', { name: item }).click();
};
const adjustment = async (page: Page, amount: string, description: string) => {
  await more(page, 'قيد تسوية');
  const d = page.getByRole('dialog');
  await d.getByRole('textbox', { name: 'المبلغ' }).fill(amount);
  await d.getByRole('textbox', { name: 'الوصف' }).fill(description);
  await d.getByRole('button', { name: 'متابعة' }).click();
  // auto-sync is on: no "add to the customer's file" checkbox (SPEC 6.8.3)
  await expect(page.getByRole('dialog').getByRole('checkbox', { name: /أضف إلى ملف العميل/ })).toHaveCount(0);
  await page.getByRole('dialog').getByRole('button', { name: 'تسجيل التسوية' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
};

for (const theme of ['dark', 'light'] as const) {
  test(`0.5.1 automatic sync and a locked file (${theme})`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`/?theme=${theme}#/customers/8`);
    await expect(chip(page)).toContainText('لم تُصدَّر 6');
    await expect(page.getByRole('button', { name: 'إرسال غير المُصدَّر (6)' })).toBeVisible();
    await expect(row(page, '#1').locator('[data-excel]')).toHaveAttribute('data-excel', 'exported');
    await expect(row(page, '#4').locator('[data-excel]')).toContainText('لم تُصدَّر');

    // a money event is written to the file in the background
    await adjustment(page, '5.00', 'تصحيح فرق تحويل');
    await expect(toast(page, 'أُضيف لملف هشام الزعبي')).toBeVisible();
    await expect(row(page, 'تصحيح فرق تحويل').locator('[data-excel]')).toHaveAttribute('data-excel', 'exported');
    await expect(chip(page)).toContainText('لم تُصدَّر 6');

    // the file is open in Excel: the row waits, the warning says why and offers "إرسال الآن"
    await page.evaluate(() => (window as unknown as { __ppfeezMock: { setExcelLocked: (v: boolean) => void } }).__ppfeezMock.setExcelLocked(true));
    await adjustment(page, '3.00', 'خصم رسوم بنك');
    const warn = toast(page, 'الملف مفتوح في Excel');
    await expect(warn).toContainText('لم يُضف لملف هشام الزعبي');
    await expect(warn.getByRole('button', { name: 'إرسال الآن' })).toBeVisible();
    await expect(row(page, 'خصم رسوم بنك').locator('[data-excel]')).toHaveAttribute('data-excel', 'pending');
    await expect(row(page, 'خصم رسوم بنك')).toContainText('بانتظار');
    await expect(chip(page)).toContainText('بانتظار التصدير 1');
    await shot(page, theme, '40-excel-locked');

    // closed again: "إرسال الآن" writes what waited and what was never exported, in statement order
    await page.evaluate(() => (window as unknown as { __ppfeezMock: { setExcelLocked: (v: boolean) => void } }).__ppfeezMock.setExcelLocked(false));
    await warn.getByRole('button', { name: 'إرسال الآن' }).click();
    await expect(toast(page, 'أُضيف 7 حركات إلى ملف هشام الزعبي')).toBeVisible();
    await expect(chip(page)).toContainText('محدَّث');
    await expect(page.getByRole('button', { name: /إرسال غير المُصدَّر/ })).toHaveCount(0);
    await expect(row(page, 'خصم رسوم بنك').locator('[data-excel]')).toHaveAttribute('data-excel', 'exported');
    expect(errors).toEqual([]);
  });

  test(`0.5.1 filter, statement order, shortcuts and range (${theme})`, async ({ page }) => {
    await page.goto(`/?theme=${theme}#/customers/8`);
    await expect(chip(page)).toContainText('لم تُصدَّر 6');

    // the filter shows only what is not in the file
    await page.locator('main').getByRole('button', { name: /عرض/ }).click();
    await page.getByRole('option', { name: 'غير المُصدَّر إلى Excel' }).click();
    await expect(page.locator('main table[aria-label="كشف USD"] tbody tr')).toHaveCount(6);

    // picked #7, then #5, then #6: the preview (and the file) follow the statement: #5, #6, #7
    for (const n of ['#7', '#5', '#6']) await row(page, n).getByRole('checkbox').check({ force: true });
    await page.keyboard.press('Escape');
    await page.locator('body').press('e');
    const preview = page.getByRole('dialog');
    await expect(preview).toContainText('ستُضاف 3 أسطر');
    const lines = await preview.locator('ul').first().locator('li').allTextContents();
    expect(lines.map((l) => /#(\d+)/.exec(l)?.[1])).toEqual(['5', '6', '7']);
    await shot(page, theme, '41-excel-order');
    await preview.getByRole('button', { name: 'إضافة 3 أسطر' }).click();
    await expect(toast(page, 'أُضيف 3 أسطر إلى ملف العميل')).toBeVisible();
    await expect(chip(page)).toContainText('لم تُصدَّر 3');

    // one row from its menu
    await row(page, '#4').getByRole('button', { name: 'إجراءات الحوالة' }).click();
    await page.getByRole('menuitem', { name: /إضافة إلى ملف العميل/ }).click();
    await expect(page.getByRole('dialog')).toContainText('ستُضاف سطر واحد');
    await page.getByRole('dialog').getByRole('button', { name: 'تراجع' }).click();

    // a range by numbers: #3-#6 brings payout 1 (already in the file) unless "الحوالات فقط"
    await page.getByRole('button', { name: 'تصدير وطباعة' }).click();
    await page.getByRole('menuitem', { name: 'إضافة نطاق إلى ملف العميل…' }).click();
    const range = page.getByRole('dialog');
    await range.getByRole('textbox', { name: 'من #' }).fill('3');
    await range.getByRole('textbox', { name: 'إلى #' }).fill('6');
    await range.getByRole('button', { name: 'معاينة' }).click();
    await expect(page.getByRole('dialog')).toContainText('ستُضاف سطر واحد');
    await expect(page.getByRole('dialog')).toContainText('موجودة أصلاً في ملف العميل: 4');
    await page.getByRole('dialog').getByRole('button', { name: 'تراجع' }).click();
    await page.getByRole('button', { name: 'تصدير وطباعة' }).click();
    await page.getByRole('menuitem', { name: 'إضافة نطاق إلى ملف العميل…' }).click();
    await page.getByRole('dialog').getByRole('textbox', { name: 'من #' }).fill('3');
    await page.getByRole('dialog').getByRole('textbox', { name: 'إلى #' }).fill('6');
    await page.getByRole('dialog').getByRole('checkbox', { name: /الحوالات فقط/ }).check({ force: true });
    await page.getByRole('dialog').getByRole('button', { name: 'معاينة' }).click();
    await expect(page.getByRole('dialog')).toContainText('موجودة أصلاً في ملف العميل: 3');
    await page.getByRole('dialog').getByRole('button', { name: 'إضافة سطر واحد' }).click();
    await expect(chip(page)).toContainText('لم تُصدَّر 2');

    // Shift+E: everything not exported
    await page.locator('body').press('Shift+E');
    await expect(toast(page, 'أُضيف حركتان إلى ملف هشام الزعبي')).toBeVisible();
    await expect(chip(page)).toContainText('محدَّث');
  });

  test(`0.5.1 auto-sync switch, dashboard and Ctrl+K (${theme})`, async ({ page }) => {
    await page.goto(`/?theme=${theme}#/customers/8`);
    // switched off, the dialogs offer the checkbox again; switched back on with unexported lines, it asks
    await chip(page).click();
    await page.getByRole('menuitem', { name: 'إيقاف المزامنة التلقائية' }).click();
    await expect(chip(page)).toContainText('يدوي');
    await more(page, 'قيد تسوية');
    await page.getByRole('dialog').getByRole('textbox', { name: 'المبلغ' }).fill('1.00');
    await page.getByRole('dialog').getByRole('textbox', { name: 'الوصف' }).fill('اختبار');
    await page.getByRole('dialog').getByRole('button', { name: 'متابعة' }).click();
    await expect(page.getByRole('dialog').getByRole('checkbox', { name: /أضف إلى ملف العميل/ })).toBeVisible();
    // what was typed is not lost by accident: Esc asks first (SPEC 6.10)
    await page.keyboard.press('Escape');
    await page.getByRole('alertdialog', { name: 'تجاهل التغييرات؟' }).getByRole('button', { name: 'تجاهل' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await chip(page).click();
    await page.getByRole('menuitem', { name: 'تفعيل المزامنة التلقائية' }).click();
    const ask = page.getByRole('dialog', { name: 'إرسالها الآن؟' });
    await expect(ask).toContainText('يوجد 6 حركات غير مُصدّرة');
    await shot(page, theme, '42-excel-auto-on');
    await ask.getByRole('button', { name: 'لاحقاً' }).click();
    await expect(chip(page)).not.toContainText('يدوي');

    // dashboard: what is behind in all files, sent customer by customer, with a report
    await page.getByRole('link', { name: 'لوحة التحكم' }).click();
    const card = page.getByRole('region', { name: 'غير المُصدَّر لملفات العملاء' });
    await expect(card).toContainText('حركات غير مُصدّرة لملفات العملاء: 11');
    await expect(card).toContainText('لدى عميلين');
    await shot(page, theme, '43-excel-dashboard');
    await card.getByRole('button', { name: 'إرسال الكل' }).click();
    const report = page.getByRole('dialog', { name: 'نتيجة الإرسال لملفات العملاء' });
    await expect(report).toContainText('هشام الزعبي');
    await expect(report).toContainText('أُضيف 6 حركات');
    await expect(report).toContainText('علي حسن');
    await report.getByRole('button', { name: 'تم' }).click();
    await expect(card).toHaveCount(0);

    // Ctrl+K: nothing left to send, so no command
    await page.keyboard.press('Control+k');
    await page.getByRole('dialog', { name: 'البحث في كل المعاملات' }).getByRole('searchbox').fill('إرسال');
    await expect(page.getByRole('option', { name: /إرسال غير المُصدَّر/ })).toHaveCount(0);
  });

  test(`0.5.1 Ctrl+K sends a customer's unexported lines (${theme})`, async ({ page }) => {
    await page.goto(`/?theme=${theme}#/dashboard`);
    await expect(page.getByRole('heading', { name: 'لوحة التحكم' })).toBeVisible();
    await page.keyboard.press('Control+k');
    await page.getByRole('dialog', { name: 'البحث في كل المعاملات' }).getByRole('searchbox').fill('هشام');
    const cmd = page.getByRole('option', { name: 'إرسال غير المُصدَّر لـ هشام الزعبي' });
    await expect(cmd).toContainText('6 حركات ليست في ملفه');
    await shot(page, theme, '44-excel-palette');
    await cmd.click();
    await expect(toast(page, 'أُضيف 6 حركات إلى ملف هشام الزعبي')).toBeVisible();
  });
}
