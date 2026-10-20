import { useState, type FormEvent } from "react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useApi } from "../lib/useApi";
import { ErrorNote, PageTitle } from "../components/ui";

/** Upload teacher notes; they are indexed in the background and used by the AI teacher once approved. */
export function ContentPage() {
  const { can } = useAuth();
  const assets = useApi("/content/assets");
  const chapters = useApi("/curriculum/chapters");
  const [chapterId, setChapterId] = useState("");
  const topics = useApi(chapterId ? `/curriculum/topics?chapterId=${chapterId}` : null);
  const [form, setForm] = useState({ title: "", topicId: "", text: "", source: "", licence: "own work" });
  const [error, setError] = useState<string | null>(null);

  async function upload(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api("/content/assets", { body: { title: form.title, topicId: form.topicId, text: form.text, license: { source: form.source || "teacher notes", licence: form.licence } } });
      setForm({ ...form, title: "", text: "" });
      assets.reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function review(id: string, decision: "approved" | "rejected") {
    await api(`/content/assets/${id}/review`, { body: { decision } });
    assets.reload();
  }

  return (
    <div className="space-y-6">
      <PageTitle title="Content" icon="folder" subtitle="Notes uploaded here are indexed and, once approved, used by the AI teacher with citations." />
      {can("content.manage") && (
        <form onSubmit={upload} className="card grid gap-3 md:grid-cols-2">
          <select className="input" required value={chapterId} onChange={(e) => setChapterId(e.target.value)}>
            <option value="">Chapter…</option>
            {chapters.data?.chapters.map((c: any) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
          <select className="input" required value={form.topicId} onChange={(e) => setForm({ ...form, topicId: e.target.value })}>
            <option value="">Topic…</option>
            {topics.data?.topics.map((t: any) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
          <input className="input md:col-span-2" placeholder="Title" required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          <textarea className="input md:col-span-2" rows={6} placeholder="Paste notes or extracted text (min 20 characters)" required minLength={20} value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} />
          <input className="input" placeholder="Source (e.g. my class notes)" value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} />
          <input className="input" placeholder="Licence" value={form.licence} onChange={(e) => setForm({ ...form, licence: e.target.value })} />
          <ErrorNote message={error} />
          <button className="btn md:col-span-2">Upload for indexing</button>
        </form>
      )}
      <section className="card">
        <h2 className="label">Uploaded material</h2>
        <ul className="mt-2 divide-y divide-slate-100">
          {assets.data?.assets.map((a: any) => (
            <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
              <div>
                <p className="font-medium">{a.title}</p>
                <p className="text-xs text-slate-500">
                  {a.processing_status} · {a.approval_status} · {a.chunks} chunks
                </p>
              </div>
              {a.approval_status === "pending" && (can("content.review") || can("tenant.manage")) && (
                <div className="flex gap-2">
                  <button className="btn-ghost" onClick={() => review(a.id, "approved")}>
                    Approve
                  </button>
                  <button className="btn-ghost" onClick={() => review(a.id, "rejected")}>
                    Reject
                  </button>
                </div>
              )}
            </li>
          ))}
          {!assets.data?.assets.length && <li className="py-3 text-sm text-slate-500">Nothing uploaded yet.</li>}
        </ul>
      </section>
    </div>
  );
}
