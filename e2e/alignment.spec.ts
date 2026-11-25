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
      await expect(page.getByRole('tab', { name: 'كشف AUD' })).toBeVisible();
      problems.push(...await checkTables(page, 'statement AUD'));
      await page.getByRole('tab', { name: 'كشف TRY' }).click();
      await page.waitForTimeout(150);
      problems.push(...await checkTables(page, 'statement TRY'));
      await shot('23-align-ledger');
      await page.getByRole('tab', { name: /بانتظار الموافقة/ }).click();
      await expect(page.getByText('Second instalment')).toBeVisible();
      problems.push(...await checkTables(page, 'customer pending'));
      await shot('24-align-customer-transactions');
      await open('customers/8');
      await expect(page.getByRole('tab', { name: 'كشف USD' })).toBeVisible();
      problems.push(...await checkTables(page, 'statement with payouts'));
      // له / عليه / الرصيد are in view without scrolling (left of them only the pinned ⋯ column); «تم الإرسال؟» is hidden by default (SPEC 4.9)
      problems.push(...await page.evaluate(() => {
        const out: string[] = [];
        const table = document.querySelector('table[aria-label="كشف USD"]')!;
        const frame = table.parentElement!.getBoundingClientRect();
        const ths = Array.from(table.querySelectorAll<HTMLElement>('thead th'));
        const menu = ths[ths.length - 1].getBoundingClientRect();
        if (ths.some((x) => x.textContent?.trim() === 'تم الإرسال؟')) out.push('statement: «تم الإرسال؟» shows by default');
        for (const name of ['له', 'عليه', 'الرصيد']) {
          const th = ths.find((x) => x.textContent?.trim() === name);
          const r = th?.getBoundingClientRect();
          if (!r || r.left < menu.right - 1 || r.right > frame.right + 1) out.push(`statement: column ${name} is not in view without scrolling`);
        }
        return out;
      }));
      await page.getByRole('tab', { name: 'الدفعات' }).click();
      await page.waitForTimeout(150);
      problems.push(...await checkTables(page, 'payouts register'));

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

/*
 * SPEC 6.5 "الجدول هو الصفحة": the page itself does not scroll, the table takes the remaining height
 * and scrolls inside. At 1100×700 the first data row starts within 240px of the top and at least
 * 10 rows are in view (where there are that many).
 */
for (const size of SIZES) {
  test(`the table is the page at ${size.width}×${size.height}`, async ({ page }) => {
    await page.setViewportSize(size);
    const problems: string[] = [];
    for (const route of ['transactions', 'customers', 'customers/8', 'emails']) {
      await page.goto(`/?stress=1&theme=dark#/${route}`);
      await expect(page.locator('main table tbody tr').first()).toBeVisible();
      await page.waitForTimeout(200);
      const m = await page.evaluate(() => {
        const scroll = document.querySelector('main [data-table-scroll]')!.getBoundingClientRect();
        const rows = Array.from(document.querySelectorAll('main [data-table-scroll] table:first-of-type tbody tr'));
        const inView = rows.filter((r) => { const b = r.getBoundingClientRect(); return b.top >= scroll.top - 1 && b.bottom <= scroll.bottom + 1; }).length;
        const main = document.querySelector('main')!;
        return {
          firstRowTop: rows[0].getBoundingClientRect().top, rows: rows.length, inView,
          pageScrolls: document.scrollingElement!.scrollHeight > innerHeight, mainScrolls: main.scrollHeight > main.clientHeight + 1,
        };
      });
      if (m.firstRowTop > 240) problems.push(`${route}: first row at ${m.firstRowTop}px (> 240)`);
      if (m.inView < Math.min(10, m.rows)) problems.push(`${route}: ${m.inView} rows in view of ${m.rows} (< 10)`);
      if (m.pageScrolls || m.mainScrolls) problems.push(`${route}: the page scrolls`);
    }
    expect(problems).toEqual([]);
  });
}
