// Browser avatar voice: text-to-speech via the Web Speech API with a viseme
// (mouth-shape) track for lip-sync, and speech-to-text for spoken doubts.
// When speech synthesis is unavailable or muted, timing is simulated so the
// face, captions and lesson pacing still work.

export type MouthShape = "rest" | "closed" | "open" | "wide" | "round" | "teeth" | "mid";
export type AvatarState = "idle" | "speaking" | "listening" | "thinking";

const LANG_TAGS: Record<string, string> = { en: "en-IN", hi: "hi-IN", mr: "mr-IN", ta: "ta-IN", te: "te-IN", bn: "bn-IN", gu: "gu-IN", kn: "kn-IN" };
export const speechLang = (lang: string) => LANG_TAGS[lang] ?? "en-IN";

function shapeFor(ch: string): MouthShape {
  const c = ch.toLowerCase();
  if ("mbp".includes(c)) return "closed";
  if ("fv".includes(c)) return "teeth";
  if ("ouw".includes(c)) return "round";
  if ("ei".includes(c)) return "wide";
  if ("a".includes(c)) return "open";
  if (/[a-zऀ-ॿ]/.test(c)) return "mid";
  return "rest";
}

/** Approximate mouth shapes for a word, one per letter cluster. */
export function visemesFor(word: string): MouthShape[] {
  const shapes: MouthShape[] = [];
  for (const ch of word.replace(/[^\p{L}]/gu, "")) {
    const s = shapeFor(ch);
    if (shapes.at(-1) !== s) shapes.push(s);
  }
  return shapes.length ? shapes : ["mid"];
}

export interface SpeakItem {
  text: string;
  kind: "segment" | "answer" | "teacher";
}

interface Callbacks {
  onShape: (s: MouthShape) => void;
  onState: (s: AvatarState) => void;
  onCaption: (text: string | null) => void;
}

export class AvatarVoice {
  muted = false;
  private queue: (SpeakItem & { resolve: (finished: boolean) => void })[] = [];
  private current: (SpeakItem & { resolve: (finished: boolean) => void }) | null = null;
  private timers: number[] = [];
  private token = 0;
  private voice: SpeechSynthesisVoice | null = null;
  readonly synthAvailable = typeof window !== "undefined" && "speechSynthesis" in window;

  constructor(private lang: string, private cb: Callbacks) {
    if (this.synthAvailable) {
      const pick = () => {
        const tag = speechLang(lang);
        const voices = window.speechSynthesis.getVoices();
        this.voice = voices.find((v) => v.lang === tag) ?? voices.find((v) => v.lang.startsWith(tag.slice(0, 2))) ?? null;
      };
      pick();
      window.speechSynthesis.onvoiceschanged = pick;
    }
  }

  get speakingKind() {
    return this.current?.kind ?? null;
  }

  /** Speak now (interrupting whatever is playing) or after the queue. Resolves true if spoken to the end. */
  speak(item: SpeakItem, opts: { interrupt?: boolean } = {}): Promise<boolean> {
    return new Promise((resolve) => {
      if (opts.interrupt) this.stop();
      this.queue.push({ ...item, resolve });
      if (!this.current) this.next();
    });
  }

  /** Stop everything; pending promises resolve false (interrupted). */
  stop() {
    this.token++;
    this.timers.forEach((t) => clearTimeout(t));
    this.timers = [];
    if (this.synthAvailable) window.speechSynthesis.cancel();
    const pending = [...(this.current ? [this.current] : []), ...this.queue];
    this.current = null;
    this.queue = [];
    pending.forEach((p) => p.resolve(false));
    this.cb.onShape("rest");
    this.cb.onState("idle");
    this.cb.onCaption(null);
  }

  private next() {
    const item = this.queue.shift();
    if (!item) {
      this.current = null;
      this.cb.onState("idle");
      this.cb.onShape("rest");
      this.cb.onCaption(null);
      return;
    }
    this.current = item;
    const token = this.token;
    const sentences = item.text.match(/[^.!?।]+[.!?।]*\s*/g)?.map((s) => s.trim()).filter(Boolean) ?? [item.text];
    this.cb.onState("speaking");
    const run = async () => {
      for (const sentence of sentences) {
        if (token !== this.token) return;
        this.cb.onCaption(sentence);
        const ok = await this.speakSentence(sentence, token);
        if (!ok || token !== this.token) return;
      }
      if (token !== this.token) return;
      item.resolve(true);
      this.next();
    };
    run();
  }

  /** One sentence per utterance: Chrome cuts off long utterances. */
  private speakSentence(sentence: string, token: number): Promise<boolean> {
    const words = sentence.split(/\s+/).filter(Boolean);
    const wordMs = 400; // ~150 words per minute
    return new Promise((resolve) => {
      if (!this.synthAvailable || this.muted) {
        // Silent mode: animate the mouth on an estimated timeline.
        words.forEach((w, i) => this.timers.push(window.setTimeout(() => token === this.token && this.animateWord(w, wordMs), i * wordMs)));
        this.timers.push(window.setTimeout(() => resolve(token === this.token), words.length * wordMs + 250));
        return;
      }
      const u = new SpeechSynthesisUtterance(sentence);
      u.lang = speechLang(this.lang);
      if (this.voice) u.voice = this.voice;
      u.rate = 0.95;
      let sawBoundary = false;
      let fallback: number | undefined;
      u.onstart = () => {
        // Voices without word-boundary events still get a generic talking motion.
        fallback = window.setInterval(() => {
          if (!sawBoundary && token === this.token) this.cb.onShape((["open", "mid", "wide", "round", "closed"] as MouthShape[])[Math.floor(Math.random() * 5)]);
        }, 130);
      };
      u.onboundary = (e) => {
        if (e.name && e.name !== "word") return;
        sawBoundary = true;
        const word = sentence.slice(e.charIndex).match(/^[^\s]+/)?.[0] ?? "";
        this.animateWord(word, Math.max(180, word.length * 70));
      };
      let settled = false;
      let started = false;
      const begunAt = Date.now();
      const estimatedMs = words.length * wordMs;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearInterval(fallback);
        clearTimeout(startWatchdog);
        clearTimeout(endWatchdog);
        this.cb.onShape("rest");
        if (!ok || token !== this.token) return resolve(false);
        // An engine that "finishes" implausibly fast didn't really speak (no audio device,
        // failed voice): keep the captions up for the remaining estimated time.
        const remaining = estimatedMs * 0.6 - (Date.now() - begunAt);
        if (remaining > 0) this.timers.push(window.setTimeout(() => resolve(token === this.token), remaining));
        else resolve(true);
      };
      u.onend = () => done(true);
      // A synthesis failure is not an interruption: treat it like an instant end (timed fallback above).
      u.onerror = (e) => done(e.error !== "interrupted" && e.error !== "canceled");
      const origStart = u.onstart;
      u.onstart = (ev) => {
        started = true;
        origStart?.call(u, ev);
      };
      // Some browsers/voices never start or never report the end: fall back to silent timing.
      const startWatchdog = window.setTimeout(() => {
        if (started || settled) return;
        window.speechSynthesis.cancel();
        settled = true;
        clearInterval(fallback);
        clearTimeout(endWatchdog);
        words.forEach((w, i) => this.timers.push(window.setTimeout(() => token === this.token && this.animateWord(w, wordMs), i * wordMs)));
        this.timers.push(window.setTimeout(() => resolve(token === this.token), words.length * wordMs + 250));
      }, 2000);
      const endWatchdog = window.setTimeout(() => done(true), words.length * wordMs * 2.5 + 4000);
      window.speechSynthesis.speak(u);
    });
  }

  private animateWord(word: string, durationMs: number) {
    const shapes = visemesFor(word);
    const step = durationMs / (shapes.length + 1);
    const token = this.token;
    shapes.forEach((s, i) => this.timers.push(window.setTimeout(() => token === this.token && this.cb.onShape(s), i * step)));
    this.timers.push(window.setTimeout(() => token === this.token && this.cb.onShape("rest"), shapes.length * step));
  }
}

// --- Speech recognition (student's spoken doubts) ---------------------------

type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: any) => void) | null;
  onerror: ((e: any) => void) | null;
  onend: (() => void) | null;
};

export const recognitionSupported = () => typeof window !== "undefined" && !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);

export function listen(lang: string, handlers: { onInterim: (t: string) => void; onFinal: (t: string) => void; onError: (msg: string) => void; onEnd: () => void }) {
  const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  if (!Ctor) {
    handlers.onError("Voice input isn't supported in this browser — please type your doubt.");
    handlers.onEnd();
    return () => {};
  }
  const rec: Recognition = new Ctor();
  rec.lang = speechLang(lang);
  rec.interimResults = true;
  rec.continuous = false;
  let finalText = "";
  rec.onresult = (e: any) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    handlers.onInterim((finalText + interim).trim());
  };
  rec.onerror = (e: any) => handlers.onError(e.error === "not-allowed" ? "Microphone permission was denied." : `Voice input error: ${e.error}`);
  rec.onend = () => {
    if (finalText.trim()) handlers.onFinal(finalText.trim());
    handlers.onEnd();
  };
  rec.start();
  return () => rec.stop();
}
