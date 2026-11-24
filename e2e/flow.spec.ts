import { expect, test, type Page } from '@playwright/test';

// Full money flow from SPEC §10 against the in-browser mock backend:
// create customer → manual transaction → fee → assign → approve → payout → remaining balance.
// 500.00 gross, 15.00 fee → 485.00 net; 20% commission = 97.00 → 388.00 to the customer;
// after a 100.00 payout the remaining balance is 288.00 USD.

/** the customer page keeps one primary action in its header; the rest are under "المزيد" (SPEC 6.5) */
const more = async (page: Page, item: string) => {
  await page.getByRole('button', { name: 'المزيد' }).click();
  await page.getByRole('menuitem', { name: item }).click();
};
/** the Excel chip in the customer header and its menu (SPEC 6.8.3) */
const excelChip = (page: Page) => page.getByTestId('customer-excel').getByRole('button', { name: /ملف Excel للعميل/ });

const shot = (page: Page, theme: string, name: string) => page.screenshot({ animations: 'disabled', path: `e2e/screenshots/${theme}-${name}.png` });

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
    // SPEC 6.3: an assigned row leaves the inbox; the toast offers "open" and "undo"
    await expect(row).toHaveCount(0);
    const moved = page.locator('[role=alertdialog]').filter({ hasText: 'نُقلت إلى نادر الشامي' });
    await expect(moved).toBeVisible();
    await shot(page, theme, '4b-moved');
    await moved.getByRole('button', { name: 'تراجع' }).click();
    await expect(page.getByText('أُعيدت إلى الوارد')).toBeVisible();
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'إجراءات' }).click();
    await page.getByRole('menuitem', { name: 'تخصيص لعميل' }).click();
    await page.getByRole('dialog').getByRole('combobox', { name: 'العميل' }).fill('نادر');
    await page.getByRole('option', { name: /نادر الشامي/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'تخصيص', exact: true }).click();
    await page.locator('[role=alertdialog]').filter({ hasText: 'نُقلت إلى نادر الشامي' }).getByRole('button', { name: 'فتح' }).click();

    // 5. on the customer's page, "awaiting approval": approve, the confirmation shows the amount
    await expect(page.getByRole('heading', { name: 'نادر الشامي' })).toBeVisible();
    await expect(page.getByRole('tab', { name: /بانتظار الموافقة/ })).toHaveAttribute('aria-selected', 'true');
    const pending = page.getByRole('row').filter({ hasText: 'Samer Ali' });
    await expect(pending).toContainText('388.00');
    // "فتح" opened the transaction's panel: approve from there
    const panel = page.getByRole('complementary', { name: 'تفاصيل المعاملة' });
    await panel.getByRole('button', { name: /اعتماد/ }).click();
    const approve = page.getByRole('dialog');
    await expect(approve).toContainText('388.00');
    await shot(page, theme, '5-approve');
    await approve.getByRole('button', { name: 'اعتماد' }).click();
    await expect(pending).toHaveCount(0);
    await panel.getByRole('button', { name: 'إغلاق' }).click();
    // approved transfers live in the statement, numbered (SPEC 6.5)
    await page.getByRole('tab', { name: 'كشف USD' }).click();
    await expect(page.getByRole('row').filter({ hasText: 'Samer Ali' })).toContainText('388.00');
    await expect(page.getByRole('row').filter({ hasText: 'Samer Ali' })).toContainText('#1');

    // 6. payout from the same page
    await more(page, 'تسجيل دفعة');
    const payout = page.getByRole('dialog');
    await payout.getByRole('textbox', { name: 'المبلغ' }).fill('100.00');
    await payout.getByRole('button', { name: 'متابعة' }).click();
    const confirm = page.getByRole('dialog');
    await expect(confirm).toContainText('-100.00');
    await shot(page, theme, '6-payout');
    await confirm.getByRole('button', { name: 'تسجيل الدفعة' }).click();

    // 7. remaining balance, in the summary and the statement's closing line
    await expect(page.getByRole('region', { name: 'ملخص USD' })).toContainText('288.00');
    await expect(page.getByRole('table', { name: 'الرصيد الختامي' })).toContainText(/الرصيد الختامي USD.*288\.00/);
    await shot(page, theme, '7-balance');

    // 8. Ctrl+K finds it from anywhere and says where it lives; a result opens there
    await page.getByRole('link', { name: 'لوحة التحكم' }).click();
    await page.keyboard.press('Control+k');
    const search = page.getByRole('dialog', { name: 'البحث في كل المعاملات' });
    await search.getByRole('searchbox').fill('Samer');
    const hit = search.getByRole('option').filter({ hasText: 'Samer Ali' });
    await expect(hit).toContainText('نادر الشامي · معتمدة');
    await shot(page, theme, '7b-search');
    await hit.click();
    await expect(page.getByRole('heading', { name: 'نادر الشامي' })).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'تفاصيل المعاملة' })).toContainText('Samer Ali');
    await expect(page.getByRole('row').filter({ hasText: 'Samer Ali' })).toBeVisible();

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
    await page.screenshot({ animations: 'disabled', path: `e2e/screenshots/${theme}-8-pull-range-invalid.png` });

    // last 7 days runs and the progress bar names the range
    await dialog.getByText('آخر 7 أيام').click();
    await page.screenshot({ animations: 'disabled', path: `e2e/screenshots/${theme}-9-pull-range.png` });
    await dialog.getByRole('button', { name: 'بدء السحب' }).click();
    await expect(page.getByRole('progressbar')).toBeVisible();
    await expect(page.getByRole('status').filter({ has: page.getByRole('progressbar') })).toContainText('آخر 7 أيام');
    await page.screenshot({ animations: 'disabled', path: `e2e/screenshots/${theme}-10-pull-progress.png` });
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
    await page.screenshot({ animations: 'disabled', path: `e2e/screenshots/${theme}-11-update.png` });
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
    await page.screenshot({ animations: 'disabled', path: `e2e/screenshots/${theme}-12-review-confirmed.png` });

    // trust an unknown PayPal domain from Messages → Ignored; its emails are re-parsed
    await page.goto(`/?theme=${theme}#/emails?tab=ignored`);
    await page.reload();
    await page.getByRole('button', { name: 'الوثوق بهذا النطاق' }).first().click();
    const trust = page.getByRole('dialog');
    await expect(trust).toContainText('paypal.com.eg');
    await expect(trust).toContainText('رسالتان متجاهلتان');
    await page.screenshot({ animations: 'disabled', path: `e2e/screenshots/${theme}-13-trust-domain.png` });
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
    await page.screenshot({ animations: 'disabled', path: `e2e/screenshots/${theme}-14-empty-pull.png` });
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
    await page.screenshot({ animations: 'disabled', path: `e2e/screenshots/${theme}-15-empty-db.png` });

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

for (const theme of ['dark', 'light'] as const) {
  test(`0.3.0 delete transactions, entries, customers and reset (${theme})`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const shot = (n: string) => page.screenshot({ animations: 'disabled', path: `e2e/screenshots/${theme}-${n}.png` });

    // 1. approved transaction: the preview shows the balance change, then the balance moves
    await page.goto(`/?theme=${theme}#/customers/2?tab=USD`);
    const row = page.getByRole('row').filter({ hasText: 'Noah Smith' });
    await row.getByRole('button', { name: 'إجراءات الحوالة' }).click();
    await page.getByRole('menuitem', { name: 'حذف' }).click();
    const del = page.getByRole('dialog');
    await expect(del).toContainText('سيُحذف قيد واحد من دفاتر العملاء');
    await expect(del).toContainText('رصيد علي حسن');
    await expect(del).toContainText('-231.38');
    await shot('16-delete-approved');
    await del.getByRole('button', { name: 'حذف نهائياً' }).click();
    await expect(page.getByText('حُذفت المعاملة')).toBeVisible();
    await expect(row).toHaveCount(0);

    // 2. bulk delete from the selection bar takes a backup first
    await page.getByRole('link', { name: 'المعاملات' }).click();
    await page.getByRole('row').filter({ hasText: 'Marta Nowak' }).getByRole('checkbox').check({ force: true });
    await page.getByRole('row').filter({ hasText: 'Lucas Brown' }).getByRole('checkbox').check({ force: true });
    await page.getByRole('toolbar', { name: 'إجراءات جماعية' }).getByRole('button', { name: 'حذف' }).click();
    await expect(page.getByRole('dialog')).toContainText('تُؤخذ نسخة احتياطية قبل الحذف');
    await page.getByRole('dialog').getByRole('button', { name: 'حذف نهائياً' }).click();
    await expect(page.getByText('حُذفت معاملتان')).toBeVisible();
    await expect(page.getByText(/before-delete\.db/).first()).toBeVisible();

    // 3. ledger: a credit shows why it cannot be deleted; a payout is deleted with balance before/after
    // navigate inside the app: a reload would reset the in-memory mock database
    await page.getByRole('link', { name: 'العملاء' }).click();
    await page.getByRole('row').filter({ hasText: 'أحمد يلماز' }).getByRole('rowheader').click();
    await page.getByRole('tab', { name: 'كشف USD' }).click();
    const payout = page.getByRole('row').filter({ hasText: 'دفعة نقدية في المكتب' });
    await payout.getByRole('button', { name: 'إجراءات القيد' }).click();
    await page.getByRole('menuitem', { name: 'حذف القيد' }).click();
    const entry = page.getByRole('dialog');
    await expect(entry).toContainText('الرصيد الآن');
    await expect(entry).toContainText('22.01');
    await expect(entry).toContainText('72.01');
    await shot('17-delete-entry');
    await entry.getByRole('button', { name: 'حذف نهائياً' }).click();
    await expect(page.getByText('حُذف القيد')).toBeVisible();
    await expect(page.getByRole('table', { name: 'الرصيد الختامي' })).toContainText('72.01');

    // 4. customer: disabled until the exact name is typed; transactions go back to unassigned
    await more(page, 'حذف العميل');
    const cust = page.getByRole('dialog');
    await expect(cust).toContainText('ترجع «غير مخصّصة»');
    const confirm = cust.getByRole('button', { name: 'حذف العميل ودفتره' });
    await expect(confirm).toBeDisabled();
    await cust.getByRole('textbox', { name: /اكتب اسم العميل/ }).fill('أحمد');
    await expect(confirm).toBeDisabled();
    await cust.getByRole('textbox', { name: /اكتب اسم العميل/ }).fill('أحمد يلماز');
    await shot('18-delete-customer');
    await confirm.click();
    await expect(page.getByRole('heading', { name: 'العملاء' })).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'أحمد يلماز' })).toHaveCount(0);
    await page.getByRole('link', { name: 'المعاملات' }).click();
    // back in the inbox
    await expect(page.getByRole('row').filter({ hasText: 'Website hosting' })).toBeVisible();

    // 5. deleted transactions stay out of the list; re-parse brings one back
    await page.getByRole('link', { name: 'الرسائل' }).click();
    await page.getByRole('tab', { name: /متجاهلة/ }).click();
    const gone = page.getByRole('row').filter({ hasText: 'حُذفت يدوياً' }).first();
    await expect(gone).toBeVisible();
    await gone.getByRole('button', { name: 'إجراءات' }).click();
    await page.getByRole('menuitem', { name: 'إعادة التحليل' }).click();
    await expect(page.getByText(/أُعيد تحليل 1 رسالة بنجاح/)).toBeVisible();

    // 6. start fresh: live preview, typed confirmation, then the backup path
    await page.getByRole('link', { name: 'الإعدادات' }).click();
    await page.getByRole('button', { name: 'حذف البيانات…' }).click();
    const reset = page.getByRole('dialog');
    await expect(reset).toContainText('سيُحذف');
    await expect(reset).toContainText('معاملة');
    const go = reset.getByRole('button', { name: 'حذف ما اخترته' });
    await expect(go).toBeDisabled();
    await reset.getByRole('textbox', { name: /للتأكيد/ }).fill('حذف');
    await shot('19-reset');
    await go.click();
    const result = page.getByRole('dialog');
    await expect(result).toContainText('حُذفت البيانات');
    await expect(result).toContainText('before-delete.db');
    await result.getByRole('button', { name: 'تم' }).click();
    await page.getByRole('link', { name: 'المعاملات' }).click();
    await expect(page.getByText('الوارد فارغ: كل المعاملات مخصّصة')).toBeVisible();
    expect(errors).toEqual([]);
  });
}

for (const theme of ['dark', 'light'] as const) {
  test(`0.4.0 customer transactions: bulk approve totals, move, pending customers (${theme})`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const shot = (n: string) => page.screenshot({ animations: 'disabled', path: `e2e/screenshots/${theme}-${n}.png` });

    // the dashboard's "awaiting approval" opens the customers who have something waiting
    await page.goto(`/?theme=${theme}#/dashboard`);
    await page.getByRole('link', { name: /بانتظار الموافقة/ }).click();
    await expect(page.getByRole('checkbox', { name: 'لديهم بانتظار الموافقة' })).toBeChecked();
    await expect(page.getByRole('row').filter({ hasText: 'علي حسن' })).toHaveCount(0);
    await shot('28-pending-customers');
    await page.getByRole('row').filter({ hasText: 'أحمد يلماز' }).getByRole('rowheader').click();

    // opened on "awaiting approval"; bulk approve shows the total per currency from the core
    await expect(page.getByRole('tab', { name: /بانتظار الموافقة/ })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('row').filter({ hasText: 'John Doe' }).getByRole('checkbox').check({ force: true });
    await page.getByRole('toolbar', { name: 'إجراءات جماعية' }).getByRole('button', { name: 'اعتماد' }).click();
    const bulk = page.getByRole('dialog');
    await expect(bulk).toContainText('المجموع للعملاء');
    await expect(bulk).toContainText('71.25');
    await shot('29-bulk-approve');
    await page.keyboard.press('Escape');

    // move to another customer: it leaves this page and lands on theirs
    const maria = page.getByRole('row').filter({ hasText: 'Maria Garcia' });
    await maria.getByRole('button', { name: 'إجراءات' }).click();
    await page.getByRole('menuitem', { name: 'نقل لعميل آخر' }).click();
    const move = page.getByRole('dialog');
    await expect(move).toContainText('مخصّصة الآن لـ أحمد يلماز');
    const who = move.getByRole('combobox', { name: 'العميل' });
    await who.fill('سارة');
    await page.getByRole('option', { name: /سارة المصري/ }).click();
    await move.getByRole('button', { name: 'نقل', exact: true }).click();
    await expect(maria).toHaveCount(0);
    await page.locator('[role=alertdialog]').filter({ hasText: 'نُقلت إلى سارة المصري' }).getByRole('button', { name: 'فتح' }).click();
    await expect(page.getByRole('heading', { name: 'سارة المصري' })).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'Maria Garcia' })).toBeVisible();
    await shot('30-customer-pending');
    expect(errors).toEqual([]);
  });
}

for (const theme of ['dark', 'light'] as const) {
  test(`Excel append mode and a one-time rewrite (${theme})`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const shot = (n: string) => page.screenshot({ animations: 'disabled', path: `e2e/screenshots/${theme}-${n}.png` });

    // default: add what is new and keep the owner's edits; the result says how many rows
    await page.goto(`/?theme=${theme}#/settings`);
    await page.getByRole('link', { name: 'ملف Excel' }).click();
    await expect(page.getByRole('radio', { name: /إضافة الجديد/ })).toBeChecked();
    await page.getByRole('button', { name: 'تحديث ملف Excel' }).click();
    await expect(page.getByText('حُدّث ملف Excel')).toBeVisible();
    await expect(page.getByText(/أُضيفت .*جديد.*، وحُدّث صفّان/)).toBeVisible();
    await page.locator('#excel').evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await shot('31-excel-mode');

    // a column the program writes to was renamed: nothing is written; rewrite once after a confirm
    await page.goto(`/?theme=${theme}&excelLayout=1#/settings`);
    await page.reload();
    await page.getByRole('button', { name: 'تحديث ملف Excel' }).click();
    const layout = page.getByRole('dialog');
    await expect(layout).toContainText('لم أجد عمود «العميل» في ورقة المعاملات');
    await shot('32-excel-layout');
    await layout.getByRole('button', { name: 'إعادة كتابة كاملة لهذه المرة' }).click();
    await expect(page.getByRole('dialog')).toContainText('.previous.xlsx');
    await page.getByRole('dialog').getByRole('button', { name: 'إعادة الكتابة' }).click();
    await expect(page.getByText('أُعيدت كتابة ملف Excel')).toBeVisible();
    // only that one time: the chosen mode is still append
    await expect(page.getByRole('radio', { name: /إضافة الجديد/ })).toBeChecked();
    expect(errors).toEqual([]);
  });
}

for (const theme of ['dark', 'light'] as const) {
  test(`0.4.2 customer Excel statement (${theme})`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const shot = (n: string) => page.screenshot({ animations: 'disabled', path: `e2e/screenshots/${theme}-${n}.png` });
    const toast = (text: string) => page.locator('[role=alertdialog]').filter({ hasText: text });
    const bar = () => page.getByRole('toolbar', { name: 'إجراءات على المحدد' });

    // linked statement: ✓ on what is already in it; duplicates are listed and skipped
    await page.goto(`/?theme=${theme}#/customers/2?tab=USD`);
    await expect(excelChip(page)).toContainText('لم تُصدَّر');
    await excelChip(page).click();
    await expect(page.getByTestId('customer-excel-menu')).toContainText('كشف حساب - علي حسن.xlsx');
    await page.keyboard.press('Escape');
    const opening = page.getByRole('row').filter({ hasText: 'رصيد افتتاحي' });
    await expect(opening.locator('[data-excel="exported"]')).toContainText('صُدّرت');
    await opening.getByRole('checkbox').check({ force: true });
    await page.getByRole('row').filter({ hasText: 'Noah Smith' }).getByRole('checkbox').check({ force: true });
    await bar().getByRole('button', { name: 'إضافة إلى ملف العميل' }).click();
    const add = page.getByRole('dialog');
    await expect(add).toContainText('ستُضاف سطر واحد');
    await expect(add).toContainText('موجودة أصلاً في ملف العميل: 1');
    await expect(add).toContainText('رصيد افتتاحي');
    await shot('33-statement-preview');
    await add.getByRole('button', { name: 'إضافة سطر واحد' }).click();
    await expect(toast('أُضيف سطر واحد إلى ملف العميل')).toBeVisible();
    await expect(toast('أُضيف سطر واحد إلى ملف العميل').getByRole('button', { name: 'فتح الملف' })).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'Noah Smith' }).locator('[data-excel="exported"]')).toBeVisible();

    // the rest of the statement: payouts and reversals are added, what is there is skipped
    await page.getByRole('checkbox', { name: 'تحديد كل الأسطر' }).check({ force: true });
    await bar().getByRole('button', { name: 'إضافة إلى ملف العميل' }).click();
    const all = page.getByRole('dialog');
    await expect(all).toContainText('موجودة أصلاً في ملف العميل: 2');
    await shot('34-statement-ledger');
    await all.getByRole('button', { name: /^إضافة/ }).click();
    await expect(toast('إلى ملف العميل').first()).toBeVisible();

    // unapproving a transfer that is in the statement marks it as changed
    await page.getByRole('tab', { name: 'كشف EUR' }).click();
    await page.getByRole('row').filter({ hasText: 'Hans Müller' }).getByRole('button', { name: 'إجراءات الحوالة' }).click();
    await page.getByRole('menuitem', { name: 'إلغاء الاعتماد' }).click();
    await page.getByRole('dialog').getByRole('textbox', { name: 'السبب' }).fill('خطأ');
    await page.getByRole('dialog').getByRole('button', { name: 'إلغاء الاعتماد' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('link', { name: 'المعاملات' }).click();
    await expect(page.getByRole('heading', { name: 'المعاملات' })).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'Hans Müller' })).toContainText('تغيّرت بعد إضافتها لملف العميل');

    // no statement yet: create one (with what exists), then approve with "add to the statement" on
    await page.getByRole('link', { name: 'العملاء' }).click();
    await page.getByRole('row').filter({ hasText: 'أحمد يلماز' }).getByRole('rowheader').click();
    await excelChip(page).click();
    await page.getByRole('menuitem', { name: 'إنشاء ملف للعميل…' }).click();
    const create = page.getByRole('dialog');
    await expect(create).toContainText('(1 حوالة، 1 قيد)');
    await create.getByRole('checkbox', { name: /أضف كل الحوالات المعتمدة/ }).check({ force: true });
    await shot('35-statement-create');
    await create.getByRole('button', { name: 'اختيار مكان الحفظ وإنشاء' }).click();
    await expect(toast('أُنشئ ملف العميل')).toContainText('أُضيف سطران');
    await expect(excelChip(page)).toContainText('محدَّث');
    await page.getByRole('tab', { name: /بانتظار الموافقة/ }).click();
    await page.getByRole('row').filter({ hasText: 'Website hosting' }).getByRole('button', { name: 'إجراءات' }).click();
    await page.getByRole('menuitem', { name: 'اعتماد' }).click();
    const approve = page.getByRole('dialog');
    // auto-sync is on for a new file (SPEC 6.8.3): no checkbox, the row is written in the background
    await expect(approve.getByRole('checkbox', { name: /أضف إلى ملف العميل/ })).toHaveCount(0);
    await shot('36-statement-approve');
    await approve.getByRole('button', { name: 'اعتماد' }).click();
    await expect(toast('أُضيف لملف أحمد يلماز')).toBeVisible();
    await page.getByRole('tab', { name: 'كشف USD' }).click();
    await expect(page.getByRole('row').filter({ hasText: 'Website hosting' }).locator('[data-excel="exported"]')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test(`0.4.2 customer Excel statement errors (${theme})`, async ({ page }) => {
    // the file is open in Excel: nothing is written, the dialog says so
    await page.goto(`/?theme=${theme}&customerExcelLocked=1#/customers/2?tab=USD`);
    await page.getByRole('row').filter({ hasText: 'Noah Smith' }).getByRole('checkbox').check({ force: true });
    await page.getByRole('toolbar', { name: 'إجراءات على المحدد' }).getByRole('button', { name: 'إضافة إلى ملف العميل' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'إضافة سطر واحد' }).click();
    await expect(page.getByRole('dialog')).toContainText('الملف مفتوح في Excel');

    // a customer without a statement is offered to create one
    await page.goto(`/?theme=${theme}#/customers/3?tab=USD`);
    await page.reload();
    await page.getByRole('row').filter({ hasText: 'Olivia Wilson' }).getByRole('checkbox').check({ force: true });
    await page.getByRole('toolbar', { name: 'إجراءات على المحدد' }).getByRole('button', { name: 'إضافة إلى ملف العميل' }).click();
    await expect(page.getByRole('dialog')).toContainText('لا ملف Excel لهذا العميل');
    await expect(page.getByRole('dialog').getByRole('button', { name: 'إنشاء ملف للعميل' })).toBeVisible();

    // linking a file that is not this customer's statement
    await page.goto(`/?theme=${theme}&wrongStatement=1#/customers/3`);
    await page.reload();
    await excelChip(page).click();
    await page.getByRole('menuitem', { name: 'ربط ملف موجود…' }).click();
    await expect(page.getByRole('dialog')).toContainText('ليس كشف حساب أنشأه البرنامج لهذا العميل');
  });
}

for (const theme of ['dark', 'light'] as const) {
  test(`0.5.0 statement and linked payouts (${theme})`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const shot = (n: string) => page.screenshot({ animations: 'disabled', path: `e2e/screenshots/${theme}-${n}.png` });

    // one statement per currency: transfers (له) and payouts (عليه) together, with the eight figures
    await page.goto(`/?theme=${theme}#/customers/8`);
    const summary = page.getByRole('region', { name: 'ملخص USD' });
    await expect(summary).toContainText('غير مدفوع');
    // a recorded (draft) payout only reserves its transfers: #4-8 are still not paid
    await expect(summary).toContainText('5 حوالات');
    const p1 = page.locator('tr[data-kind=payout]').filter({ hasText: 'دفعة 1' });
    await expect(p1).toContainText('695.09');
    await expect(p1).toContainText('تم الإرسال');
    await expect(page.getByRole('row').filter({ hasText: 'Liam Turner' }).first()).toContainText('نعم — دفعة 1');
    await expect(page.getByRole('row').filter({ hasText: 'Chloe Price' })).toContainText('مسجلة — دفعة 2');
    await shot('37-statement');

    // a range that overlaps an earlier payout: the paid ones are flagged and left out
    await page.getByRole('button', { name: 'تجهيز دفعة' }).first().click();
    const prep = page.getByRole('dialog');
    await prep.getByRole('radio', { name: 'نطاق من # إلى #' }).click({ force: true });
    await prep.getByRole('textbox', { name: 'من #' }).fill('3');
    await prep.getByRole('textbox', { name: 'إلى #' }).fill('7');
    await expect(prep.getByLabel('تنبيهات')).toContainText('مدفوعة سابقاً في الدفعة 1: #3');
    await expect(prep.getByLabel('تنبيهات')).toContainText('مدفوعة سابقاً في الدفعة 2: #4، #5');
    await expect(prep).toContainText('(6-7)');
    // an unsettled return (negative line) is deducted from the payout
    await expect(prep.getByLabel('مرتجعات تُخصم')).toContainText('مرتجع: استرداد جزئي لـ Ava Collins');

    // all unpaid (the default): #6-8; the "matched" box is required; a different amount needs a reason
    await prep.getByRole('radio', { name: 'كل غير المدفوع' }).click({ force: true });
    await expect(prep).toContainText('(6-8)');
    await expect(prep).toContainText('755.70');
    await prep.getByRole('button', { name: 'متابعة' }).click();
    await expect(prep).toContainText('راجع الحوالات وأكّد أنها مطابقة');
    await prep.getByRole('checkbox', { name: 'راجعتُ الحوالات وهي مطابقة' }).check({ force: true });
    await prep.getByRole('textbox', { name: 'المبلغ المدفوع' }).fill('700.00');
    await prep.getByRole('button', { name: 'متابعة' }).click();
    await expect(prep).toContainText('المبلغ يختلف عن المستحق؛ اكتب السبب');
    await prep.getByRole('textbox', { name: 'المبلغ المدفوع' }).fill('');
    await shot('38-prepare-payout');
    await prep.getByRole('button', { name: 'متابعة' }).click();
    const confirm = page.getByRole('dialog');
    await expect(confirm).toContainText('-755.70');
    await confirm.getByRole('button', { name: 'تم الإرسال' }).click();
    await expect(page.getByText('أُرسلت الدفعة 3 (6-8)')).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'Noah Bennett' })).toContainText('نعم — دفعة 3');
    await expect(summary).toContainText('حوالتان');

    // the recorded payout 2 is confirmed as sent; then payout 1 is cancelled: its transfers are unpaid again
    const p2 = page.locator('tr[data-kind=payout]').filter({ hasText: 'دفعة 2' });
    await p2.getByRole('button', { name: 'إجراءات الدفعة' }).click();
    await page.getByRole('menuitem', { name: 'تأكيد الإرسال' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'تم الإرسال' }).click();
    await expect(page.getByRole('row').filter({ hasText: 'Chloe Price' })).toContainText('نعم — دفعة 2');
    await p1.getByRole('button', { name: 'إجراءات الدفعة' }).click();
    await page.getByRole('menuitem', { name: 'إلغاء الدفعة' }).click();
    await page.getByRole('dialog').getByRole('textbox', { name: 'السبب' }).fill('أُعيدت من المنصة');
    await page.getByRole('dialog').getByRole('button', { name: 'إلغاء الدفعة' }).click();
    await expect(page.getByRole('row').filter({ hasText: 'Mason Reed' })).toContainText('لا');
    await expect(summary).toContainText('3 حوالات');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // matched, from the selection bar
    const mason = page.getByRole('row').filter({ hasText: 'Mason Reed' });
    // bring it out from under the sticky header before clicking its (visually hidden) checkbox
    await mason.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await mason.getByRole('checkbox').check({ force: true });
    await page.getByRole('toolbar', { name: 'إجراءات على المحدد' }).getByRole('button', { name: 'مطابق', exact: true }).click();
    await expect(page.getByRole('row').filter({ hasText: 'Mason Reed' })).toContainText('مطابق');

    // the payouts register with the cumulative paid
    await page.getByRole('tab', { name: 'الدفعات' }).click();
    const reg = page.getByRole('table', { name: 'سجل الدفعات USD' });
    await expect(reg.getByRole('row')).toHaveCount(4);
    await expect(reg).toContainText('ملغاة');
    await shot('39-payouts-register');

    // search: an approved transfer opens its currency tab on the row
    await page.keyboard.press('Control+k');
    await page.getByRole('dialog', { name: 'البحث في كل المعاملات' }).getByRole('searchbox').fill('Noah Bennett');
    await page.getByRole('option').filter({ hasText: 'Noah Bennett' }).click();
    await expect(page.getByRole('tab', { name: 'كشف USD' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('complementary', { name: 'تفاصيل المعاملة' })).toContainText('Noah Bennett');
    expect(errors).toEqual([]);
  });
}

test('0.6.0 appearance: theme × accent, density and scale apply at once and stay', async ({ page }) => {
  await page.goto('/?theme=dark#/settings');
  await page.getByRole('link', { name: 'المظهر' }).click();
  const html = page.locator('html');
  await page.getByRole('radio', { name: 'زمردي' }).click({ force: true });
  await expect(html).toHaveAttribute('data-accent', 'emerald');
  await page.getByRole('radio', { name: /مضغوط/ }).click({ force: true });
  await expect(html).toHaveAttribute('data-density', 'compact');
  await page.getByRole('radio', { name: /تباين عالٍ/ }).click({ force: true });
  await expect(html).toHaveAttribute('data-theme', 'high_contrast');
  // compact rows are shorter in every table
  await page.getByRole('link', { name: 'المعاملات' }).click();
  const h = await page.locator('main table tbody tr').first().evaluate((tr) => tr.getBoundingClientRect().height);
  expect(h).toBeLessThan(40);
  // the choice is saved: a later visit in the same session keeps it (settings) and so does start-up (local copy)
  const stored = await page.evaluate(() => localStorage.getItem('ppfeez.appearance'));
  expect(JSON.parse(stored!)).toMatchObject({ theme: 'high_contrast', accent: 'emerald', density: 'compact' });
  await page.screenshot({ animations: 'disabled', path: 'e2e/screenshots/hc-40-appearance.png' });
});
