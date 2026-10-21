# Zdrówko za zdrowie

Strona dietetyczki mgr Wiktorii Przybylak (dietetyk kliniczny, w trakcie studiów z psychodietetyki).
UI i treści po polsku, kod i komentarze po angielsku.

## Architektura (pivot z GitHub Pages)

- **Backend = Supabase (Postgres).** Cała logika w SQL: tabele z RLS + funkcje RPC w schemacie `public`.
  Frontend rozmawia wyłącznie z **PostgREST** (`supabase.from()` / `supabase.rpc()`), bez Edge Functions.
- Schemat `private` (niewystawiony w API): ustawienia, sekrety (Vault), tokeny decyzji, kolejka e-maili.
- **E-maile** wysyła Postgres: `private.enqueue_email()` → `pg_net` → Resend API; worker `pg_cron` co minutę
  (`private.process_email_queue()`), retry do 5 prób. Bez sekretu `resend_api_key` maile mają status `skipped`.
- **Hosting frontu:** statyczny build (esbuild + TypeScript) na Cloudflare Pages (Supabase nie hostuje stron).
  Stary adres GitHub Pages przekierowuje na nowy (`scripts/legacy-redirect.mjs`).
- **Logowanie:** bez hasła – link + 6-cyfrowy kod z e-maila (`signInWithOtp`/`verifyOtp`) oraz Google OAuth (PKCE).
- **Brak własnej domeny (stan na 2026-10-21):** maile nie wychodzą (`skipped`), klienci logują się przez Google.
  Po dodaniu domeny wystarczy konfiguracja (README → „E-maile i własna domena”), bez zmian w kodzie.
- **Płatności:** TODO. Kolumny `payment_status` itd. są gotowe, webhook ma wołać `private.mark_paid()`.

## Przepływ wizyty

1. Klient (zalogowany) wybiera usługę i wolny termin → `book_appointment()` → status `pending`.
2. Trigger wysyła adminowi mail z linkiem `/potwierdz.html?t=TOKEN` (decyzja wymaga kliknięcia, bo skanery
   poczty otwierają linki) oraz potwierdzenie przyjęcia do klienta.
3. Admin potwierdza (`decide_appointment()` albo panel `admin_set_status()`) → klient dostaje mail z linkiem
   `/kwestionariusz.html?wizyta=ID`.
4. Kwestionariusz zapisuje się w bazie (`save_questionnaire()`, autosave szkicu + wysłanie ze zgodą na
   przetwarzanie danych o zdrowiu). Wyniki badań: Storage, bucket `wyniki-badan`, ścieżka `<user>/<wizyta>/<plik>`.
5. Admin widzi wizyty, terminy, kwestionariusze i log maili w `/admin.html`.

Linki do kwestionariusza (`private.questionnaire_links`, migracja `questionnaire_links`): tajny token na wizytę
(tworzony triggerem) albo na kwestionariusz bez wizyty (`admin_create_questionnaire`, potem `admin_attach_questionnaire`).
Strona `/kwestionariusz.html?t=TOKEN` działa bez logowania (`get_/save_questionnaire_by_link`), pliki w `link/<token>/`.
Admin wysyła link ręcznie (SMS/WhatsApp/e-mail), bo maile są wyłączone do czasu domeny.

Admin = użytkownik z potwierdzonym e-mailem z `private.settings.admin_emails` (ustawiane przez CI
`private.configure()`).

## Struktura

- `supabase/migrations/` – schemat i logika (core, booking, questionnaires, notifications)
- `tests/db/` – testy SQL (transakcja + rollback); `scripts/test-db.sh` uruchamia je na lokalnym Supabase
- `src/*.html`, `src/styles/`, `src/ts/lib/`, `src/ts/pages/` – frontend
- `public/assets/` – obrazy

## Kwestionariusz – ustalenia z właścicielką (ważne przy zmianach)

- Krótkie, proste pytania, odpowiedzi kafelkami z emoji i animacjami; konkretne zakresy zamiast tak/nie.
- Pierwsze pytanie o formę zwracania się: Kobieta / Mężczyzna / „Inaczej / wolę formy neutralne”.
  Wszystkie pytania mają warianty m/ż/neutralne; sylwetka przy pomiarze talii też (kobieca / męska / pośrodku).
- Obwód talii: opis pomiaru (połowa odległości między dolnym żebrem a górnym brzegiem talerza biodrowego,
  zwykle na wysokości pępka lub tuż nad nim). Normy (<80 cm kobiety, <94 cm mężczyźni) tylko w ciekawostce,
  bez przycisku „Nie mam centymetra”.
- **Ciekawostki:** tylko informacje potwierdzone rzetelnymi badaniami, ze źródłem przy każdej. Przed dodaniem
  nowej ciekawostki pokaż właścicielce badania i treść do akceptacji. Ton pośredni: obrazowy i ciekawy,
  ale nie infantylny i nie zbyt naukowy; bez wymuszonych porównań. Jeśli czegoś nie da się potwierdzić
  (np. „ciepła woda rano rozgrzewa jelita”), powiedz to wprost zamiast dodawać.
- Pytanie o jedzenie przy ekranie nie ma ciekawostki (usunięta na prośbę właścicielki).
- Opcje „podgrzać w pracy”: bez opiekacza. Sprzęt w kuchni: osobne pytanie wielokrotnego wyboru.
- Możliwość zaczęcia od nowa (z potwierdzeniem, które da się zamknąć).

## Stan prac

Zrobione: migracje + testy SQL, frontend (landing z rezerwacją, logowanie bez hasła, moje wizyty, potwierdzenie,
kwestionariusz z zapisem do bazy i uploadem wyników, panel admina: wizyty, kalendarz, terminy, klienci,
kwestionariusze, e-maile, podgląd bazy), build/dev, E2E Playwright, CI/CD (`.github/workflows/ci.yml`), README.

Zatwierdzona wersja kwestionariusza (źródło prawdy dla pytań, ciekawostek i wyglądu): `docs/kwestionariusz-prototyp.html`.
Pytania w kodzie: `src/ts/questionnaire/questions.ts` (wygenerowane 1:1 z prototypu).

Do zrobienia: płatności (TODO w schemacie), sprzedaż e-booków online.

## Komendy

- `npm run dev` – serwer na http://127.0.0.1:4173 (lokalny Supabase: `npx supabase start`)
- `npm run check` – formatowanie, lint, typy, build
- `npm run test:db` – testy SQL (lokalny Supabase), `npm run test:e2e` – Playwright (po `npm run build`)
- Konfiguracja produkcji i sekrety: README → „Konfiguracja produkcji”
