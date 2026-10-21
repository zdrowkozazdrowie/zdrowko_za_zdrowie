import type { Session, User } from '@supabase/supabase-js';
import { supabase } from './supabase';

/** Only same-origin relative paths are allowed as a post-login destination. */
export function safeNext(next: string | null | undefined, fallback = '/konto.html'): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return fallback;
  return next;
}

export function currentPath(): string {
  return location.pathname + location.search + location.hash;
}

export function loginUrl(next = currentPath()): string {
  return `/logowanie.html?next=${encodeURIComponent(next)}`;
}

export async function getSession(): Promise<Session | null> {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export async function getUser(): Promise<User | null> {
  return (await getSession())?.user ?? null;
}

/** Redirects to the login page when nobody is signed in. */
export async function requireUser(): Promise<User> {
  const user = await getUser();
  if (!user) {
    location.replace(loginUrl());
    // Stop the calling page from continuing while the browser navigates away.
    return new Promise<User>(() => undefined);
  }
  return user;
}

export async function isAdmin(): Promise<boolean> {
  const { data, error } = await supabase.rpc('is_admin');
  return !error && data === true;
}

export async function signOut(): Promise<void> {
  await supabase.auth.signOut();
  location.href = '/';
}

/**
 * Fills a header nav with account links: "Zaloguj się" for guests,
 * "Moje wizyty" (+ "Panel" for admins) and "Wyloguj" for signed-in users.
 */
export async function mountAccountNav(container: HTMLElement | null): Promise<void> {
  if (!container) return;
  const user = await getUser();
  container.replaceChildren();
  const link = (href: string, text: string, cls = ''): HTMLAnchorElement => {
    const a = document.createElement('a');
    a.href = href;
    a.textContent = text;
    if (cls) a.className = cls;
    container.append(a);
    return a;
  };
  if (!user) {
    link(loginUrl(), 'Zaloguj się', 'nav-account');
    return;
  }
  link('/konto.html', 'Moje wizyty', 'nav-account');
  if (await isAdmin()) link('/admin.html', 'Panel', 'nav-account');
  const out = link('#', 'Wyloguj');
  out.addEventListener('click', (e) => {
    e.preventDefault();
    void signOut();
  });
}
