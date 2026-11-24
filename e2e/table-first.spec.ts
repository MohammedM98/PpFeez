import { expect, test, type Page } from '@playwright/test';

/*
 * 0.6.0 phase 2, SPEC 6.10 "الجدول كبير وأولاً": the sidebar folds to icons (remembered), table full
 * screen (button or F11), and per-table columns: show/hide, width by dragging or the keyboard, order by
 * dragging (keyboard drag on the grip), pin to the start edge, and "إعادة ضبط الأعمدة".
 */

const headers = (page: Page, table: string) =>
  page.locator(`table[aria-label="${table}"] thead th[data-col]`).evaluateAll((ths) => ths.map((th) => th.getAttribute('data-col')));

for (const theme of ['dark', 'light'] as const) {
  test(`0.6.0 sidebar, full screen and columns (${theme})`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/?theme=${theme}#/customers/8`);
    await expect(page.getByRole('tab', { name: 'كشف USD' })).toBeVisible();

    // the sidebar folds to icons and stays folded on another screen
    await page.getByRole('button', { name: 'طيّ الشريط الجانبي' }).click();
    await expect(page.locator('aside[data-sidebar="narrow"]')).toBeVisible();
    await page.getByRole('navigation', { name: 'التنقل الرئيسي' }).getByRole('link', { name: 'العملاء' }).click();
    await expect(page.locator('aside[data-sidebar="narrow"]')).toBeVisible();
    await page.locator('main table tbody tr').filter({ hasText: 'هشام الزعبي' }).getByRole('rowheader').click();

    // full screen: no sidebar, no header; filters and summary stay; F11 back
    await page.getByRole('button', { name: 'ملء الشاشة للجدول' }).click();
    await expect(page.locator('aside')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'هشام الزعبي' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'ملخص USD' })).toBeVisible();
    await page.screenshot({ animations: 'disabled', path: `e2e/screenshots/${theme}-50-table-fullscreen.png` });
    await page.keyboard.press('F11');
    await expect(page.getByRole('heading', { name: 'هشام الزعبي' })).toBeVisible();
    await page.getByRole('button', { name: 'توسيع الشريط الجانبي' }).click();

    // columns: hide one, pin one, move one with the keyboard
    const before = await headers(page, 'كشف USD');
    expect(before.slice(0, 4)).toEqual(['desc', 'credit', 'debit', 'balance']);
    await page.getByRole('button', { name: 'الأعمدة' }).click();
    const menu = page.getByRole('dialog', { name: 'الأعمدة' });
    await expect(menu.getByRole('checkbox', { name: 'إظهار له' })).toBeDisabled();
    await menu.getByRole('checkbox', { name: 'إظهار المبلغ الكامل من PayPal' }).click({ force: true });
    await menu.getByRole('button', { name: 'تثبيت المرجع' }).click();
    await menu.getByRole('button', { name: 'نقل ملاحظات' }).focus();
    await page.keyboard.press('Enter');
    for (let i = 0; i < 9; i++) await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await page.screenshot({ animations: 'disabled', path: `e2e/screenshots/${theme}-51-columns-menu.png` });
    await page.keyboard.press('Escape');
    const after = await headers(page, 'كشف USD');
    expect(after).not.toContain('gross');
    expect(after[0]).toBe('ref');                                     // pinned columns come first
    expect(after.indexOf('notes')).toBeLessThan(after.indexOf('sent'));
    await expect(page.locator('table[aria-label="كشف USD"] th[data-col="ref"]')).toHaveCSS('position', 'sticky');

    // width: drag the header edge, then two steps narrower with the keyboard
    const th = page.locator('table[aria-label="كشف USD"] th[data-col="sent"]');
    const w0 = (await th.boundingBox())!.width;
    const edge = (await page.getByRole('separator', { name: 'عرض عمود تم الإرسال؟' }).boundingBox())!;
    await page.mouse.move(edge.x + edge.width / 2, edge.y + 10);
    await page.mouse.down();
    await page.mouse.move(edge.x + edge.width / 2 - 60, edge.y + 10, { steps: 6 });
    await page.mouse.up();
    await expect.poll(async () => Math.round((await th.boundingBox())!.width)).toBe(Math.round(w0 + 60));
    await page.getByRole('separator', { name: 'عرض عمود تم الإرسال؟' }).focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => Math.round((await th.boundingBox())!.width)).toBe(Math.round(w0 + 44));

    // kept per table: another screen and back, still the same; the inbox has its own
    await page.getByRole('navigation', { name: 'التنقل الرئيسي' }).getByRole('link', { name: 'المعاملات' }).click();
    await expect(page.locator('table[aria-label="الوارد"] thead th[data-col="grossMinor"]')).toBeVisible();
    await page.goBack();
    await expect(page.locator('table[aria-label="كشف USD"] th[data-col="ref"]')).toHaveCSS('position', 'sticky');
    expect(await headers(page, 'كشف USD')).toEqual(after);
    // written back to the core shortly after the last change
    await expect.poll(async () => {
      const saved = await page.evaluate(() => (window as unknown as { __ppfeezMock: { getDb: () => { settings: { uiPrefs: string } } } }).__ppfeezMock.getDb().settings.uiPrefs);
      return JSON.parse(saved).tables?.statement?.hidden;
    }).toEqual(['gross']);

    // reset
    await page.getByRole('button', { name: 'الأعمدة' }).click();
    await page.getByRole('dialog', { name: 'الأعمدة' }).getByRole('button', { name: 'إعادة ضبط الأعمدة' }).click();
    await page.keyboard.press('Escape');
    expect(await headers(page, 'كشف USD')).toEqual(before);
    await expect(th).toHaveCSS('width', `${Math.round(w0)}px`);
    expect(errors).toEqual([]);
  });
}
