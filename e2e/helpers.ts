import { expect, type Page } from '@playwright/test';

// Local Supabase catches all e-mails in a test inbox (Mailpit); nothing leaves the machine.
const MAIL_API = process.env.MAIL_API ?? 'http://127.0.0.1:54324';

async function latestMailText(to: string, after: number): Promise<string | null> {
  const search = await fetch(`${MAIL_API}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
  if (!search.ok) return null;
  const { messages = [] } = (await search.json()) as { messages?: { ID: string; Created: string }[] };
  const fresh = messages.find((m) => Date.parse(m.Created) >= after - 2000);
  if (!fresh) return null;
  const msg = (await (await fetch(`${MAIL_API}/api/v1/message/${fresh.ID}`)).json()) as {
    Text?: string;
    HTML?: string;
  };
  return `${msg.Text ?? ''}\n${msg.HTML ?? ''}`;
}

export async function loginCode(email: string, after: number): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const text = await latestMailText(email, after);
    const code = text && /\b(\d{6})\b/.exec(text)?.[1];
    if (code) return code;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`No login e-mail for ${email}`);
}

/** Passwordless login with the 6-digit code from the e-mail. Starts on the login page. */
export async function loginWithCode(page: Page, email: string): Promise<void> {
  await expect(page.locator('#email-form')).toBeVisible();
  const sentAt = Date.now();
  await page.fill('#email', email);
  await page.click('#email-submit');
  await expect(page.locator('#code-form')).toBeVisible();
  await page.fill('#code', await loginCode(email, sentAt));
  await page.click('#code-submit');
  await page.waitForURL((url) => !url.pathname.endsWith('/logowanie.html'));
}

/** YYYY-MM-DD, `days` from today. */
export function dayFromToday(days: number): string {
  const d = new Date(Date.now() + days * 86400_000);
  return d.toISOString().slice(0, 10);
}
