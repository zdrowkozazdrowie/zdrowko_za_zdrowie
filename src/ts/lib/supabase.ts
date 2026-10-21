import { createClient } from '@supabase/supabase-js';

// Injected at build time (scripts/build.mjs). The anon key is public by design; access is enforced by RLS.
declare const __SUPABASE_URL__: string;
declare const __SUPABASE_ANON_KEY__: string;

export const SUPABASE_URL = __SUPABASE_URL__;

/**
 * Single client for the whole site. Data access goes exclusively through PostgREST
 * (`from()` for RLS-protected tables, `rpc()` for SQL functions). There is no other backend.
 */
export const supabase = createClient(__SUPABASE_URL__, __SUPABASE_ANON_KEY__, {
  auth: {
    flowType: 'pkce',
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

export const LAB_BUCKET = 'wyniki-badan';
