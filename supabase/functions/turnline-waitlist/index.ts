// Supabase Edge Function: turnline-waitlist
// Public endpoint; deploy with verify_jwt=false ONLY after configuring Turnstile, Resend and origin allowlist.
// Secrets live in function environment, never in the browser or Git.
// All request logic is in handler.ts; this file only wires it to Supabase, Resend and Cloudflare Turnstile.
// Nothing here logs request bodies, tokens or email addresses.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createHandler, type WaitlistRow, type WaitlistStore } from "./handler.ts";

const env = (key: string) => Deno.env.get(key)?.trim() || "";
const db = () => createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { autoRefreshToken: false, persistSession: false } });
const COLUMNS = "id,created_at,updated_at,verification_hash,verification_expires_at,confirmed_at,unsubscribed_at";

const store: WaitlistStore = {
  async checkLimit(bucket, limit) {
    const { data, error } = await db().rpc("turnline_waitlist_check_limit", { p_bucket: bucket, p_limit: limit });
    return !error && data === true;
  },
  async findByEmail(email) {
    const { data, error } = await db().from("turnline_waitlist").select(COLUMNS).eq("email_normalized", email).maybeSingle();
    return error ? null : { row: (data as WaitlistRow | null) ?? null };
  },
  async findById(id) {
    const { data, error } = await db().from("turnline_waitlist").select(COLUMNS).eq("id", id).maybeSingle();
    return error ? null : { row: (data as WaitlistRow | null) ?? null };
  },
  async insert(patch) {
    const { data, error } = await db().from("turnline_waitlist").insert(patch).select("id").single();
    return error || !data ? null : { id: data.id as string };
  },
  async update(id, patch) {
    const { error } = await db().from("turnline_waitlist").update(patch).eq("id", id);
    return !error;
  },
  async confirm(id, verificationHash, at) {
    const { data, error } = await db().from("turnline_waitlist").update({ confirmed_at: at, updated_at: at }).eq("id", id).eq("verification_hash", verificationHash).is("unsubscribed_at", null).is("confirmed_at", null).select("id").maybeSingle();
    return error ? null : { updated: Boolean(data) };
  },
  async unsubscribe(id, at) {
    const { data, error } = await db().from("turnline_waitlist").update({ unsubscribed_at: at, updated_at: at }).eq("id", id).is("unsubscribed_at", null).select("id").maybeSingle();
    return error ? null : { updated: Boolean(data) };
  },
};

Deno.serve(createHandler({
  env,
  store,
  async sendEmail(to, subject, html) {
    const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: "Bearer " + env("RESEND_API_KEY"), "Content-Type": "application/json" }, body: JSON.stringify({ from: env("WAITLIST_FROM_EMAIL"), to: [to], subject, html }) });
    if (!r.ok) throw new Error("email provider rejected send");
  },
  async verifyCaptcha(token) {
    const cf = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: new URLSearchParams({ secret: env("TURNSTILE_SECRET_KEY"), response: token }) });
    if (!cf.ok) return { ok: false };
    const check = await cf.json();
    return { ok: true, success: Boolean(check.success), hostname: check.hostname };
  },
}));
