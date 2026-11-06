// Cloudflare Pages Function — POST /intake-log
//
// The intake page reports here when a submission fails on the client (no connection, a timeout, a server error), so a
// problem like "the form didn't go through" leaves a trace. Stores only: stage, status, a short scrubbed message, the form
// type and the browser's user-agent string. Never answers, names or health details. Always answers 204.
import { logIntakeError } from './_intake-log.js';

export async function onRequestPost(context) {
  try {
    let d = {};
    try { d = await context.request.json(); } catch (e) { d = {}; }
    if (!d || typeof d !== 'object') d = {};
    await logIntakeError(context.env, {
      stage: 'client',
      status: d.status,
      message: d.message,
      form_type: d.form_type,
      user_agent: context.request.headers.get('user-agent') || '',
    });
  } catch (e) { /* never fail */ }
  return new Response(null, { status: 204 });
}

export function onRequestGet() {
  return new Response(JSON.stringify({ error: 'Not allowed.' }), { status: 405, headers: { 'Content-Type': 'application/json', Allow: 'POST' } });
}
