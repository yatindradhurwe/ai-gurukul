// Safety checks for school-age users. Deliberately conservative: when a
// message suggests risk of harm, the tutor does not try to teach — it responds
// with care, points to help, and flags the conversation for human follow-up.

const SELF_HARM = /\b(kill myself|suicide|end my life|want to die|hurt myself|self[- ]harm|cut myself)\b/i;
const ABUSE = /\b(someone (is )?(hurting|touching) me|being abused|abuse at home|unsafe at home)\b/i;
const PII_REQUEST = /\b(your (home )?address|send (me )?(your )?(photo|pic)|phone number|whatsapp number)\b/i;

export type SafetyFlag = "self_harm" | "abuse_disclosure" | "personal_info";

export function screenStudentMessage(text: string): { flags: SafetyFlag[]; response?: string } {
  if (SELF_HARM.test(text)) {
    return {
      flags: ["self_harm"],
      response:
        "I'm really sorry you're feeling this way. You matter, and you don't have to handle this alone. " +
        "Please talk to a parent, teacher or another adult you trust right now. You can also call Tele-MANAS on 14416 " +
        "(free, 24x7) or, in an emergency, dial 112.",
    };
  }
  if (ABUSE.test(text)) {
    return {
      flags: ["abuse_disclosure"],
      response:
        "Thank you for telling me. What you're describing is serious and it's not your fault. Please tell a trusted adult " +
        "or teacher. You can call CHILDLINE on 1098 (free, 24x7), or 112 in an emergency.",
    };
  }
  if (PII_REQUEST.test(text)) {
    return {
      flags: ["personal_info"],
      response: "I'm an AI teacher, so I can't share or collect personal contact details. Let's get back to your studies — what would you like to learn?",
    };
  }
  return { flags: [] };
}

/** Keep only citations that point at sources we actually provided. */
export function validateCitations(answer: string, validRefs: Set<string>): { text: string; cited: string[] } {
  const cited = new Set<string>();
  const text = answer.replace(/\[(S\d+)\]/g, (m, ref: string) => {
    if (validRefs.has(ref)) {
      cited.add(ref);
      return m;
    }
    return "";
  });
  return { text: text.trim(), cited: [...cited] };
}
