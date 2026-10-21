import { expect, test } from '@playwright/test';
import { dayFromToday, loginWithCode } from './helpers';

// Full flow: admin publishes slots -> client books (logging in on the way) -> admin confirms ->
// client fills the questionnaire -> admin sees the answers.
const ADMIN = 'admin@zdrowko.local'; // supabase/seed.sql
const RUN = Date.now();
const CLIENT = `klient-${RUN}@example.com`;
// A different day per run, so reruns against the same database still find free slots.
const SLOT_DAY = 3 + (RUN % 40);

test('booking, confirmation and questionnaire', async ({ browser }) => {
  const adminCtx = await browser.newContext();
  const clientCtx = await browser.newContext();
  const admin = await adminCtx.newPage();
  const client = await clientCtx.newPage();

  await test.step('admin adds slots', async () => {
    await admin.goto('/admin.html');
    await loginWithCode(admin, ADMIN);
    await expect(admin.locator('#admin')).toBeVisible();
    await admin.click('.seg [data-tab="terminy"]');
    await admin.fill('#s-day', dayFromToday(SLOT_DAY));
    await admin.fill('#s-from', '09:00');
    await admin.fill('#s-to', '11:00');
    await admin.fill('#s-dur', '60');
    await admin.click('#slot-form button[type=submit]');
    await expect(admin.locator('#toast')).toContainText(/Dodano terminy: 2|Nie dodano/);
    await expect(admin.locator('#s-list .slot-row').first()).toBeVisible();
  });

  await test.step('client books a slot and logs in on the way', async () => {
    await client.goto('/');
    await client.locator('.hero [data-book]').first().click();
    const dialog = client.locator('#booking');
    await expect(dialog).toBeVisible();
    await expect(client.locator('#b-service option').first()).toHaveText(/Pierwsza konsultacja/);
    await client.locator('#b-days .day').first().click();
    await client.locator('#b-times .time').first().click();
    await client.fill('#b-name', 'Ewa Testowa');
    await client.fill('#b-phone', '+48 600 000 000');
    await client.click('#b-submit');

    await loginWithCode(client, CLIENT);
    // Back on the landing page with the booking draft restored.
    await expect(client.locator('#booking')).toBeVisible();
    await expect(client.locator('#b-name')).toHaveValue('Ewa Testowa');
    await expect(client.locator('#b-times .time[aria-pressed="true"]')).toHaveCount(1);
    await client.click('#b-submit');
    await expect(client.locator('#b-success')).toBeVisible();
  });

  await test.step('client sees the pending booking', async () => {
    await client.goto('/konto.html');
    await expect(client.locator('#appointments .appt').first()).toContainText('Czeka na potwierdzenie');
  });

  await test.step('admin confirms', async () => {
    await admin.reload();
    await expect(admin.locator('#admin')).toBeVisible();
    await admin.locator('#stats [data-filter="todo"]').click();
    await admin.locator('#a-list .appt', { hasText: 'Ewa Testowa' }).first().click();
    await expect(admin.locator('#detail')).toBeVisible();
    await admin.fill('#d-msg', 'Do zobaczenia online!');
    await admin.click('#detail [data-status="confirmed"]');
    await expect(admin.locator('#toast')).toContainText('Zapisano');
    await expect(admin.locator('#detail .pill.confirmed').first()).toBeVisible();
    await admin.keyboard.press('Escape');
  });

  let link = '';
  await test.step('admin copies the questionnaire link', async () => {
    await admin.selectOption('#f-status', 'all');
    await admin.locator('#a-list .appt', { hasText: 'Ewa Testowa' }).first().click();
    const url = admin.locator('#detail [data-link-url]');
    await expect(url).toHaveValue(/\/kwestionariusz\.html\?t=[0-9a-f]{48}$/);
    link = await url.inputValue();
    await expect(admin.locator('#detail a[href^="sms:"]')).toBeVisible();
    await admin.keyboard.press('Escape');
  });

  await test.step('client fills the questionnaire from the link without signing in', async () => {
    const anonCtx = await browser.newContext();
    const anon = await anonCtx.newPage();
    await anon.goto(new URL(link).pathname + new URL(link).search);
    await expect(anon.locator('.kw-links')).toHaveCount(0);
    await anon.click('#start');
    await anon.getByRole('button', { name: /Kobieta/ }).click();
    // The single-choice answer moves on automatically; then fill names and skip the rest.
    await expect(anon.locator('#f_imie')).toBeVisible();
    await anon.fill('#f_imie', 'Ewa');
    await anon.fill('#f_wiek', '34');
    for (let i = 0; i < 80 && !(await anon.locator('#consent').isVisible()); i++) {
      await anon.click('#next');
    }
    await expect(anon.locator('h1')).toContainText('Dziękuję, Ewa');
    await anon
      .locator('#file')
      .setInputFiles({ name: 'morfologia.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 test') });
    await expect(anon.locator('#files')).toContainText('morfologia.pdf');
    await anon.click('#submit');
    await expect(anon.locator('.err:visible')).toContainText('zgodę');
    await anon.check('#consent');
    await anon.click('#submit');
    await expect(anon.locator('h1')).toHaveText('Gotowe!');
    await anonCtx.close();
  });

  await test.step('signed-in client sees the questionnaire as sent', async () => {
    await client.goto('/konto.html');
    await expect(client.locator('#appointments')).toContainText('wysłany');
  });

  await test.step('admin reads the questionnaire', async () => {
    await admin.reload();
    await admin.click('.seg [data-tab="kwestionariusze"]');
    const row = admin.locator('#q-list tr', { hasText: 'Ewa Testowa' });
    await expect(row).toContainText('wysłany');
    await row.click();
    await expect(admin.locator('#detail .answers')).toContainText('Imię: Ewa');
    await expect(admin.locator('#d-files')).toContainText('morfologia.pdf');
    await admin.keyboard.press('Escape');

    await admin.click('.seg [data-tab="klienci"]');
    await expect(admin.locator('#c-list')).toContainText(CLIENT);

    await admin.click('.seg [data-tab="maile"]');
    await expect(admin.locator('#m-list')).toContainText('Wizyta potwierdzona');

    await admin.click('.seg [data-tab="baza"]');
    await expect(admin.locator('#db-rows table')).toBeVisible();
  });

  await adminCtx.close();
  await clientCtx.close();
});

test('pages load without errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  for (const path of ['/', '/logowanie.html', '/potwierdz.html']) {
    await page.goto(path);
    await expect(page.locator('body')).toBeVisible();
  }
  await page.goto('/');
  await expect(page.locator('h1')).toContainText('Schudnij zdrowo');
  expect(errors).toEqual([]);
});

test('questionnaire without an appointment', async ({ browser }) => {
  const adminCtx = await browser.newContext();
  const admin = await adminCtx.newPage();
  await admin.goto('/admin.html');
  await loginWithCode(admin, ADMIN);
  await admin.click('.seg [data-tab="kwestionariusze"]');
  await admin.fill('#q-label', `Basia ${RUN}`);
  await admin.click('#q-new button[type=submit]');
  const url = admin.locator('#detail [data-link-url]');
  await expect(url).toHaveValue(/\?t=[0-9a-f]{48}$/);
  const link = new URL(await url.inputValue());
  await admin.keyboard.press('Escape');

  const anonCtx = await browser.newContext();
  const anon = await anonCtx.newPage();
  await anon.goto(link.pathname + link.search);
  await anon.click('#start');
  await anon.getByRole('button', { name: /Mężczyzna/ }).click();
  await expect(anon.locator('#f_imie')).toBeVisible();
  await anon.fill('#f_imie', 'Basia');
  for (let i = 0; i < 80 && !(await anon.locator('#consent').isVisible()); i++) await anon.click('#next');
  await anon.check('#consent');
  await anon.click('#submit');
  await expect(anon.locator('h1')).toHaveText('Gotowe!');
  await anonCtx.close();

  await admin.reload();
  await admin.click('.seg [data-tab="kwestionariusze"]');
  await admin.selectOption('#q-filter', 'standalone');
  const row = admin.locator('#q-list tr', { hasText: `Basia ${RUN}` });
  await expect(row).toContainText('wysłany');
  await expect(row).toContainText('bez wizyty');
  await row.click();
  await expect(admin.locator('#detail .answers')).toContainText('Imię: Basia');
  await adminCtx.close();
});
