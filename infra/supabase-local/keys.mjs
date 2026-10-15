#!/usr/bin/env node
// Derive the local anon / service-role keys from the local-only JWT secret (HS256).
import { createHmac } from "node:crypto";

const secret = process.env.SB_LOCAL_JWT_SECRET ?? "local-only-flightsimapp-test-jwt-secret-0123456789abcdef";
const b64 = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
export function signJwt(payload, key = secret) {
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64(payload);
  const sig = createHmac("sha256", key).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}
const exp = 2_000_000_000; // 2033, local only
export const anonKey = signJwt({ iss: "supabase-local", role: "anon", iat: 1_700_000_000, exp });
export const serviceRoleKey = signJwt({ iss: "supabase-local", role: "service_role", iat: 1_700_000_000, exp });

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(`SUPABASE_URL=http://127.0.0.1:54321\nSUPABASE_ANON_KEY=${anonKey}\n# service role: tests only, never in the desktop app\nSUPABASE_SERVICE_ROLE_KEY=${serviceRoleKey}`);
}
