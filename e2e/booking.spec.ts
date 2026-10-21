import { expect, test } from '@playwright/test';
import { dayFromToday, loginWithCode } from './helpers';

// Full flow: admin publishes slots -> client books (logging in on the way) -> admin confirms ->
// client fills the questionnaire -> admin sees the answers.
const ADMIN = 'admin@zdrowko.local'; // supabase/seed.sql
const CLIENT = `klient-${Date.now()}@example.com`;

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
    await admin.fill('#s-day', dayFromToday(3));
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

  await test.step('client fills the questionnaire', async () => {
    await client.goto('/konto.html');
    await client
      .getByRole('link', { name: /Wypełnij kwestionariusz/ })
      .first()
      .click();
    await client.waitForURL(/kwestionariusz\.html\?wizyta=/);
    await client.click('#start');
    await client.getByRole('button', { name: /Kobieta/ }).click();
    // The single-choice answer moves on automatically; then fill names and skip the rest.
    await expect(client.locator('#f_imie')).toBeVisible();
    await client.fill('#f_imie', 'Ewa');
    await client.fill('#f_wiek', '34');
    for (let i = 0; i < 80 && !(await client.locator('#consent').isVisible()); i++) {
      await client.click('#next');
    }
    await expect(client.locator('#consent')).toBeVisible();
    await expect(client.locator('h1')).toContainText('Dziękuję, Ewa');
    await client.click('#submit');
    await expect(client.locator('.err:visible')).toContainText('zgodę');
    await client.check('#consent');
    await client.click('#submit');
    await expect(client.locator('h1')).toHaveText('Gotowe!');
  });

  await test.step('admin reads the questionnaire', async () => {
    await admin.reload();
    await admin.click('.seg [data-tab="kwestionariusze"]');
    const row = admin.locator('#q-list tr', { hasText: 'Ewa Testowa' });
    await expect(row).toContainText('wysłany');
    await row.click();
    await expect(admin.locator('#detail .answers')).toContainText('Imię: Ewa');
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
