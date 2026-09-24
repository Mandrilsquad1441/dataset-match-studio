import { createClient, type Session } from "@supabase/supabase-js";

const hostedServicesEnabled = import.meta.env.VITE_ENABLE_HOSTED_SERVICES === "true";
const url = hostedServicesEnabled ? import.meta.env.VITE_SUPABASE_URL as string | undefined : undefined;
const anonKey = hostedServicesEnabled ? import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined : undefined;

export const supabaseReady = Boolean(url && anonKey);
export const supabase = supabaseReady
  ? createClient(url!, anonKey!, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } })
  : null;

export async function accessToken(): Promise<string | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

export type AuthSession = Session | null;
