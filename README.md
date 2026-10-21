# Zdrówko za zdrowie

Strona dietetyczki mgr Wiktorii Przybylak: oferta, rezerwacja wizyt z wyborem terminu, kwestionariusz przed wizytą
i panel administratora.

| Warstwa  | Technologia                                                                                   |
| -------- | --------------------------------------------------------------------------------------------- |
| Frontend | statyczne HTML + TypeScript (esbuild) na **Cloudflare Pages**                                 |
| Backend  | **Supabase**: Postgres z RLS, logika w funkcjach SQL wystawionych przez **PostgREST**         |
| Logowanie| Supabase Auth: link/kod z e-maila (bez hasła) + Google                                         |
| E-maile  | wysyłane z Postgresa (`pg_net` → Resend), kolejka z ponawianiem; bez klucza są tylko logowane |
| CI/CD    | GitHub Actions: testy SQL, E2E (Playwright), podgląd dla PR, deploy z `main`                  |

## Przepływ wizyty

1. Klient wybiera usługę i wolny termin, loguje się (link/kod z maila albo Google) i rezerwuje → status „czeka na potwierdzenie”.
2. Admin dostaje e-mail z przyciskami **Potwierdź / Odrzuć** (lub robi to w panelu).
3. Klient dostaje e-mail z decyzją. Po potwierdzeniu: link do **kwestionariusza**. Odpowiedzi zapisują się w Postgresie
   (`public.questionnaires`), a wyniki badań w prywatnym buckecie Storage `wyniki-badan`.
4. **Linki do kwestionariusza** (działają bez logowania i bez maili): każda wizyta ma własny link w panelu
   (szczegóły wizyty → „Link do kwestionariusza”: kopiuj / SMS / WhatsApp / e-mail / nowy link). Kwestionariusz
   bez wizyty: Panel → Kwestionariusze → „Utwórz link”; później można go przypisać do wizyty.
5. **Godziny pracy** (Panel → Kalendarz): tygodniowy grafik, długość wizyty i przerwa. Terminy dla klientów tworzą się
   same na wybrany okres (codziennie dosuwane przez `pg_cron`). Dni wolne i blokady godzin: kliknij dzień w kalendarzu.
6. Panel `/admin.html`: wizyty, kalendarz, terminy, klienci, kwestionariusze, log e-maili i podgląd bazy danych.

## Praca lokalnie

Wymagania: Node 22+, Docker (dla lokalnego Supabase).

```bash
npm install
npx supabase start      # Postgres + Auth + Storage + skrzynka testowa (http://127.0.0.1:54324)
npm run dev             # http://127.0.0.1:4173
```

Admin lokalnie: zaloguj się jako `admin@zdrowko.local`; kod logowania znajdziesz w skrzynce testowej.

| Komenda               | Co robi                                               |
| --------------------- | ----------------------------------------------------- |
| `npm run check`       | formatowanie, lint, typy i build                      |
| `npm run test:db`     | testy SQL (każdy plik w transakcji z rollbackiem)     |
| `npm run test:e2e`    | pełny przepływ w przeglądarce (po `npm run build`)    |
| `npx supabase db reset` | czysta baza z migracjami i `seed.sql`               |

## Konfiguracja produkcji (jednorazowo)

Wszystko poniżej ustawiasz w GitHub → **Settings → Secrets and variables → Actions**.
Deploy (`main`) sprawdza konfigurację i zatrzyma się z jasnym komunikatem, jeśli czegoś brakuje.

### 1. Supabase

W [dashboardzie projektu](https://supabase.com/dashboard):

| Gdzie                                          | Co skopiować                     | Dokąd w GitHubie                   |
| ---------------------------------------------- | -------------------------------- | ---------------------------------- |
| Project Settings → General → Reference ID       | np. `abcdefghijklmnop`           | **Variable** `SUPABASE_PROJECT_REF` |
| Project Settings → API Keys → `anon` / publishable | klucz publiczny               | **Variable** `SUPABASE_ANON_KEY`   |
| Account → Access Tokens → Generate new token   | token                            | **Secret** `SUPABASE_ACCESS_TOKEN` |
| hasło bazy podane przy tworzeniu projektu (lub Database → Reset password) | hasło | **Secret** `SUPABASE_DB_PASSWORD`  |

Oraz **Variable** `ADMIN_EMAILS`: adresy administratorów po przecinku (np. `wiktoriaprzybylak9@wp.pl`).
Adminem zostaje osoba zalogowana na taki adres (z potwierdzonym e-mailem).

### 2. Cloudflare Pages

1. Załóż konto na [dash.cloudflare.com](https://dash.cloudflare.com).
2. **Account ID** (prawa kolumna na stronie głównej konta) → **Variable** (lub Secret) `CLOUDFLARE_ACCOUNT_ID`.
3. My Profile → API Tokens → Create Token → szablon **„Edit Cloudflare Workers”** (obejmuje Pages) → **Secret** `CLOUDFLARE_API_TOKEN`.
4. Opcjonalnie **Variable** `CLOUDFLARE_PROJECT` (domyślnie `zdrowko-za-zdrowie` → `https://zdrowko-za-zdrowie.pages.dev`).
   Projekt tworzy się sam przy pierwszym deployu.

### 3. Logowanie przez Google (zalecane, dopóki nie ma domeny)

1. [Google Cloud Console](https://console.cloud.google.com/apis/credentials) → Create credentials → OAuth client ID → Web application.
2. Authorized redirect URI: `https://<SUPABASE_PROJECT_REF>.supabase.co/auth/v1/callback`.
3. Client ID → **Variable** `GOOGLE_CLIENT_ID`, Client secret → **Secret** `GOOGLE_CLIENT_SECRET`.

### 4. Pierwszy deploy

Po scaleniu do `main` workflow **CI/CD**: wgrywa migracje (`supabase db push`), ustawia adres strony, adminów,
przekierowania i szablony logowania (`scripts/configure-remote.mjs`), buduje i wdraża stronę na Cloudflare Pages,
a na koniec sprawdza, czy strona i API działają. Stary adres `zdrowkozazdrowie.github.io/zdrowko_za_zdrowie`
przekierowuje na nowy (wymaga: Settings → Pages → Source: **GitHub Actions**).

Każdy PR dostaje własny podgląd na `https://<gałąź>.zdrowko-za-zdrowie.pages.dev` (komentarz z linkiem w PR).
Podgląd korzysta z produkcyjnego Supabase, a migracje z PR trafiają na produkcję dopiero po scaleniu.

## E-maile i własna domena (później)

Bez własnej domeny maile **nie są wysyłane**: system zapisuje je w kolejce ze statusem „pominięta”
(widać je w panelu → E-maile), a logowanie linkiem z maila działa tylko dla członków zespołu projektu Supabase,
więc klienci logują się przez Google.

Gdy kupisz domenę (np. `zdrowkozazdrowie.pl`):

1. Dodaj ją do Cloudflare (DNS) i podepnij do projektu Pages (Pages → Custom domains).
2. W [Resend](https://resend.com) dodaj domenę, wpisz rekordy DNS, utwórz API key.
3. W GitHubie: **Secret** `RESEND_API_KEY`, **Variable** `EMAIL_FROM` (np. `Zdrówko za zdrowie <wizyty@zdrowkozazdrowie.pl>`),
   opcjonalnie `EMAIL_REPLY_TO`, oraz **Variable** `SITE_URL` = `https://zdrowkozazdrowie.pl`.
4. Uruchom workflow ponownie (Actions → CI/CD → Run workflow). Skrypt włączy wysyłkę z Postgresa
   oraz SMTP Resend w Supabase Auth, więc linki logowania zaczną docierać do wszystkich.

## Struktura

- `supabase/migrations/` – schemat, RLS i funkcje (core, booking, questionnaires, notifications, admin)
- `supabase/templates/` – szablon e-maila logowania
- `tests/db/` – testy SQL, `e2e/` – testy Playwright
- `src/*.html`, `src/styles/`, `src/ts/` – frontend (`lib/`, `pages/`, `questionnaire/`)
- `scripts/` – build, serwer dev, konfiguracja Supabase, przekierowanie ze starego adresu
- `docs/kwestionariusz-prototyp.html` – zatwierdzony prototyp kwestionariusza (źródło prawdy dla pytań)
