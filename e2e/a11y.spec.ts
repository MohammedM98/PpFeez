import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/*
 * 0.6.0 phase 4, SPEC 6.10 "الوصول": axe on every screen and the main dialogs, in light, dark and high
 * contrast, with two accents: no serious or critical violation.
 */

const SCREENS = ['dashboard', 'transactions', 'customers', 'customers/8', 'emails', 'settings'];

async function scan(page: Page, where: string) {
  await page.waitForTimeout(350); // overlays fade in; measure contrast once they are fully shown
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  return r.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${where}: ${v.id} (${v.impact}) ×${v.nodes.length} — ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
}

for (const [theme, accent] of [['light', 'blue'], ['dark', 'blue'], ['high_contrast', 'blue'], ['dark', 'amber']] as const) {
  test(`0.6.0 accessibility (${theme}, ${accent})`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const problems: string[] = [];
    for (const s of SCREENS) {
      await page.goto(`/?theme=${theme}&accent=${accent}#/${s}`);
      await expect(page.locator('main h1, main [role=heading]').first()).toBeVisible();
      await page.waitForTimeout(300);
      problems.push(...await scan(page, s));
      if (s === 'customers/8' || s === 'transactions') {
        await page.screenshot({ animations: 'disabled', path: `e2e/screenshots/mode-${theme}-${accent}-${s.replace('/', '-')}.png` });
      }
    }
    // dialogs: assign, the shortcuts sheet, the palette
    await page.goto(`/?theme=${theme}&accent=${accent}#/transactions`);
    await page.locator('table[aria-label="الوارد"] tbody tr[data-key]').first().focus();
    await page.keyboard.press('a');
    await expect(page.getByRole('dialog')).toBeVisible();
    problems.push(...await scan(page, 'assign dialog'));
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Shift+Slash');
    problems.push(...await scan(page, 'shortcuts sheet'));
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+k');
    await page.getByRole('dialog', { name: 'البحث في كل المعاملات' }).getByRole('searchbox').fill('هشام');
    problems.push(...await scan(page, 'palette'));
    expect(problems).toEqual([]);
  });
}
