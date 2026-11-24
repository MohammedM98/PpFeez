import { expect, test, type Page } from '@playwright/test';

// Full money flow from SPEC §10 against the in-browser mock backend:
// create customer → manual transaction → fee → assign → approve → payout → remaining balance.
// 500.00 gross, 15.00 fee → 485.00 net; 20% commission = 97.00 → 388.00 to the customer;
// after a 100.00 payout the remaining balance is 288.00 USD.

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
    await page.getByRole('tab', { name: /معتمدة/ }).click();
    await expect(page.getByRole('row').filter({ hasText: 'Samer Ali' })).toContainText('388.00');

    // 6. payout from the same page
    await page.getByRole('button', { name: 'تسجيل دفعة' }).click();
    const payout = page.getByRole('dialog');
    await payout.getByRole('textbox', { name: 'المبلغ' }).fill('100.00');
    await payout.getByRole('button', { name: 'متابعة' }).click();
    const confirm = page.getByRole('dialog');
    await expect(confirm).toContainText('-100.00');
    await shot(page, theme, '6-payout');
    await confirm.getByRole('button', { name: 'تسجيل الدفعة' }).click();

    // 7. remaining balance
    await page.getByRole('tab', { name: 'دفتر USD' }).click();
    const card = page.locator('div').filter({ hasText: /^المتبقي له/ }).first();
    await expect(card).toContainText('288.00');
    await expect(page.getByRole('table', { name: 'الرصيد الختامي' })).toContainText(/الرصيد الختامي USD.*288\.00/);
    // numbers in the generated description are isolated so "20.00%" keeps its order in RTL
    await expect(page.getByRole('cell', { name: /Samer Ali/ })).toContainText('\u206620.00%\u2069');
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
    await page.goto(`/?theme=${theme}#/customers/2?tab=txns&sub=approved`);
    const row = page.getByRole('row').filter({ hasText: 'Noah Smith' });
    await row.getByRole('button', { name: 'إجراءات' }).click();
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
    await page.getByRole('tab', { name: 'دفتر USD' }).click();
    const credit = page.getByRole('row').filter({ hasText: 'اعتماد' }).first();
    await credit.getByRole('button', { name: 'إجراءات القيد' }).click();
    await expect(page.getByRole('menu')).toContainText('قيد اعتماد');
    await page.keyboard.press('Escape');
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
    await page.getByRole('button', { name: 'حذف العميل' }).click();
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
    await expect(page.getByText(/أُضيفت .*جديدة، وحُدّث صفّان/)).toBeVisible();
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
