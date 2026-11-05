import { reserveSlot, confirmBooking, releaseBooking, slotToMinutes, makeHoldRef, STRIPE_SESSION_SECONDS } from './_bookings.js';
import { isOfferableStart, TURNAROUND_MIN } from './_slots.js';
import { CLINIC_RULES, CLINIC_VENUE_NAME, CLINIC_VENUE_ADDRESS } from './_clinic.js';
import { resolveCart, formatDuration, cartFitsLocation } from './_services.js';
import { validateDiscountCode, priceWithCode, reserveDiscountCode, confirmDiscountRedemption, releaseDiscountReservation } from './_discounts.js';
import { travelQuote, travelLabelFor } from './_travel.js';
import { notifyBooking, formatGBP, upperPostcode } from './_notify.js';

export async function onRequestPost(context) {
  try {
    const { treatmentName: legacyName, treatmentCategory: legacyCategory, treatments, customerEmail, customerName, customerPhone, customerAddress, date, time, location: rawLocation, notes, bookingDate, discountCode, travelPostcode } = await context.request.json();
    // location is 'clinic' | 'mobile' | 'virtual' (online coaching only). Every booking is paid in full — there is
    // no deposit path.
    const location = rawLocation || 'mobile';
    const venue = location === 'clinic' ? CLINIC_VENUE_NAME : '';

    // Price AND duration come from the server-side catalogue, never the
    // client — a tampered request body must never set its own amount or
    // session length. `treatments` is the cart: [{ name, category }]. The old
    // single treatmentName/treatmentCategory pair still works (one-item cart).
    // category is required: four names are reused across dry/wet cupping at
    // different prices (see the comment on findService()).
    const cart = resolveCart(Array.isArray(treatments) ? treatments : [{ name: legacyName, category: legacyCategory }]);
    if (!cart.ok) {
      return new Response(JSON.stringify({ error: cart.error }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    // Online is coaching only; Milton Hall and home visits take any treatment, coaching included.
    if (!cartFitsLocation(cart.items, location)) {
      return new Response(JSON.stringify({ error: 'treatment_location_mismatch' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const isVirtual = location === 'virtual';
    // Display name for emails/Stripe/admin: "Face Massage + Head Massage".
    // Names never contain " + ", so the webhook can split it back apart.
    const treatmentName = cart.items.map(x => x.name).join(' + ');
    const totalDurationMin = cart.totalMin;
    const originalAmount = cart.totalPence; // pence — the COMBINED treatment price only
    const now = Math.floor(Date.now() / 1000);
    const hasSupabase = Boolean(context.env.SUPABASE_URL && context.env.SUPABASE_SERVICE_ROLE_KEY);

    // The discount is re-validated from scratch here — never trust that the
    // client's earlier /apply-discount check still holds. A code could have
    // expired, been deactivated, or been redeemed by the same email/phone in
    // another tab in the meantime. A code that fails re-validation rejects
    // the checkout outright (rather than silently charging full price)
    // rather than surprise a customer who saw a discounted total.
    //
    // Deliberately applied to `originalAmount` (the treatment price) alone,
    // before travelPence is computed or added anywhere below — a discount
    // code can never reach the travel fee, because the travel figure simply
    // doesn't exist yet at this point in the function.
    let treatmentAmount = originalAmount;
    let appliedCode = null;
    let appliedPercent = 0;
    let discountPenceApplied = 0;
    let discountRedemptionId = null;
    let waivesTravel = false;
    if (discountCode) {
      if (!hasSupabase) {
        return new Response(JSON.stringify({ error: 'discount_unavailable' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const result = await validateDiscountCode(context.env, discountCode, customerEmail, customerPhone, now);
      if (!result.ok) {
        return new Response(JSON.stringify({ error: 'discount_invalid', reason: result.reason }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      // Never stacks with the site-wide offer: the larger single discount wins. A code that would not beat
      // the offer is refused here, before anything is reserved, so it is not used up for nothing.
      const applied = priceWithCode(cart, result.percent, !!result.waivesTravel, new Date());
      if (!applied.usesCode) {
        return new Response(JSON.stringify({ error: 'discount_invalid', reason: 'offer_better' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      treatmentAmount = applied.finalPence;
      discountPenceApplied = applied.discountPence;
      appliedCode = result.code;
      appliedPercent = result.percent;
      waivesTravel = !!result.waivesTravel;

      // Reserved the moment it passes validation — see the file header on
      // _discounts.js for why the INSERT itself is what actually prevents
      // two simultaneous bookings both using up a single-use code.
      discountRedemptionId = await reserveDiscountCode(context.env, {
        codeId: result.codeId,
        email: customerEmail,
        discountPence: discountPenceApplied,
        periodKey: result.periodKey,
        type: result.type,
      }, now);
      if (discountRedemptionId === null) {
        return new Response(JSON.stringify({ error: 'discount_invalid', reason: 'already_used' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // Travel fee — home visits only, zone computed server-side from the
    // postcode (distance from Halima's start point, see _travel.js), never
    // trusted from the client. Clinic Day bookings have a fixed venue and
    // never get a travel line. An unknown postcode or an unreachable lookup
    // (book.html validates before letting the customer continue) falls back
    // to zone 'Q' (confirmed by WhatsApp) rather than blocking payment.
    let travelZone = null;
    let travelPence = 0;
    if (location === 'mobile') {
      const quote = await travelQuote(travelPostcode);
      travelZone = quote.valid ? quote.zone : 'Q';
      travelPence = quote.valid ? quote.pence : 0;
      // A code flagged waive_travel (Halima covers this client's travel) removes the fee
      // entirely. Every other code still never touches travel.
      if (waivesTravel) travelPence = 0;
    }

    let totalAmount = treatmentAmount + travelPence;
    // Stripe's minimum UK card charge is £0.30 — a session below that can
    // never actually be created. No current treatment/discount combination
    // reaches this low, but if one ever does, treat it the same way a
    // genuine £0 booking is treated rather than letting Stripe reject it.
    if (totalAmount > 0 && totalAmount < 30) totalAmount = 0;

    const secretKey = context.env.STRIPE_SECRET_KEY;
    const origin = new URL(context.request.url).origin;

    // --- Validate the start time against the opening hours (_slots.js) ---
    // The wizard generates its slots from the same table, so a start that
    // isn't on the grid (or is inside the same-day minimum notice) can only
    // come from a tampered or stale request. Rejected outright — this is
    // static config, so there's nothing to fail open over.
    const startMin = slotToMinutes(time);
    // Milton Hall must be fully out by closing time: start + real treatment length + tidy-up. The wizard never offers a
    // start that breaks this, so a request that does is tampered or stale.
    if (startMin === null || !isOfferableStart({ location: location === 'clinic' ? 'clinic' : 'mobile', dateISO: bookingDate, startMin }) || (location === 'clinic' && !CLINIC_RULES.fits(startMin, totalDurationMin))) {
      if (discountRedemptionId !== null) {
        try { await releaseDiscountReservation(context.env, discountRedemptionId); } catch (e) { console.error('releaseDiscountReservation failed:', e); }
      }
      return new Response(JSON.stringify({ error: 'slot_invalid' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // --- Reserve the slot before taking payment (prevents double-booking) ---
    // Held as 'pending' for HOLD_SECONDS (10 min); the webhook confirms it on
    // payment, and an abandoned checkout's hold simply lapses. The duration
    // comes from the server-side catalogue (`min` in _services.js), never
    // from the client. If Supabase isn't configured we fail OPEN and let the
    // booking proceed unreserved — never block a paying customer over an
    // availability bug.
    // One slot sized to every selected treatment back to back; the turnaround
    // gap is added to the held interval (endMin below), not to what's shown.
    const duration = totalDurationMin;
    let bookingId = null;

    if (hasSupabase && bookingDate && startMin !== null) {
      try {
        bookingId = await reserveSlot(context.env, {
          bookingDate,
          startMin,
          // Blocked-until: the treatment plus the turnaround gap. The client is
          // only ever told the real length (emails, summary, admin).
          endMin: startMin + duration + TURNAROUND_MIN,
          treatment: treatmentName,
          treatments: cart.items.length > 1 ? cart.items.map(x => ({ name: x.name, category: x.category, pricePence: x.pricePence, min: x.min })) : null,
          name: customerName,
          email: customerEmail,
          phone: customerPhone,
          location,
          address: location === 'clinic' ? `${venue} — ${CLINIC_VENUE_ADDRESS}` : isVirtual ? 'Online (video call)' : customerAddress,
          amountPence: Number(totalAmount),
          discountCode: appliedCode,
          discountPence: discountPenceApplied,
          travelZone,
          travelPence,
        }, now);

        if (bookingId === null) {
          // Someone else took it during checkout. Ask the client to pick again.
          if (discountRedemptionId !== null) {
            try { await releaseDiscountReservation(context.env, discountRedemptionId); } catch (e) { console.error('releaseDiscountReservation failed:', e); }
          }
          return new Response(JSON.stringify({ error: 'slot_taken' }), {
            status: 409,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      } catch (err) {
        console.error('Slot reservation failed (proceeding without hold):', err);
        bookingId = null;
      }
    }

    const venueAddress = location === 'clinic' ? `${venue} — ${CLINIC_VENUE_ADDRESS}` : isVirtual ? 'Online (video call)' : customerAddress;

    // --- Free booking (a 100%-off gift/reward/competition code) ---
    // No Stripe involved at all — there's nothing to pay, and Stripe Checkout
    // doesn't take £0 sessions. Confirm the slot and the redemption straight
    // away and send the exact same notifications the webhook would send for a
    // paid booking (see _notify.js).
    if (totalAmount === 0) {
      let slotConflict = false;
      if (hasSupabase && bookingId !== null) {
        try {
          const result = await confirmBooking(context.env, bookingId);
          slotConflict = Boolean(result && result.conflict);
        } catch (err) {
          console.error('Failed to confirm free booking slot:', err);
        }
      }
      if (hasSupabase && discountRedemptionId !== null) {
        try { await confirmDiscountRedemption(context.env, discountRedemptionId, bookingId); } catch (err) { console.error('Failed to confirm discount redemption:', err); }
      }

      const detail = {
        name: customerName, phone: customerPhone, email: customerEmail,
        treatment: treatmentName, treatments: cart.items.map(x => x.name), durationLabel: formatDuration(totalDurationMin),
        date, time, location, venue, bookingDate, startMin, durationMin: totalDurationMin,
        address: isVirtual ? '' : upperPostcode(location === 'clinic' ? venueAddress : customerAddress),
        amount: formatGBP(0), paymentLabel: `${formatGBP(0)} — paid in full`, notes,
        originalAmountLabel: appliedCode ? formatGBP(originalAmount) : '',
        discountRowLabel: appliedCode ? `${appliedCode} discount` : '',
        discountLabel: appliedCode ? `−${formatGBP(discountPenceApplied)}` : '',
        travelLabel: location === 'mobile' ? (waivesTravel ? 'Covered by haloe' : travelZone === 'Q' ? 'Confirmed by WhatsApp before the session' : formatGBP(travelPence)) : '',
        travelZone: location === 'mobile' ? travelZone : '',
        travelPence: location === 'mobile' ? travelPence : 0,
        slotConflict,
        bookingId,
      };
      await notifyBooking(context.env, detail);

      const successParams = new URLSearchParams({
        name: customerName || '', treatment: treatmentName || '', duration: String(totalDurationMin), date: date || '', time: time || '',
        location, venue: venue || '', amount: '0', treatmentAmount: '0',
        ...(appliedCode ? { discountCode: appliedCode, discountAmount: String(discountPenceApplied), originalAmount: String(originalAmount) } : {}),
        ...(location === 'mobile' ? { travelZone, travelPence: '0' } : {}),
      });
      return new Response(JSON.stringify({ url: `${origin}/booking-confirmed.html?${successParams.toString()}` }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const productName = `Full payment — ${treatmentName}`;

    const discountNote = appliedCode ? ` ${appliedCode} applied: ${appliedPercent}% off the treatment price.` : '';
    const description = `Full payment for ${treatmentName} with haloe.${discountNote} Free reschedule or full refund up to 48 hours before your session. Inside 48 hours, sessions are non-refundable but can be moved once. No-shows are charged in full.`;

    const params = new URLSearchParams();
    params.append('payment_method_types[]', 'card');
    params.append('mode', 'payment');
    params.append('customer_email', customerEmail);
    params.append('line_items[0][price_data][currency]', 'gbp');
    params.append('line_items[0][price_data][product_data][name]', productName);
    params.append('line_items[0][price_data][product_data][description]', description);
    params.append('line_items[0][price_data][unit_amount]', String(treatmentAmount));
    params.append('line_items[0][quantity]', '1');
    // Travel is always its own line item for a home visit — never merged into
    // the treatment price, and never discounted (see the comment above where
    // treatmentAmount is computed). Zone Q has no fixed fee, but still gets a
    // £0 line so it's itemised everywhere a real fee would be, rather than
    // silently missing.
    if (location === 'mobile') {
      const travelName = waivesTravel ? 'Travel — covered by haloe'
        : travelZone === 'Q'
        ? 'Travel — confirmed by WhatsApp before your session'
        : `Travel — ${travelLabelFor(travelZone).toLowerCase()}`;
      params.append('line_items[1][price_data][currency]', 'gbp');
      params.append('line_items[1][price_data][product_data][name]', travelName);
      params.append('line_items[1][price_data][product_data][description]', 'Home-visit travel fee. Never discounted by promotional codes.');
      params.append('line_items[1][price_data][unit_amount]', String(travelPence));
      params.append('line_items[1][quantity]', '1');
    }
    params.append('metadata[customerName]', customerName);
    params.append('metadata[customerPhone]', customerPhone || '');
    params.append('metadata[treatmentName]', treatmentName);
    params.append('metadata[treatmentCount]', String(cart.items.length));
    params.append('metadata[totalDurationMin]', String(totalDurationMin));
    params.append('metadata[date]', date || '');
    params.append('metadata[time]', time || '');
    params.append('metadata[location]', location);
    params.append('metadata[bookingDate]', bookingDate || '');
    params.append('metadata[startMin]', String(startMin));
    if (venue) params.append('metadata[venue]', venue);
    params.append('metadata[customerAddress]', customerAddress || '');
    params.append('metadata[notes]', notes || '');
    if (bookingId !== null) params.append('metadata[bookingId]', String(bookingId));
    if (appliedCode) {
      params.append('metadata[discountCode]', appliedCode);
      params.append('metadata[discountPence]', String(discountPenceApplied));
      params.append('metadata[originalAmountPence]', String(originalAmount));
      if (discountRedemptionId !== null) params.append('metadata[discountRedemptionId]', String(discountRedemptionId));
    }
    if (location === 'mobile') {
      params.append('metadata[travelZone]', travelZone);
      params.append('metadata[travelPence]', String(travelPence));
    }
    // The same figure Stripe is being charged (treatmentAmount + travelPence)
    // — a fallback for the webhook's "Total paid" if session.amount_total is
    // ever missing, so that fallback can't silently diverge from what the
    // customer actually paid.
    params.append('metadata[totalAmountPence]', String(totalAmount));
    // Stripe's minimum Checkout Session lifetime is 30 minutes — longer than
    // our 10-minute slot hold, unavoidably. A payment that lands after the
    // hold lapsed is still confirmed; the webhook flags any clash to Halima
    // (see confirmBooking in _bookings.js).
    params.append('expires_at', String(now + STRIPE_SESSION_SECONDS));
    const successParams = new URLSearchParams({
      name: customerName || '',
      treatment: treatmentName || '',
      duration: String(totalDurationMin),
      date: date || '',
      time: time || '',
      location,
      venue: venue || '',
      amount: String(totalAmount),
      treatmentAmount: String(treatmentAmount),
      ...(appliedCode ? {
        discountCode: appliedCode,
        discountAmount: String(discountPenceApplied),
        originalAmount: String(originalAmount),
      } : {}),
      ...(location === 'mobile' ? {
        travelZone,
        travelPence: String(travelPence),
      } : {}),
    });
    params.append('success_url', `${origin}/booking-confirmed.html?${successParams.toString()}`);
    // Back from Checkout releases the hold straight away (see release-hold.js).
    const holdRef = bookingId ? await makeHoldRef(context.env, bookingId, discountRedemptionId) : null;
    params.append('cancel_url', holdRef ? `${origin}/book.html?release=${holdRef}` : `${origin}/book.html`);

    const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    const session = await response.json();

    if (!response.ok) {
      console.error('Stripe error:', session);
      // Payment setup failed — free the slot and the discount reservation we
      // just held so neither is stuck.
      if (hasSupabase && bookingId !== null) {
        try { await releaseBooking(context.env, bookingId); } catch (e) { console.error('releaseBooking failed:', e); }
      }
      if (hasSupabase && discountRedemptionId !== null) {
        try { await releaseDiscountReservation(context.env, discountRedemptionId); } catch (e) { console.error('releaseDiscountReservation failed:', e); }
      }
      return new Response(JSON.stringify({ error: session.error?.message || 'Stripe error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ url: session.url }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('Function error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
