import { useEffect, useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { ErrorNote, PageTitle } from "../components/ui";

interface Message {
  id: string;
  role: "student" | "assistant";
  content: string;
  source_refs: { ref: string; title: string; page: number | null; excerpt: string }[];
  safety_flags: string[];
  feedback?: number | null;
}

export function TutorPage() {
  const [params, setParams] = useSearchParams();
  const [sessionId, setSessionId] = useState<string | null>(params.get("session"));
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (sessionId) api(`/ai/sessions/${sessionId}`).then((r) => setMessages(r.messages)).catch(() => setSessionId(null));
  }, [sessionId]);
  useEffect(() => endRef.current?.scrollIntoView({ behavior: "smooth" }), [messages]);

  async function send(e: FormEvent) {
    e.preventDefault();
    const content = input.trim();
    if (!content) return;
    setBusy(true);
    setError(null);
    try {
      let sid = sessionId;
      if (!sid) {
        sid = (await api("/ai/sessions", { body: {} })).session.id as string;
        setSessionId(sid);
        setParams({ session: sid });
      }
      setMessages((m) => [...m, { id: `tmp-${Date.now()}`, role: "student", content, source_refs: [], safety_flags: [] }]);
      setInput("");
      const r = await api(`/ai/sessions/${sid}/messages`, { body: { content } });
      setMessages((m) => [...m, r.message]);
    } catch (err) {
      setError(err instanceof ApiError && err.code === "quota_exceeded" ? `${err.message}. Upgrade your plan for more questions.` : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function rate(m: Message, rating: 1 | -1) {
    await api(`/ai/messages/${m.id}/feedback`, { body: { rating } });
    setMessages((all) => all.map((x) => (x.id === m.id ? { ...x, feedback: rating } : x)));
  }

  return (
    <div className="flex h-[calc(100vh-8rem)] flex-col">
      <PageTitle
        icon="sparkles"
        title="AI Teacher"
        subtitle="Explanations grounded in your approved course material."
        action={
          <button className="btn-ghost" onClick={() => (setSessionId(null), setMessages([]), setParams({}))}>
            + New conversation
          </button>
        }
      />
      <div className="card flex-1 space-y-4 overflow-y-auto">
        {messages.length === 0 && (
          <div className="py-10 text-center text-sm text-slate-500">
            <p className="text-4xl">🧑‍🏫</p>
            <p className="mt-2">Ask anything from your syllabus — e.g. “Why does a knife have a sharp edge?”</p>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`flex ${m.role === "student" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm ${m.role === "student" ? "bg-brand text-white" : "bg-slate-100"}`}>
              <p className="whitespace-pre-wrap">{m.content}</p>
              {m.source_refs?.length > 0 && (
                <div className="mt-3 space-y-1 border-t border-slate-200 pt-2">
                  {m.source_refs.map((s) => (
                    <details key={s.ref} className="text-xs text-slate-600">
                      <summary className="cursor-pointer">
                        [{s.ref}] {s.title}
                        {s.page ? `, p.${s.page}` : ""}
                      </summary>
                      <p className="mt-1 italic">{s.excerpt}…</p>
                    </details>
                  ))}
                </div>
              )}
              {m.role === "assistant" && m.safety_flags.includes("ungrounded") && <p className="mt-2 text-xs text-amber-700">⚠ Not found in your course material — please verify with your textbook.</p>}
              {m.role === "assistant" && !m.id.startsWith("tmp") && (
                <div className="mt-2 flex gap-2 text-xs">
                  <button aria-label="Helpful" className={m.feedback === 1 ? "opacity-100" : "opacity-40 hover:opacity-100"} onClick={() => rate(m, 1)}>
                    👍
                  </button>
                  <button aria-label="Not helpful" className={m.feedback === -1 ? "opacity-100" : "opacity-40 hover:opacity-100"} onClick={() => rate(m, -1)}>
                    👎
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}
        {busy && <p className="text-sm text-slate-400">Thinking…</p>}
        <div ref={endRef} />
      </div>
      <ErrorNote message={error} />
      <form onSubmit={send} className="mt-3 flex gap-2">
        <input className="input" placeholder="Type your question…" value={input} onChange={(e) => setInput(e.target.value)} maxLength={2000} disabled={busy} />
        <button className="btn" disabled={busy || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
