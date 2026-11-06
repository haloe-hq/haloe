// Shared booking/availability helpers for the Supabase-backed slot
// reservation system. The `_` prefix keeps this file from becoming a route.
//
// One table, public.bookings, lives in Supabase (Postgres), created once via
// supabase-bookings-schema.sql — there's no lazy CREATE TABLE step here, the
// way there was under D1. A row is written the moment a customer starts
// Stripe checkout, with status 'pending' and a hold that expires after
// HOLD_SECONDS. On payment the webhook flips it to 'confirmed'. Abandoned
// checkouts simply expire — the overlap check ignores pending rows whose
// hold has lapsed, so the slot frees itself. A booking Halima cancels from
// /admin is flipped to 'cancelled' and stops blocking the time immediately.
//
// Migrated from Cloudflare D1 in Sep 2026. D1/SQLite serializes all writes,
// so a plain "INSERT...SELECT...WHERE NOT EXISTS" was atomic on its own.
// Postgres has real concurrent writers, so reserveSlot() below calls a
// Postgres function (reserve_slot, in the schema file) via Supabase's RPC
// endpoint instead of running the check and the insert as two separate
// REST calls — the function takes a transaction-scoped advisory lock keyed
// by booking_date, which closes the race a plain check-then-insert would
// reopen.

import { sbRequest } from './_supabase.js';
import { releaseRedemptionForCancelledBooking } from './_discounts.js';

// How long a slot is held while the customer is on Stripe Checkout.
export const HOLD_SECONDS = 10 * 60; // 10 min

// Stripe refuses a Checkout Session `expires_at` under 30 minutes, so the
// Stripe session necessarily outlives our 10-minute hold. A customer who
// pays in minutes 10–30 still gets confirmed — confirmBooking() below checks
// whether someone else took the slot in the meantime and flags the clash
// for Halima instead of silently double-booking.
export const STRIPE_SESSION_SECONDS = 30 * 60;

// Lapsed holds are physically deleted only once they're this far past
// expiry, so the row is still there for the webhook to confirm if the
// payment lands after the hold lapsed (see STRIPE_SESSION_SECONDS). The
// availability queries already ignore lapsed holds, so this is purely tidy-up.
const PURGE_GRACE_SECONDS = 60 * 60;

// '6:00 pm' -> 1080 (minutes from midnight). Returns null if unparseable.
export function slotToMinutes(timeStr) {
  const m = /^(\d{1,2}):(\d{2})\s*(am|pm)$/i.exec(String(timeStr).trim());
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const pm = m[3].toLowerCase() === 'pm';
  if (h === 12) h = 0;          // 12:xx am -> 0, 12:xx pm -> 12 (after +12 below)
  if (pm) h += 12;
  return h * 60 + min;
}

// A treatment's `time` string ('45 min', '1 hour', '1 hr 45 min') -> minutes.
// Packages ('4 sessions · …') and anything unparseable fall back to 60 min.
// create-checkout.js no longer uses this for the hold (it reads `min` from
// _services.js); kept for callers that only have a display string.
export function durationToMinutes(timeStr) {
  const s = String(timeStr || '');
  const hr = /(\d+)\s*(?:hours?|hrs?|hr)\b/i.exec(s);
  const mn = /(\d+)\s*min/i.exec(s);
  const total = (hr ? parseInt(hr[1], 10) * 60 : 0) + (mn ? parseInt(mn[1], 10) : 0);
  return total > 0 ? total : 60;
}

// Best-effort cleanup of long-lapsed holds, so the table doesn't accumulate
// dead rows. Safe to skip — every query below already ignores expired
// pending rows.
export async function purgeExpiredHolds(env, now) {
  try {
    await sbRequest(env, {
      path: `/rest/v1/bookings?status=eq.pending&hold_expires_at=lt.${now - PURGE_GRACE_SECONDS}`,
      method: 'DELETE',
      prefer: 'return=minimal',
    });
  } catch (e) {
    console.error('purgeExpiredHolds failed:', e);
  }
}

// PostgREST filter for "currently blocks the calendar": confirmed, a booking
// whose reschedule is awaiting the client's reply (it keeps holding its
// ORIGINAL slot until she accepts), or a pending hold that hasn't lapsed.
// Cancelled rows never match.
function activeFilter(now) {
  return `or=(status.eq.confirmed,status.eq.reschedule_pending,and(status.eq.pending,hold_expires_at.gt.${now}))`;
}

// Active (blocking) bookings for a date. Returns [{ s: startMin, e: endMin }].
// end_min already includes the turnaround gap (create-checkout.js), so these
// are blocked intervals, not treatment lengths.
// Every booking blocks the day regardless of venue — Halima is one person,
// so a clinic slot and a home visit at the same time can't both happen.
export async function busyIntervals(env, bookingDate, now) {
  const rows = await sbRequest(env, {
    path: `/rest/v1/bookings?select=start_min,end_min&booking_date=eq.${bookingDate}&${activeFilter(now)}`,
    method: 'GET',
  });
  return (rows || []).map(r => ({ s: r.start_min, e: r.end_min }));
}

// Active bookings across an inclusive ISO date range, keyed by date:
// { 'YYYY-MM-DD': [{ s, e }, …] }. One query, used by the "next available
// date" search so it doesn't fire a request per day.
export async function busyIntervalsRange(env, fromISO, toISO, now) {
  const rows = await sbRequest(env, {
    path: `/rest/v1/bookings?select=booking_date,start_min,end_min`
      + `&booking_date=gte.${fromISO}&booking_date=lte.${toISO}&${activeFilter(now)}`,
    method: 'GET',
  });
  const byDate = {};
  (rows || []).forEach((r) => {
    (byDate[r.booking_date] = byDate[r.booking_date] || []).push({ s: r.start_min, e: r.end_min });
  });
  return byDate;
}

// Reserve a slot iff it doesn't overlap an active booking, via the
// reserve_slot Postgres function (see the file header for why this can't be
// a plain check-then-insert against Postgres). Returns the new row id, or
// null if the slot was already taken.
export async function reserveSlot(env, b, now) {
  const holdExpires = now + HOLD_SECONDS;
  const result = await sbRequest(env, {
    path: '/rest/v1/rpc/reserve_slot',
    method: 'POST',
    body: {
      p_booking_date: b.bookingDate,
      p_start_min: b.startMin,
      p_end_min: b.endMin,
      p_treatment: b.treatment || null,
      p_customer_name: b.name || null,
      p_customer_email: b.email || null,
      p_customer_phone: b.phone || null,
      p_location: b.location || null,
      p_address: b.address || null,
      p_amount_pence: Number.isFinite(b.amountPence) ? b.amountPence : null,
      p_hold_expires_at: holdExpires,
      p_now: now,
      p_discount_code: b.discountCode || null,
      p_discount_pence: Number.isFinite(b.discountPence) ? b.discountPence : null,
      p_travel_zone: b.travelZone || null,
      p_travel_pence: Number.isFinite(b.travelPence) ? b.travelPence : null,
      // Only sent for a multi-treatment booking, so a single-treatment
      // booking calls the function exactly as it always did.
      ...(Array.isArray(b.treatments) && b.treatments.length > 1 ? { p_treatments: b.treatments } : {}),
    },
  });
  return result; // the function returns the new id, or null if the slot was taken
}

// Every booking that isn't a long-dead hold — confirmed, not-yet-lapsed
// pending holds, and cancelled rows (shown greyed out) — oldest first, for
// the admin calendar. Upcoming/past filtering happens client-side in the
// admin page so the toggle is instant with no re-fetch.
export async function listBookings(env) {
  const now = Math.floor(Date.now() / 1000);
  const rows = await sbRequest(env, {
    path: '/rest/v1/bookings?select=id,booking_date,start_min,end_min,treatment,customer_name,'
      + 'customer_email,customer_phone,location,address,amount_pence,status,hold_expires_at,created_at,'
      + 'discount_code,discount_pence,travel_zone,travel_pence,treatments'
      + `&or=(status.eq.confirmed,status.eq.reschedule_pending,status.eq.cancelled,and(status.eq.pending,hold_expires_at.gt.${now}))`
      + '&order=booking_date.asc,start_min.asc',
    method: 'GET',
  });
  return rows || [];
}

// Flip a held row to 'confirmed' on payment. Returns { found, conflict }:
// `found` is false if the row no longer exists; `conflict` is true when
// another active booking overlaps it (possible if the payment landed after
// the 10-minute hold lapsed and someone else reserved the same time — see
// STRIPE_SESSION_SECONDS). The booking is confirmed either way, because the
// customer has paid; the caller flags the clash to Halima.
// Saves where a booking came from (ad-link tags + the "how did you hear" answer). Only known keys, short text.
// Fail-open and column-tolerant: if the columns have not been added yet (supabase-bookings-schema.sql) this logs and
// the booking carries on untouched.
export async function setBookingSource(env, bookingId, { utm, referral }) {
  const clean = (v) => (typeof v === 'string' ? v.trim().slice(0, 80) : '') || null;
  const u = utm && typeof utm === 'object' ? utm : {};
  const body = { utm_source: clean(u.utm_source), utm_medium: clean(u.utm_medium), utm_campaign: clean(u.utm_campaign), utm_content: clean(u.utm_content), referral: clean(referral) };
  if (!Object.values(body).some(Boolean)) return;
  try {
    await sbRequest(env, { path: `/rest/v1/bookings?id=eq.${bookingId}`, method: 'PATCH', body });
  } catch (err) {
    console.error('setBookingSource failed (columns missing?):', err);
  }
}

export async function confirmBooking(env, bookingId) {
  const rows = await sbRequest(env, {
    path: `/rest/v1/bookings?id=eq.${bookingId}&select=id,booking_date,start_min,end_min`,
    method: 'PATCH',
    prefer: 'return=representation',
    body: { status: 'confirmed' },
  });
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return { found: false, conflict: false };
  const now = Math.floor(Date.now() / 1000);
  const others = await sbRequest(env, {
    path: `/rest/v1/bookings?select=id&booking_date=eq.${row.booking_date}&id=neq.${row.id}`
      + `&start_min=lt.${row.end_min}&end_min=gt.${row.start_min}&${activeFilter(now)}`,
    method: 'GET',
  });
  return { found: true, conflict: Array.isArray(others) && others.length > 0 };
}

// Cancel a booking (any status). The time is free again immediately — the
// availability queries only count confirmed rows and live holds. Refunds are
// handled in the Stripe dashboard, not here.
export async function cancelBooking(env, bookingId) {
  const rows = await sbRequest(env, {
    path: `/rest/v1/bookings?id=eq.${bookingId}&select=id`,
    method: 'PATCH',
    prefer: 'return=representation',
    body: { status: 'cancelled' },
  });
  const cancelled = Array.isArray(rows) && rows.length > 0;
  // A gift/reward/competition code used on this booking becomes usable again
  // — see the comment on releaseRedemptionForCancelledBooking (_discounts.js).
  if (cancelled) await releaseRedemptionForCancelledBooking(env, bookingId);
  return cancelled;
}

export async function releaseBooking(env, bookingId) {
  await sbRequest(env, {
    path: `/rest/v1/bookings?id=eq.${bookingId}&status=eq.pending`,
    method: 'DELETE',
    prefer: 'return=minimal',
  });
}

// Signed "release my hold" reference, put on Stripe's cancel_url so a customer
// who taps Back from Checkout frees their slot at once instead of waiting out
// the hold. Signed with the Stripe secret so ids can't be guessed to release
// someone else's hold. ref = `${bookingId}.${discountRedemptionId || 0}.${sig}`.
async function holdSig(env, payload) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(String(env.STRIPE_SECRET_KEY || '')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
export async function makeHoldRef(env, bookingId, redemptionId) {
  const payload = `${bookingId}.${redemptionId || 0}`;
  return `${payload}.${await holdSig(env, payload)}`;
}
// Returns { bookingId, redemptionId } if the ref is genuine, else null.
export async function parseHoldRef(env, ref) {
  const m = /^(\d{1,12})\.(\d{1,12})\.([0-9a-f]{32})$/.exec(String(ref || ''));
  if (!m) return null;
  if ((await holdSig(env, `${m[1]}.${m[2]}`)) !== m[3]) return null;
  return { bookingId: m[1], redemptionId: m[2] === '0' ? null : m[2] };
}
