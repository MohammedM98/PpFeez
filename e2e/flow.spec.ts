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
    // numbers in the generated description are isolated so "20.00%" keeps its order in RTL
    await expect(page.getByRole('cell', { name: /Samer Ali/ })).toContainText('\u206620.00%\u2069');
    await shot(page, theme, '7-balance');

    expect(errors).toEqual([]);
  });
}

for (const theme of ['dark', 'light'] as const) {
  test(`pull range dialog (${theme})`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`/?theme=${theme}#/transactions`);

    await page.getByRole('button', { name: 'سحب المعاملات' }).click();
    const dialog = page.getByRole('dialog');
    // mailbox was pulled before, so "new since last pull" is the default
    await expect(dialog.getByRole('radio', { name: 'الجديد منذ آخر سحب' })).toBeChecked();

    // an inverted date range is refused before anything is sent
    await dialog.getByText('من تاريخ إلى تاريخ').click();
    // segments run YYYY MM DD for the start then the end (fields use the YYYY-MM-DD locale)
    const segs = dialog.getByRole('spinbutton');
    for (const [i, v] of ['2026', '10', '20', '2026', '10', '05'].entries()) {
      await segs.nth(i).click();
      await segs.nth(i).pressSequentially(v);
    }
    await expect(dialog).toContainText('تاريخ البداية بعد تاريخ النهاية');
    await expect(dialog.getByRole('button', { name: 'بدء السحب' })).toBeDisabled();
    await page.screenshot({ path: `e2e/screenshots/${theme}-8-pull-range-invalid.png` });

    // last 7 days runs and the progress bar names the range
    await dialog.getByText('آخر 7 أيام').click();
    await page.screenshot({ path: `e2e/screenshots/${theme}-9-pull-range.png` });
    await dialog.getByRole('button', { name: 'بدء السحب' }).click();
    await expect(page.getByRole('progressbar')).toBeVisible();
    await expect(page.getByRole('status').filter({ has: page.getByRole('progressbar') })).toContainText('آخر 7 أيام');
    await page.screenshot({ path: `e2e/screenshots/${theme}-10-pull-progress.png` });
    await expect(page.getByText(/انتهى السحب من Gmail الرئيسي \(آخر 7 أيام\)/)).toBeVisible({ timeout: 20_000 });

    // the run is recorded with its range in the pull history
    await page.getByRole('link', { name: 'الإعدادات' }).click();
    await expect(page.locator('#pulls tbody tr').first()).toContainText('آخر 7 أيام');
    expect(errors).toEqual([]);
  });
}

for (const theme of ['dark', 'light'] as const) {
  test(`auto-update (${theme})`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    // an update found by the silent check offers itself with its notes
    await page.goto(`/?theme=${theme}&update=1#/dashboard`);
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('يتوفر إصدار جديد');
    await expect(dialog).toContainText('0.2.0');
    await expect(dialog).toContainText('اختيار نطاق السحب');
    await page.screenshot({ path: `e2e/screenshots/${theme}-11-update.png` });
    await dialog.getByRole('button', { name: 'لاحقاً' }).click();
    await expect(dialog).toBeHidden();

    // a bad signature is refused with an Arabic message and nothing is installed
    await page.goto(`/?theme=${theme}&updateError=signature#/dashboard`);
    await page.reload();
    await page.getByRole('button', { name: 'تحديث الآن' }).click();
    await expect(page.getByRole('dialog')).toContainText('فشل التحقق من توقيع التحديث', { timeout: 15_000 });

    // manual check with nothing new
    await page.goto(`/?theme=${theme}#/settings`);
    await page.reload();
    await page.getByRole('button', { name: 'التحقق من التحديثات' }).click();
    await expect(page.getByText('لديك أحدث إصدار')).toBeVisible();
    expect(errors).toEqual([]);
  });
}

for (const theme of ['dark', 'light'] as const) {
  test(`0.2.1 review, PayPal domains and empty pull (${theme})`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    // a generic-parser transaction needs review: no approval until the data is confirmed
    await page.goto(`/?theme=${theme}#/transactions?detail=19`);
    const panel = page.getByRole('complementary', { name: 'تفاصيل المعاملة' });
    await expect(panel).toContainText('تحتاج مراجعة قبل الاعتماد');
    await panel.getByRole('button', { name: 'تعديل البيانات' }).first().click();
    const edit = page.getByRole('dialog');
    await edit.getByRole('textbox', { name: 'المبلغ الأصلي' }).fill('1250.00');
    await edit.getByRole('button', { name: 'حفظ' }).click();
    await expect(panel).toContainText('1,250.00');
    await panel.getByRole('button', { name: 'تأكيد البيانات' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'البيانات صحيحة' }).click();
    await expect(panel).not.toContainText('تحتاج مراجعة قبل الاعتماد');
    await page.screenshot({ path: `e2e/screenshots/${theme}-12-review-confirmed.png` });

    // trust an unknown PayPal domain from Messages → Ignored; its emails are re-parsed
    await page.goto(`/?theme=${theme}#/emails?tab=ignored`);
    await page.reload();
    await page.getByRole('button', { name: 'الوثوق بهذا النطاق' }).first().click();
    const trust = page.getByRole('dialog');
    await expect(trust).toContainText('paypal.com.eg');
    await expect(trust).toContainText('رسالتان متجاهلتان');
    await page.screenshot({ path: `e2e/screenshots/${theme}-13-trust-domain.png` });
    await trust.getByRole('button', { name: 'الوثوق وإعادة التحليل' }).click();
    await expect(page.getByText('أصبح paypal.com.eg موثوقاً')).toBeVisible();

    // the trusted domain is listed under extra PayPal domains and can be removed
    await page.getByRole('link', { name: 'الإعدادات' }).click();
    const extra = page.getByRole('list', { name: 'النطاقات المضافة' });
    await expect(extra).toContainText('paypal.com.eg');
    await extra.getByRole('button', { name: 'حذف paypal.com.eg' }).click();
    await expect(page.getByRole('list', { name: 'النطاقات المضافة' })).toHaveCount(0);

    // a successful pull that finds nothing says so plainly
    await page.goto(`/?theme=${theme}&pullEmpty=1#/transactions`);
    await page.reload();
    await page.getByRole('button', { name: 'سحب المعاملات' }).click();
    await page.getByRole('dialog').getByText('كل الرسائل').click();
    await page.getByRole('button', { name: 'بدء السحب' }).click();
    await expect(page.locator('header').first()).toContainText('لم تُوجد رسائل من PayPal في هذه الفترة', { timeout: 10_000 });
    await page.screenshot({ path: `e2e/screenshots/${theme}-14-empty-pull.png` });
    expect(errors).toEqual([]);
  });
}

for (const theme of ['dark', 'light'] as const) {
  test(`currency filter on an empty database (${theme})`, async ({ page }) => {
    await page.goto(`/?theme=${theme}&empty=1#/transactions`);
    const currency = page.locator('main').getByRole('button', { name: /كل العملات/ });
    await expect(currency).toBeVisible();
    await expect(currency).toHaveText(/كل العملات/);

    // a write to React Aria's hidden native <select> (autofill / form restore in the
    // Windows webview) must not change the filter: this is what showed "USD" in 0.2.0
    await page.evaluate(() => {
      const s = document.querySelector('main select') as HTMLSelectElement;
      s.value = 'USD';
      s.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect(currency).toHaveText(/كل العملات/);
    await page.screenshot({ path: `e2e/screenshots/${theme}-15-empty-db.png` });

    // choosing a currency by hand still works, and back to all
    await currency.click();
    await page.getByRole('option', { name: 'EUR' }).click();
    const eur = page.locator('main').getByRole('button', { name: /EUR/ });
    await expect(eur).toBeVisible();
    await eur.click();
    await page.getByRole('option', { name: 'كل العملات' }).click();
    await expect(page.locator('main').getByRole('button', { name: /كل العملات/ })).toBeVisible();
  });
}
