// PUBLIC configuration only: no Resend, Turnstile secret or Supabase service-role key.
// The signup API uses server-side Turnstile verification and throttling.
window.TURNLINE_CONFIG = {
  apiUrl: "https://itapyrwjijnvzdsatttp.supabase.co/functions/v1/turnline-waitlist",
  turnstileSiteKey: "0x4AAAAAAFXH8aeHSw0iRd2j"
};
