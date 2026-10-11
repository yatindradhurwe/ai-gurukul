import type { AvatarState, MouthShape } from "../lib/avatarVoice";

// Mouth paths centred at (100, 148), one per viseme.
const MOUTHS: Record<MouthShape, { outer: string; inner?: string; teeth?: boolean }> = {
  rest: { outer: "M84 148 Q100 156 116 148 Q100 152 84 148 Z" },
  closed: { outer: "M84 148 Q100 150 116 148 Q100 151 84 148 Z" },
  mid: { outer: "M86 146 Q100 143 114 146 Q112 157 100 158 Q88 157 86 146 Z", inner: "M90 148 Q100 147 110 148 Q108 154 100 155 Q92 154 90 148 Z" },
  open: { outer: "M85 144 Q100 140 115 144 Q114 166 100 168 Q86 166 85 144 Z", inner: "M89 147 Q100 145 111 147 Q109 162 100 164 Q91 162 89 147 Z" },
  wide: { outer: "M80 146 Q100 141 120 146 Q114 156 100 157 Q86 156 80 146 Z", inner: "M85 147 Q100 145 115 147 Q110 152 100 153 Q90 152 85 147 Z", teeth: true },
  round: { outer: "M91 143 Q100 139 109 143 Q112 152 100 160 Q88 152 91 143 Z", inner: "M94 146 Q100 144 106 146 Q107 152 100 156 Q93 152 94 146 Z" },
  teeth: { outer: "M84 146 Q100 142 116 146 Q113 153 100 154 Q87 153 84 146 Z", inner: "M88 147 Q100 145 112 147 Q110 150 100 151 Q90 150 88 147 Z", teeth: true },
};

/**
 * The browser-rendered AI teacher. Mouth shapes come from the speech engine's
 * viseme track; eyes blink on their own; brows and a glow reflect state.
 */
export function AvatarFace({ shape, state, size = 260 }: { shape: MouthShape; state: AvatarState; size?: number }) {
  const m = MOUTHS[shape];
  const browLift = state === "listening" ? -5 : state === "thinking" ? -2 : 0;
  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <div
        className={`absolute inset-3 rounded-full transition-all duration-300 ${
          state === "speaking" ? "bg-indigo-300/50 blur-2xl" : state === "listening" ? "bg-emerald-300/60 blur-2xl" : state === "thinking" ? "bg-amber-200/60 blur-2xl" : "bg-transparent"
        }`}
      />
      <svg viewBox="0 0 200 220" width={size} height={size} className="relative" role="img" aria-label={`AI teacher is ${state}`}>
        <style>{`
          .ag-eye { animation: ag-blink 4.5s infinite; transform-origin: center; transform-box: fill-box; }
          @keyframes ag-blink { 0%, 94%, 100% { transform: scaleY(1); } 96% { transform: scaleY(0.1); } }
          .ag-head { animation: ag-sway 6s ease-in-out infinite; transform-origin: 100px 200px; }
          @keyframes ag-sway { 0%,100% { transform: rotate(0deg); } 50% { transform: rotate(1.2deg); } }
          .ag-mouth path { transition: d 70ms linear; }
        `}</style>
        {/* shoulders */}
        <path d="M30 220 Q40 176 100 172 Q160 176 170 220 Z" fill="#4f46e5" />
        <path d="M84 174 L100 196 L116 174" fill="#eef2ff" />
        <g className="ag-head">
          {/* neck */}
          <rect x="88" y="150" width="24" height="30" rx="8" fill="#c98a5e" />
          {/* hair back */}
          <ellipse cx="100" cy="92" rx="66" ry="70" fill="#2b1d16" />
          {/* face */}
          <ellipse cx="100" cy="112" rx="54" ry="62" fill="#e0a77c" />
          {/* ears */}
          <ellipse cx="46" cy="114" rx="8" ry="13" fill="#d69a6d" />
          <ellipse cx="154" cy="114" rx="8" ry="13" fill="#d69a6d" />
          {/* hair front */}
          <path d="M46 96 Q52 44 100 42 Q150 44 156 96 Q140 66 100 64 Q66 66 46 96 Z" fill="#2b1d16" />
          {/* brows */}
          <g style={{ transform: `translateY(${browLift}px)`, transition: "transform 200ms" }}>
            <path d="M68 92 Q78 86 90 91" stroke="#2b1d16" strokeWidth="4" fill="none" strokeLinecap="round" />
            <path d="M110 91 Q122 86 132 92" stroke="#2b1d16" strokeWidth="4" fill="none" strokeLinecap="round" />
          </g>
          {/* eyes */}
          <g className="ag-eye">
            <ellipse cx="79" cy="107" rx="8" ry="9" fill="#fff" />
            <circle cx="80" cy="108" r="4.5" fill="#3b2a20" />
            <circle cx="81.5" cy="106.5" r="1.3" fill="#fff" />
          </g>
          <g className="ag-eye">
            <ellipse cx="121" cy="107" rx="8" ry="9" fill="#fff" />
            <circle cx="122" cy="108" r="4.5" fill="#3b2a20" />
            <circle cx="123.5" cy="106.5" r="1.3" fill="#fff" />
          </g>
          {/* glasses */}
          <g stroke="#1f2937" strokeWidth="2.2" fill="none" opacity="0.85">
            <rect x="65" y="96" width="29" height="23" rx="9" />
            <rect x="106" y="96" width="29" height="23" rx="9" />
            <path d="M94 105 Q100 101 106 105" />
          </g>
          {/* bindi + nose */}
          <circle cx="100" cy="86" r="2.6" fill="#b91c1c" />
          <path d="M100 112 Q96 128 101 131" stroke="#b77b52" strokeWidth="2.5" fill="none" strokeLinecap="round" />
          {/* cheeks */}
          <ellipse cx="72" cy="132" rx="8" ry="5" fill="#e78f7a" opacity="0.35" />
          <ellipse cx="128" cy="132" rx="8" ry="5" fill="#e78f7a" opacity="0.35" />
          {/* mouth */}
          <g className="ag-mouth">
            <path d={m.outer} fill="#9f3a38" />
            {m.inner && <path d={m.inner} fill="#4a1414" />}
            {m.teeth && <rect x="90" y="146" width="20" height="3.5" rx="1.5" fill="#fff" />}
          </g>
        </g>
      </svg>
      {state === "listening" && <span className="absolute bottom-2 right-6 animate-pulse rounded-full bg-emerald-500 px-2 py-0.5 text-xs text-white">listening</span>}
      {state === "thinking" && <span className="absolute bottom-2 right-6 rounded-full bg-amber-500 px-2 py-0.5 text-xs text-white">thinking…</span>}
    </div>
  );
}
