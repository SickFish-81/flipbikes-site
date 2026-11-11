// Dealer portal sign-in: emailed one-time codes and a signed session cookie.
//
// WHY NOT SUPABASE LOGINS
//
// The database behind the shop is also the workshop's: every customer, job
// card and invoice Betterservice has. A Supabase login would put a dealer one
// mis-written row policy away from all of it. So a dealer never gets one. They
// sign in HERE, and this server — which holds the key — talks to the database
// on their behalf through two narrow functions. A dealer's session is only
// ever read by this file.
//
// WHY A CODE AND NOT A PASSWORD
//
// Nobody to reset passwords for, nothing to leak, and the dealer's inbox is
// already the thing their invoices go to. Codes are six digits, live ten
// minutes, allow five guesses, and only the hash is stored.

import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "flip_dealer";
export const SESSION_DAYS = 30;
export const CODE_MINUTES = 10;
export const CODE_MAX_ATTEMPTS = 5;
// At most this many codes per dealer per 15 minutes, so the form can't be
// used to fill someone's inbox.
export const CODES_PER_WINDOW = 3;

// Without a long secret there is no safe way to sign a session, so the portal
// stays shut rather than running on a guessable one.
const secret = () => {
  const s = String(process.env.FLIP_DEALER_SECRET || "");
  return s.length >= 32 ? s : null;
};
export const portalConfigured = () => Boolean(secret());

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const mac = (data) => createHmac("sha256", secret()).update(data).digest();

export const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, "0");

// Bound to the dealer as well as the secret, so a code row can't be lifted
// from one account to another.
export const hashCode = (dealerId, code) => b64url(mac(`code:${dealerId}:${String(code).trim()}`));

export function codeMatches(dealerId, code, storedHash) {
  if (!/^\d{6}$/.test(String(code || "").trim())) return false;
  const a = Buffer.from(hashCode(dealerId, code));
  const b = Buffer.from(String(storedHash || ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------------------------------------------------------------- session
//
// <payload>.<signature>, payload = {d: dealer id, v: session_version, t: issued}
// Checking the signature proves we issued it; the caller still has to check
// the dealer exists, still has portal access, and is on the same version.

export function signSession(dealerId, version, nowMs = Date.now()) {
  const payload = b64url(JSON.stringify({ d: dealerId, v: version, t: Math.floor(nowMs / 1000) }));
  return `${payload}.${b64url(mac(`session:${payload}`))}`;
}

export function readSession(token, nowMs = Date.now()) {
  if (!secret() || typeof token !== "string") return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const want = Buffer.from(b64url(mac(`session:${payload}`)));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  let p;
  try { p = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return null; }
  if (!p || typeof p.d !== "string" || !Number.isInteger(p.v) || !Number.isInteger(p.t)) return null;
  if (nowMs / 1000 - p.t > SESSION_DAYS * 86400) return null;
  return { dealerId: p.d, version: p.v };
}

export function cookieFrom(req) {
  const raw = String(req.headers?.cookie || "");
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === SESSION_COOKIE) return decodeURIComponent(v.join("="));
  }
  return null;
}

// HttpOnly: page scripts can't read it. SameSite=Lax + the Origin check in
// /api/dealer: another site can't make a dealer's browser place an order.
export const sessionCookie = (token) =>
  `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/api/dealer; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
export const clearCookie = () =>
  `${SESSION_COOKIE}=; Path=/api/dealer; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
