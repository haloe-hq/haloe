// Cloudflare Pages Function — POST /apply-discount
//
// Live-validates a discount code on step 5 of book.html before checkout, so
// the customer sees a real discounted total (and a clear error) rather than
// finding out at the Stripe redirect. This is a preview only — create-checkout.js
// re-validates and recomputes the amount itself at payment time; this endpoint's
// response is never trusted for the actual charge.
import { validateDiscountCode, priceWithCode } from './_discounts.js';
import { resolveCart } from './_services.js';

export async function onRequestPost(context) {
  try {
    const { code, email, phone, treatmentName, treatmentCategory, treatments } = await context.request.json();

    // Category-scoped — see the comment on findService() (_services.js):
    // four treatment names are reused across dry/wet cupping at different
    // prices, so a category-less lookup can silently price the wrong one.
    // `treatments` is the multi-treatment cart; the old single
    // treatmentName/treatmentCategory pair is still accepted.
    const cart = resolveCart(Array.isArray(treatments) ? treatments : [{ name: treatmentName, category: treatmentCategory }]);
    if (!cart.ok) {
      return new Response(JSON.stringify({ ok: false, error: cart.error }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!context.env.SUPABASE_URL || !context.env.SUPABASE_SERVICE_ROLE_KEY) {
      // Fail closed here (unlike slot reservation): a discount code that
      // can't be verified must never be silently accepted.
      return new Response(JSON.stringify({ ok: false, error: 'unavailable' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const now = Math.floor(Date.now() / 1000);
    const result = await validateDiscountCode(context.env, code, email, phone, now);
    if (!result.ok) {
      return new Response(JSON.stringify({ ok: false, error: result.reason }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const originalAmountPence = cart.totalPence; // the COMBINED treatment price, site offer already taken off
    // Never stacks with the site-wide offer: the larger single discount wins (see priceWithCode()).
    const priced = priceWithCode(cart, result.percent, !!result.waivesTravel, new Date());
    if (!priced.usesCode) {
      return new Response(JSON.stringify({ ok: false, error: 'offer_better' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    const discountPence = priced.discountPence, finalPence = priced.finalPence;

    return new Response(JSON.stringify({
      ok: true,
      code: result.code,
      percent: result.percent,
      originalAmountPence,
      discountAmountPence: discountPence,
      finalAmountPence: finalPence,
      waivesTravel: !!result.waivesTravel,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('apply-discount error:', err);
    return new Response(JSON.stringify({ ok: false, error: 'server_error' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
