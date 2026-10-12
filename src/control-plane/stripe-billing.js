/**
 * Stripe Checkout + webhook helpers for Searchable Pro.
 * Requires STRIPE_SECRET_KEY, STRIPE_PRICE_ID, STRIPE_WEBHOOK_SECRET.
 */

let stripeSingleton = null;

export function isStripeConfigured() {
  return Boolean(
    (process.env.STRIPE_SECRET_KEY || '').trim()
    && (process.env.STRIPE_PRICE_ID || '').trim(),
  );
}

export async function getStripe() {
  if (!isStripeConfigured()) return null;
  if (stripeSingleton) return stripeSingleton;
  const { default: Stripe } = await import('stripe');
  stripeSingleton = new Stripe(process.env.STRIPE_SECRET_KEY.trim());
  return stripeSingleton;
}

export async function createCheckoutSession({
  customerEmail,
  userId,
  successUrl,
  cancelUrl,
}) {
  const stripe = await getStripe();
  if (!stripe) throw new Error('Stripe is not configured');
  const priceId = process.env.STRIPE_PRICE_ID.trim();
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer_email: customerEmail,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: userId,
    metadata: { searchable_user_id: userId },
    allow_promotion_codes: true,
  });
  return session;
}

export async function createCustomerPortalSession({ customerId, returnUrl }) {
  const stripe = await getStripe();
  if (!stripe) throw new Error('Stripe is not configured');
  return stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });
}

export async function constructWebhookEvent(rawBody, signature) {
  const stripe = await getStripe();
  const secret = (process.env.STRIPE_WEBHOOK_SECRET || '').trim();
  if (!stripe || !secret) throw new Error('Stripe webhook not configured');
  return stripe.webhooks.constructEvent(rawBody, signature, secret);
}

/** Reset cached client (tests). */
export function resetStripeForTests() {
  stripeSingleton = null;
}
