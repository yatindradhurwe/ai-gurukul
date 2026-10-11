import { randomUUID } from "node:crypto";
import { env } from "../../config/env.js";
import { hmacSha256Hex, safeEqualHex } from "../../lib/crypto.js";

export interface CheckoutSession {
  providerReference: string;
  checkoutUrl: string;
}

export interface WebhookEvent {
  id: string;
  type: "payment.captured" | "payment.failed" | "subscription.cancelled" | string;
  data: { provider_reference: string; amount_paise?: number };
}

/** Internal contract for an Indian payment gateway with subscription support. */
export interface PaymentProvider {
  readonly name: string;
  createCheckout(input: { amountPaise: number; currency: string; idempotencyKey: string; description: string }): Promise<CheckoutSession>;
  /** Verify the signature over the *raw* request body before trusting anything in it. */
  verifyWebhook(rawBody: Buffer, signature: string | undefined): WebhookEvent;
}

export class MockPaymentProvider implements PaymentProvider {
  readonly name = "mock";
  constructor(private webhookSecret: string) {}

  async createCheckout(input: { amountPaise: number; idempotencyKey: string }) {
    const providerReference = `mockpay_${randomUUID()}`;
    return { providerReference, checkoutUrl: `https://payments.example.invalid/checkout/${providerReference}?amount=${input.amountPaise}` };
  }

  verifyWebhook(rawBody: Buffer, signature: string | undefined): WebhookEvent {
    const expected = hmacSha256Hex(this.webhookSecret, rawBody);
    if (!signature || !safeEqualHex(expected, signature)) throw new Error("invalid webhook signature");
    return JSON.parse(rawBody.toString("utf8")) as WebhookEvent;
  }

  /** Test/dev helper: sign a payload the way the gateway would. */
  sign(rawBody: string) {
    return hmacSha256Hex(this.webhookSecret, rawBody);
  }
}

const providers: Record<string, PaymentProvider> = {
  mock: new MockPaymentProvider(env.PAYMENT_WEBHOOK_SECRET),
};

export function getPaymentProvider(name: string = env.PAYMENT_PROVIDER): PaymentProvider | undefined {
  return providers[name];
}
