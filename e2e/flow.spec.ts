import { expect, test, type Page } from '@playwright/test';

// Full money flow from SPEC §10 against the in-browser mock backend:
// create customer → manual transaction → fee → assign → approve → payout → remaining balance.
// 500.00 gross, 15.00 fee → 485.00 net; 20% commission = 97.00 → 388.00 to the customer;
// after a 100.00 payout the remaining balance is 288.00 USD.

const shot = (page: Page, theme: string, name: string) => page.screenshot({ path: `e2e/screenshots/${theme}-${name}.png` });

for (const theme of ['dark', 'light'] as const) {
  test(`create → assign → approve → payout (${theme})`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto(`/?theme=${theme}#/customers`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

    // 1. customer
    await page.getByRole('button', { name: 'إضافة عميل' }).click();
    const cust = page.getByRole('dialog');
    await cust.getByRole('textbox', { name: 'الاسم' }).fill('نادر الشامي');
    await cust.getByRole('textbox', { name: 'العمولة الافتراضية' }).fill('20');
    await cust.getByRole('button', { name: 'إضافة' }).click();
    await expect(page.getByRole('row').filter({ hasText: 'نادر الشامي' })).toContainText('20.00%');
    await shot(page, theme, '1-customer');

    // 2. manual transaction without a fee
    await page.getByRole('link', { name: 'المعاملات' }).click();
    await page.getByRole('button', { name: 'إضافة معاملة يدوياً' }).click();
    const manual = page.getByRole('dialog');
    await manual.getByRole('textbox', { name: 'المرسل', exact: true }).fill('Samer Ali');
    await manual.getByRole('textbox', { name: 'المبلغ الأصلي' }).fill('500.00');
    await manual.getByRole('button', { name: 'إضافة' }).click();
    const row = page.getByRole('row').filter({ hasText: 'Samer Ali' });
    await expect(row).toContainText('تحتاج رسوم');
    await expect(row).toContainText('500.00');
    await shot(page, theme, '2-manual');

    // 3. fee
    await row.getByRole('button', { name: 'إجراءات' }).click();
    await page.getByRole('menuitem', { name: 'تعديل الرسوم' }).click();
    const fee = page.getByRole('dialog');
    await fee.getByRole('textbox', { name: 'الرسوم' }).fill('15.00');
    await expect(fee.getByRole('textbox', { name: 'الصافي' })).toHaveValue('485.00');
    await shot(page, theme, '3-fee');
    await fee.getByRole('button', { name: 'حفظ' }).click();
    await expect(row).toContainText('485.00');

    // 4. assign with live preview
    await row.getByRole('button', { name: 'إجراءات' }).click();
    await page.getByRole('menuitem', { name: 'تخصيص لعميل' }).click();
    const assign = page.getByRole('dialog');
    await assign.getByRole('combobox', { name: 'العميل' }).fill('نادر');
    await page.getByRole('option', { name: /نادر الشامي/ }).click();
    await expect(assign).toContainText('97.00');
    await expect(assign).toContainText('388.00');
    await shot(page, theme, '4-assign');
    await assign.getByRole('button', { name: 'تخصيص', exact: true }).click();
    await expect(row).toContainText('بانتظار الموافقة');

    // 5. approve, the confirmation shows the amount
    await row.getByRole('button', { name: 'إجراءات' }).click();
    await page.getByRole('menuitem', { name: 'اعتماد' }).click();
    const approve = page.getByRole('dialog');
    await expect(approve).toContainText('388.00');
    await shot(page, theme, '5-approve');
    await approve.getByRole('button', { name: 'اعتماد' }).click();
    await expect(row).toContainText('معتمدة');

    // 6. payout from the customer's ledger
    await page.getByRole('link', { name: 'العملاء' }).click();
    await page.getByRole('row').filter({ hasText: 'نادر الشامي' }).getByRole('rowheader').click();
    await expect(page.getByRole('heading', { name: 'نادر الشامي' })).toBeVisible();
    await page.getByRole('button', { name: 'تسجيل دفعة' }).click();
    const payout = page.getByRole('dialog');
    await payout.getByRole('textbox', { name: 'المبلغ' }).fill('100.00');
    await payout.getByRole('button', { name: 'متابعة' }).click();
    const confirm = page.getByRole('dialog');
    await expect(confirm).toContainText('-100.00');
    await shot(page, theme, '6-payout');
    await confirm.getByRole('button', { name: 'تسجيل الدفعة' }).click();

    // 7. remaining balance
    const card = page.locator('div').filter({ hasText: /^المتبقي له/ }).first();
    await expect(card).toContainText('288.00');
    await expect(page.locator('tfoot')).toContainText('288.00 USD');
    await shot(page, theme, '7-balance');

    expect(errors).toEqual([]);
  });
}
