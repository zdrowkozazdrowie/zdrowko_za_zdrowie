# Local development. Requires Docker Desktop running.
export PATH := $(HOME)/.docker/bin:/opt/homebrew/opt/libpq/bin:$(PATH)

SUPABASE_EXCLUDE = studio,imgproxy,edge-runtime,logflare,vector,supavisor,realtime,postgres-meta
LOCAL_ENV = SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_ANON_KEY=sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH

.PHONY: up stop reset-db

## up: (re)start everything – Supabase in Docker + site on http://127.0.0.1:4173
up: stop
	npx supabase start -x $(SUPABASE_EXCLUDE)
	@echo "Strona: http://127.0.0.1:4173  |  Skrzynka testowa: http://127.0.0.1:54324  |  Admin: admin@zdrowko.local"
	$(LOCAL_ENV) npm run dev

## stop: stop the site and Supabase
stop:
	-@lsof -ti tcp:4173 | xargs kill 2>/dev/null || true
	-npx supabase stop

## reset-db: wipe the local database and re-apply migrations and seed
reset-db:
	npx supabase db reset
