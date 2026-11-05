// Shared discount-code validation and reservation — used by apply-discount.js
// (the live "Apply" check on step 5), create-checkout.js (which re-validates
// and reserves the redemption at payment time), and stripe-webhook.js (which
// confirms the reservation once Stripe has actually been paid). The `_`
// prefix keeps this file from becoming a route.
//
// Five code types live as rows in Supabase's discount_codes table
// (supabase-discounts-schema.sql), not as constants here, so Halima can add
// more later with a SQL insert:
//   promo        public, no collaborator, usually time-limited
//   gift         100% off, locked to one collaborator's email, one use total
//   audience     a collaborator's followers, first-time clients only
//   reward       auto-created every 5 completed audience-code bookings
//   competition  POD Football GOTW/POTM winners, one use per week/month
//
// Redemptions are tracked the same way slot holds are (_bookings.js):
// 'reserved' the moment a checkout starts, 'confirmed' on payment,
// 'released' if the checkout is abandoned or the code fails re-validation.
// Two partial unique indexes on code_redemptions (one per code, one per
// code+customer) make the reservation INSERT itself race-safe — see the
// schema file — the same reasoning that made reserveSlot() need a Postgres
// function, except here a plain unique-index insert is enough because the
// "is this slot taken" question collapses to an exact key match rather than
// an overlap check.

import { sbRequest } from './_supabase.js';
import '../offer-config.js'; // defines globalThis.siteOfferPercent (used by priceWithCode)

// How long a reservation is held before it's treated as abandoned. Matches
// STRIPE_SESSION_SECONDS (_bookings.js) — a discount code held for the
// customer's whole Checkout Session, not just the shorter slot hold, so a
// slow payer never has their code released out from under them while
// Stripe still has their session open.
export const DISCOUNT_HOLD_SECONDS = 30 * 60;

// 'YYYY-Www' for a week code, 'YYYY-MM' for a month code, null otherwise.
// ISO 8601 week numbering (Monday-start, week 1 contains the year's first
// Thursday) so "this week's" winner lines up with however Halima thinks of
// "this week" in the UK.
function periodKeyFor(period, now) {
  if (period !== 'week' && period !== 'month') return null;
  const d = new Date(now * 1000);
  if (period === 'month') {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (dt.getUTCDay() + 6) % 7; // Monday = 0
  dt.setUTCDate(dt.getUTCDate() - dayNum + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(
    ((dt - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7
  );
  return `${dt.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// Best-effort: flips long-abandoned 'reserved' rows to 'released' so a
// single-use code doesn't stay permanently locked by a checkout nobody
// finished. Mirrors purgeExpiredHolds() in _bookings.js. Safe to skip —
// every read below already treats a stale reserved row as live only until
// this has had a chance to run, and it's called before every validation.
export async function releaseExpiredDiscountHolds(env, now) {
  try {
    await sbRequest(env, {
      path: `/rest/v1/code_redemptions?status=eq.reserved&hold_expires_at=lt.${now}`,
      method: 'PATCH',
      prefer: 'return=minimal',
      body: { status: 'released' },
    });
  } catch (e) {
    console.error('releaseExpiredDiscountHolds failed:', e);
  }
}

// Looks up `rawCode` and checks it against `email`/`phone`. Returns
// { ok:true, codeId, code, percent, type, periodKey } or { ok:false, reason },
// where reason is one of: missing_code, missing_email, invalid_code, expired,
// wrong_email, not_first_time, already_used.
export async function validateDiscountCode(env, rawCode, email, phone, now) {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!code) return { ok: false, reason: 'missing_code' };
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) return { ok: false, reason: 'missing_email' };

  await releaseExpiredDiscountHolds(env, now);

  const rows = await sbRequest(env, {
    path: `/rest/v1/discount_codes?code=eq.${encodeURIComponent(code)}&select=`
      + 'id,code,type,percent_off,max_uses_total,max_uses_per_customer,first_time_only,'
      + 'valid_from,valid_until,period,allowed_email,active&limit=1',
    method: 'GET',
  });
  const row = (rows || [])[0];
  if (!row || !row.active) return { ok: false, reason: 'invalid_code' };
  if (row.valid_from && now < row.valid_from) return { ok: false, reason: 'invalid_code' };
  if (row.valid_until && now > row.valid_until) return { ok: false, reason: 'expired' };

  if (row.allowed_email && normalizedEmail !== String(row.allowed_email).trim().toLowerCase()) {
    return { ok: false, reason: 'wrong_email' };
  }

  // "First-time client" = no earlier PAID/COMPLETED booking under this email
  // OR this phone number — a returning client can't dodge the check by
  // booking under a new email with the same phone.
  if (row.first_time_only) {
    const normalizedPhone = String(phone || '').trim();
    const filters = [`customer_email.ilike.${encodeURIComponent(normalizedEmail)}`];
    if (normalizedPhone) filters.push(`customer_phone.eq.${encodeURIComponent(normalizedPhone)}`);
    const prior = await sbRequest(env, {
      path: `/rest/v1/bookings?select=id&status=eq.confirmed&or=(${filters.join(',')})&limit=1`,
      method: 'GET',
    });
    if (prior && prior.length > 0) return { ok: false, reason: 'not_first_time' };
  }

  const periodKey = periodKeyFor(row.period, now);

  if (row.max_uses_total) {
    const used = await sbRequest(env, {
      path: `/rest/v1/code_redemptions?select=id&code_id=eq.${row.id}&status=in.(reserved,confirmed)&limit=${row.max_uses_total}`,
      method: 'GET',
    });
    if (used && used.length >= row.max_uses_total) return { ok: false, reason: 'already_used' };
  }

  if (row.max_uses_per_customer) {
    const used = await sbRequest(env, {
      path: `/rest/v1/code_redemptions?select=id&code_id=eq.${row.id}&status=in.(reserved,confirmed)`
        + `&customer_email=ilike.${encodeURIComponent(normalizedEmail)}&limit=${row.max_uses_per_customer}`,
      method: 'GET',
    });
    if (used && used.length >= row.max_uses_per_customer) return { ok: false, reason: 'already_used' };
  }

  if (periodKey) {
    const used = await sbRequest(env, {
      path: `/rest/v1/code_redemptions?select=id&code_id=eq.${row.id}&period_key=eq.${encodeURIComponent(periodKey)}&status=in.(reserved,confirmed)&limit=1`,
      method: 'GET',
    });
    if (used && used.length > 0) return { ok: false, reason: 'already_used' };
  }

  // Some free codes (e.g. a client whose home-visit travel Halima covers) also
  // waive the travel fee. Read separately and fail-safe: if the waive_travel
  // column hasn't been added yet this is false, so no other code is affected.
  let waivesTravel = false;
  try {
    const w = await sbRequest(env, { path: `/rest/v1/discount_codes?id=eq.${row.id}&select=waive_travel&limit=1`, method: 'GET' });
    waivesTravel = !!(w && w[0] && w[0].waive_travel);
  } catch (_) { /* column not added yet */ }
  return { ok: true, codeId: row.id, code: row.code, percent: row.percent_off, type: row.type, periodKey, waivesTravel };
}

// Applies a validated percent-off to an amount already in pence, rounding to
// the nearest penny. Only ever called with the TREATMENT price — travel is
// never discounted (see create-checkout.js and CLAUDE.md's Travel cost note).
export function applyDiscount(amountPence, percent) {
  const discountPence = Math.round(amountPence * (percent / 100));
  return { discountPence, finalPence: amountPence - discountPence };
}

// Never stacks a code with the site-wide introductory offer (offer-config.js): the customer gets whichever
// single discount is larger. `cart` is a resolveCart() result — listTotalPence is the undiscounted price,
// totalPence is the price with the site offer already taken off. Returns
//   { usesCode, finalPence, discountPence }   discountPence is measured against cart.totalPence (what the
//   booking page shows), so an applied code always reads as a saving on the displayed price.
// A code that would not beat the offer (percent <= offer) is not used: usesCode is false, nothing is
// reserved, and the customer keeps the site offer. Codes that waive travel are always usable.
export function priceWithCode(cart, codePercent, waivesTravel, now) {
  const sitePercent = globalThis.siteOfferPercent(now);
  if (!(codePercent > sitePercent) && !waivesTravel) {
    return { usesCode: false, finalPence: cart.totalPence, discountPence: 0 };
  }
  const percent = Math.max(codePercent, sitePercent);
  const finalPence = cart.listTotalPence - Math.round(cart.listTotalPence * (percent / 100));
  const best = Math.min(finalPence, cart.totalPence);
  return { usesCode: true, finalPence: best, discountPence: cart.totalPence - best };
}

// Reserves a redemption right before Stripe Checkout is created (or
// immediately, for a code that makes the booking free). The two partial
// unique indexes in the schema make the INSERT itself the race guard: two
// simultaneous bookings can both pass validateDiscountCode()'s read-only
// checks, but only one INSERT here succeeds. The loser gets a Postgres
// unique-violation (23505), reported back as null — same contract as
// reserveSlot() reporting a taken slot.
// `type` 'promo' (a reusable promotional code) is reusable without limit until it expires, so
// it's written with enforce_limits = false and enforce_customer = false: the
// DB's unique indexes ignore it entirely.
// `type` 'audience' (YASMZEE25 etc.) has no total cap — many followers use it —
// so enforce_limits = false lifts the one-use-per-code index, but
// enforce_customer stays true so the DB still allows each email only once.
export async function reserveDiscountCode(env, { codeId, email, discountPence, periodKey, type }, now) {
  try {
    const rows = await sbRequest(env, {
      path: '/rest/v1/code_redemptions',
      method: 'POST',
      prefer: 'return=representation',
      body: {
        code_id: codeId,
        customer_email: String(email || '').trim().toLowerCase(),
        discount_amount: discountPence,
        status: 'reserved',
        period_key: periodKey || null,
        enforce_limits: type !== 'promo' && type !== 'audience',
        enforce_customer: type !== 'promo',
        hold_expires_at: now + DISCOUNT_HOLD_SECONDS,
        created_at: now,
      },
    });
    const row = Array.isArray(rows) ? rows[0] : null;
    return row ? row.id : null;
  } catch (err) {
    if (String(err.message || '').includes('23505')) return null; // raced — code just taken
    throw err;
  }
}

// Flips a held redemption to 'confirmed' once Stripe has actually been paid
// (or immediately, for a free booking). Only moves a 'reserved' row, so it's
// a no-op if the reservation already lapsed and got released.
export async function confirmDiscountRedemption(env, redemptionId, bookingId) {
  await sbRequest(env, {
    path: `/rest/v1/code_redemptions?id=eq.${redemptionId}&status=eq.reserved`,
    method: 'PATCH',
    prefer: 'return=minimal',
    body: { status: 'confirmed', booking_id: bookingId ?? null },
  });
}

// Frees a reservation — Stripe session creation failed, or the reserved
// booking's slot turned out to be taken. Only moves a 'reserved' row, so it
// can't accidentally un-confirm a code that somehow already got paid.
export async function releaseDiscountReservation(env, redemptionId) {
  await sbRequest(env, {
    path: `/rest/v1/code_redemptions?id=eq.${redemptionId}&status=eq.reserved`,
    method: 'PATCH',
    prefer: 'return=minimal',
    body: { status: 'released' },
  });
}

// Cancellations reopen a gift/reward/competition code (never promo or
// audience — those aren't the ones the brief says become usable again).
// Best-effort and silent: a code that fails to release just stays used,
// which is the safe direction to fail in.
export async function releaseRedemptionForCancelledBooking(env, bookingId) {
  try {
    const rows = await sbRequest(env, {
      path: `/rest/v1/code_redemptions?booking_id=eq.${bookingId}&status=eq.confirmed&select=id,code_id`,
      method: 'GET',
    });
    const redemption = (rows || [])[0];
    if (!redemption) return;
    const codeRows = await sbRequest(env, {
      path: `/rest/v1/discount_codes?id=eq.${redemption.code_id}&select=type`,
      method: 'GET',
    });
    const type = (codeRows || [])[0]?.type;
    if (type === 'gift' || type === 'reward' || type === 'competition') {
      await sbRequest(env, {
        path: `/rest/v1/code_redemptions?id=eq.${redemption.id}`,
        method: 'PATCH',
        prefer: 'return=minimal',
        body: { status: 'released' },
      });
    }
  } catch (e) {
    console.error('releaseRedemptionForCancelledBooking failed:', e);
  }
}
