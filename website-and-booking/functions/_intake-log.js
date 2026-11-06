// Failure log for the intake form (no answers, no health details — only what went wrong, when, and on what kind of device).
// Written best-effort: a logging problem must never change what the client sees. Needs the intake_errors table
// (supabase-intake-types.sql); without it this quietly does nothing.
import { sbRequest } from './_supabase.js';

// Anything that could identify a person (an email in a database error, a long number) is stripped before it is stored.
function scrub(v, max) {
  return String(v == null ? '' : v)
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '[email]')
    .replace(/\+?\d[\d\s().-]{6,}\d/g, '[number]')
    .slice(0, max);
}

export async function logIntakeError(env, { stage, status, message, form_type, user_agent }) {
  try {
    await sbRequest(env, {
      path: '/rest/v1/intake_errors',
      method: 'POST',
      prefer: 'return=minimal',
      body: [{
        stage: scrub(stage, 20) || null,
        status: Number.isFinite(Number(status)) ? Number(status) : null,
        message: scrub(message, 300) || null,
        form_type: scrub(form_type, 20) || null,
        user_agent: scrub(user_agent, 200) || null,
      }],
    });
  } catch (e) {
    console.error('intake-log: could not write (table missing?):', String(e && e.message || e).slice(0, 160));
  }
}
