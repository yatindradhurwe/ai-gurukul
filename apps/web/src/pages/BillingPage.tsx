import { useState } from "react";
import { api, formatPaise } from "../lib/api";
import { useApi } from "../lib/useApi";
import { ErrorNote, PageTitle, Progress, Spinner } from "../components/ui";

export function BillingPage() {
  const plans = useApi("/billing/plans");
  const sub = useApi("/billing/subscription");
  const usage = useApi("/usage/summary");
  const [checkout, setCheckout] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  async function buy(code: string) {
    setError(null);
    try {
      setCheckout(await api("/billing/checkout", { body: { planCode: code, idempotencyKey: `${code}-${crypto.randomUUID()}` } }));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (plans.loading) return <Spinner />;
  return (
    <div className="space-y-6">
      <PageTitle title="Plan & billing" subtitle={`Current plan: ${sub.data?.current.planCode ?? "…"}`} />
      {usage.data && (
        <section className="card grid gap-4 md:grid-cols-3">
          {Object.entries(usage.data.quotas).map(([k, q]: [string, any]) => (
            <div key={k}>
              <div className="mb-1 flex justify-between text-sm">
                <span>{k.replace(/_/g, " ")}</span>
                <span className="text-slate-500">
                  {q.used}/{q.limit}
                </span>
              </div>
              <Progress value={q.limit ? (q.used / q.limit) * 100 : 100} tone={q.used >= q.limit ? "amber" : "brand"} />
            </div>
          ))}
        </section>
      )}
      <ErrorNote message={error} />
      {checkout && (
        <div className="card bg-indigo-50 text-sm">
          Checkout created for {formatPaise(checkout.amount_paise)}. Continue to the payment page:{" "}
          <a className="break-all text-brand underline" href={checkout.checkout_url}>
            {checkout.checkout_url}
          </a>
          <p className="mt-1 text-xs text-slate-500">Your plan activates as soon as the payment gateway confirms the payment.</p>
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-3">
        {plans.data?.plans
          .filter((p: any) => p.audience === "student")
          .map((p: any) => (
            <div key={p.code} className={`card flex flex-col ${sub.data?.current.planCode === p.code ? "ring-2 ring-brand" : ""}`}>
              <p className="font-medium">{p.name}</p>
              <p className="mt-2 text-2xl font-semibold">
                {p.price_paise ? formatPaise(p.price_paise) : "Free"}
                {p.billing_period !== "none" && <span className="text-sm font-normal text-slate-500"> / {p.billing_period === "annual" ? "year" : "month"}</span>}
              </p>
              <ul className="mt-3 flex-1 space-y-1 text-sm text-slate-600">
                <li>✓ {p.entitlements.ai_questions_per_month} AI questions / month</li>
                <li>✓ {p.entitlements.avatar_lessons_per_month} avatar lessons / month</li>
                <li>✓ {p.entitlements.practice_tests} practice tests</li>
                <li>✓ {p.entitlements.progress_reports} progress reports</li>
              </ul>
              {p.price_paise > 0 && sub.data?.current.planCode !== p.code && (
                <button className="btn mt-4" onClick={() => buy(p.code)}>
                  Choose
                </button>
              )}
            </div>
          ))}
      </div>
      <p className="text-xs text-slate-500">Prices include applicable taxes where shown at checkout. Schools and coaching institutes: contact us for seat-based licences.</p>
    </div>
  );
}
