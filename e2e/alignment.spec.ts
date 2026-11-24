import { test, expect, type Page } from '@playwright/test';

/*
 * Table alignment (SPEC 6 "محاذاة الجداول", SPEC 10): at 1100×700 and 1920×1080, in both themes,
 * with long names and amounts like 1,234,567.89 in several currencies (`?stress=1`):
 * - every header is exactly over its cells (±1px), totals rows included;
 * - no amount cell and no header label is cut;
 * - decimal points line up down each amount column;
 * - the page itself never scrolls sideways (only the table frame may).
 */

type Problem = string;

async function checkTables(page: Page, where: string): Promise<Problem[]> {
  return page.evaluate((where) => {
    const out: string[] = [];
    const near = (a: number, b: number) => Math.abs(a - b) <= 1;
    const doc = document.documentElement;
    if (doc.scrollWidth > window.innerWidth) out.push(`${where}: page scrolls sideways (${doc.scrollWidth} > ${window.innerWidth})`);
    const main = document.querySelector('main');
    if (main && main.scrollWidth > main.clientWidth + 1) out.push(`${where}: main scrolls sideways`);

    const tables = Array.from(document.querySelectorAll<HTMLTableElement>('main table'));
    if (!tables.length) out.push(`${where}: no table found`);
    let headed: HTMLTableElement | null = null;
    for (const table of tables) {
      const ths = Array.from(table.querySelectorAll<HTMLElement>(':scope > thead > tr > th, :scope > thead > tr > [role=columnheader]'));
      // a table without a header is the totals table of the table before it
      const head = ths.length ? ths : headed ? Array.from(headed.querySelectorAll<HTMLElement>(':scope > thead > tr > th')) : [];
      if (ths.length) headed = table;
      const name = table.getAttribute('aria-label') ?? '?';
      const edges = head.map((th) => th.getBoundingClientRect());

      // headers over their cells
      for (const tr of Array.from(table.querySelectorAll(':scope > tbody > tr'))) {
        let col = 0;
        for (const td of Array.from(tr.children) as HTMLElement[]) {
          const span = (td as HTMLTableCellElement).colSpan || 1;
          if (span === 1 && edges[col]) {
            const r = td.getBoundingClientRect();
            if (!near(r.left, edges[col].left) || !near(r.right, edges[col].right))
              out.push(`${where} / ${name}: column ${col} cell [${r.left}, ${r.right}] not under header [${edges[col].left}, ${edges[col].right}]`);
          }
          col += span;
        }
      }

      // nothing cut: amounts, and the header labels
      for (const a of Array.from(table.querySelectorAll('[data-amount]'))) {
        const td = a.closest('td, [role=gridcell], [role=rowheader]') as HTMLElement;
        if (td && td.scrollWidth > td.clientWidth) out.push(`${where} / ${name}: amount "${a.textContent}" is cut (${td.scrollWidth} > ${td.clientWidth})`);
      }
      for (const th of ths) {
        const label = th.querySelector('[data-col-label] .truncate, [data-col-label].truncate') as HTMLElement | null;
        if (label && label.scrollWidth > label.clientWidth + 1) out.push(`${where} / ${name}: header "${th.textContent}" is cut`);
      }
    }

    // decimal points line up: the number slots of one column end at the same x
    for (const table of tables.filter((t) => t.querySelector('thead'))) {
      const scroll = table.parentElement!;
      const group = [table, ...Array.from(scroll.querySelectorAll<HTMLTableElement>(':scope > table:not(:has(thead))'))];
      const byCol = new Map<number, number[]>();
      const ths = Array.from(table.querySelectorAll<HTMLElement>(':scope > thead > tr > th'));
      for (const t of group) {
        for (const num of Array.from(t.querySelectorAll('[data-amount-num]'))) {
          const r = num.getBoundingClientRect();
          const col = ths.findIndex((th) => { const h = th.getBoundingClientRect(); return r.left >= h.left - 1 && r.right <= h.right + 1; });
          if (col < 0) continue;
          byCol.set(col, [...(byCol.get(col) ?? []), r.right]);
        }
      }
      for (const [col, rights] of byCol) {
        const min = Math.min(...rights), max = Math.max(...rights);
        if (max - min > 1) out.push(`${where} / ${table.getAttribute('aria-label')}: decimals in column ${col} spread over ${(max - min).toFixed(1)}px`);
      }
    }
    return out;
  }, where);
}

const SIZES = [{ width: 1100, height: 700 }, { width: 1920, height: 1080 }];

for (const theme of ['dark', 'light'] as const) {
  for (const size of SIZES) {
    test(`tables line up at ${size.width}×${size.height} (${theme})`, async ({ page }) => {
      await page.setViewportSize(size);
      const shoot = size.width === 1100;
      const shot = (n: string) => shoot && page.screenshot({ animations: 'disabled', path: `e2e/screenshots/${theme}-${n}.png` });
      const open = async (route: string) => {
        await page.goto(`/?stress=1&theme=${theme}#/${route}`);
        await expect(page.locator('main table').first()).toBeVisible();
        await page.waitForTimeout(150);
      };
      const problems: string[] = [];

      await open('transactions');
      await expect(page.getByText('Maximilian Alexander').first()).toBeVisible();
      problems.push(...await checkTables(page, 'transactions'));
      await shot('20-align-transactions');
      // the frame scrolls sideways at 1100; the date and ⋯ columns stay in place
      if (shoot) {
        await page.locator('[data-table-scroll]').first().evaluate((el) => { el.scrollLeft = -10000; });
        problems.push(...await checkTables(page, 'transactions scrolled'));
        await shot('21-align-transactions-scrolled');
      }

      await open('customers');
      problems.push(...await checkTables(page, 'customers'));
      await shot('22-align-customers');

      await open('customers/7');
      await expect(page.getByRole('tab', { name: 'دفتر AUD' })).toBeVisible();
      problems.push(...await checkTables(page, 'ledger AUD'));
      await page.getByRole('tab', { name: 'دفتر TRY' }).click();
      await page.waitForTimeout(150);
      problems.push(...await checkTables(page, 'ledger TRY'));
      await shot('23-align-ledger');
      await page.getByRole('tab', { name: 'معاملاته' }).click();
      await expect(page.getByText('Ayşegül Karadeniz-Yıldırım')).toBeVisible();
      problems.push(...await checkTables(page, 'customer transactions'));
      await shot('24-align-customer-transactions');

      await open('emails');
      problems.push(...await checkTables(page, 'emails failed'));
      await page.getByRole('tab', { name: /متجاهلة/ }).click();
      await page.waitForTimeout(150);
      problems.push(...await checkTables(page, 'emails ignored'));
      await shot('25-align-emails');
      await page.getByRole('tab', { name: /محلَّلة/ }).click();
      await page.waitForTimeout(150);
      problems.push(...await checkTables(page, 'emails parsed'));

      await open('settings');
      await page.getByRole('link', { name: 'سجل السحب' }).click();
      await page.waitForTimeout(300);
      problems.push(...await checkTables(page, 'pull history'));
      await shot('26-align-pulls');

      await open('dashboard');
      problems.push(...await checkTables(page, 'dashboard'));
      if (shoot) {
        await page.locator('main').evaluate((m) => { m.scrollTop = 420; });
        await shot('27-align-dashboard');
      }

      expect(problems).toEqual([]);
    });
  }
}
