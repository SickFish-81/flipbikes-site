// Who is allowed to ask about labels.
//
// The print agent runs on a machine in Craig's workshop and polls the shop
// every minute. It is not a browser and it has no Supabase session, so it
// proves itself with one shared secret: FLIP_AGENT_TOKEN, sent as
// `Authorization: Bearer <token>`.
//
// THE RULE THAT MATTERS: an UNSET token is a refusal, never a free pass.
//
// It would be easy to write `if (!TOKEN) return true` so the thing works on a
// laptop with nothing configured. That would publish every customer's name and
// address the moment the endpoint deployed, because the env var is not set in
// Vercel yet. So a missing token answers 503 and says so — the agent logs it,
// nobody is exposed, and the failure is loud rather than silent.
//
// Compared in constant time. The token is low-value and the volume is one poll
// a minute, so timing attacks are not a real threat here — it costs one line,
// and the habit is worth more than the line.

import crypto from "node:crypto";

export const agentConfigured = () => Boolean(process.env.FLIP_AGENT_TOKEN);

function sameSecret(a, b) {
  const x = Buffer.from(String(a ?? ""), "utf8");
  const y = Buffer.from(String(b ?? ""), "utf8");
  // timingSafeEqual throws on a length mismatch, which is itself a leak of the
  // length — hash both first so the comparison is always over 32 bytes.
  const hx = crypto.createHash("sha256").update(x).digest();
  const hy = crypto.createHash("sha256").update(y).digest();
  return crypto.timingSafeEqual(hx, hy);
}

// Returns null when the caller is the agent, or an {status, body} to send back.
// Callers do: `const no = refuseUnlessAgent(req); if (no) return res.status(no.status).json(no.body);`
export function refuseUnlessAgent(req) {
  const expected = process.env.FLIP_AGENT_TOKEN;
  if (!expected) {
    return {
      status: 503,
      body: { error: "Label printing isn't switched on: FLIP_AGENT_TOKEN is not set on the server." },
    };
  }
  const header = req.headers?.authorization || req.headers?.Authorization || "";
  const presented = String(header).replace(/^Bearer\s+/i, "").trim();
  if (!presented || !sameSecret(presented, expected)) {
    return { status: 401, body: { error: "Not the print agent." } };
  }
  return null;
}
