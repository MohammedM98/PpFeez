import { expect, test } from '@playwright/test';

/*
 * SPEC 6.10 "إغلاق اللوحات والنوافذ" (in 0.5.1): side panels, menus and popovers close on a click
 * outside and on Esc; another row moves the panel in one click; dialogs with unsaved input ask
 * "تجاهل التغييرات؟" first and nothing financial happens on close; focus returns to the opener.
 */

for (const theme of ['dark', 'light'] as const) {
  test(`0.5.1 panels and dialogs close by clicking outside (${theme})`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`/?theme=${theme}#/transactions`);
    const rows = page.locator('main table tbody tr');
    const panel = page.locator('[data-detail-panel]');

    // a row opens the panel, another row moves it there in one click (no overlay in between)
    await rows.nth(0).click({ position: { x: 600, y: 20 } });
    await expect(panel).toBeVisible();
    const first = await panel.locator('header').innerText();
    await rows.nth(2).click({ position: { x: 600, y: 20 } });
    await expect(panel).toHaveCount(1);
    await expect(panel.locator('header')).not.toHaveText(first);

    // a click anywhere outside closes it
    await page.getByRole('heading', { name: 'المعاملات' }).click();
    await expect(panel).toHaveCount(0);

    // Esc closes it and focus goes back to the row that opened it
    await rows.nth(1).click({ position: { x: 600, y: 20 } });
    await expect(panel).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('main table tbody tr'))).toBe(true);

    // menus close on an outside click too
    await page.getByRole('link', { name: 'العملاء' }).click();
    await page.locator('main table tbody tr').filter({ hasText: 'هشام الزعبي' }).getByRole('rowheader').click();
    await page.getByRole('button', { name: 'المزيد' }).click();
    await expect(page.getByRole('menu')).toBeVisible();
    const h = (await page.getByRole('heading', { name: 'هشام الزعبي' }).boundingBox())!;
    await page.mouse.click(h.x + h.width / 2, h.y + h.height / 2);
    await expect(page.getByRole('menu')).toHaveCount(0);

    // an untouched dialog closes on Esc without a question
    await page.getByRole('button', { name: 'المزيد' }).click();
    await page.getByRole('menuitem', { name: 'قيد تسوية' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // with something typed it asks first; "متابعة التعديل" keeps what was typed
    const closing = (await page.getByRole('table', { name: 'الرصيد الختامي' }).textContent()) ?? '';
    await page.getByRole('button', { name: 'المزيد' }).click();
    await page.getByRole('menuitem', { name: 'قيد تسوية' }).click();
    const d = page.getByRole('dialog');
    await d.getByRole('textbox', { name: 'المبلغ' }).fill('40.00');
    await page.keyboard.press('Escape');
    const ask = d.getByRole('alertdialog', { name: 'تجاهل التغييرات؟' });
    await expect(ask).toBeVisible();
    await page.screenshot({ animations: 'disabled', path: `e2e/screenshots/${theme}-45-discard-changes.png` });
    await ask.getByRole('button', { name: 'متابعة التعديل' }).click();
    await expect(d.getByRole('textbox', { name: 'المبلغ' })).toHaveValue('40.00');

    // a click outside asks the same; "تجاهل" closes, and nothing was recorded
    await page.mouse.click(10, 690);
    await expect(ask).toBeVisible();
    await ask.getByRole('button', { name: 'تجاهل' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('table', { name: 'الرصيد الختامي' })).toHaveText(closing);
    expect(errors).toEqual([]);
  });
}
