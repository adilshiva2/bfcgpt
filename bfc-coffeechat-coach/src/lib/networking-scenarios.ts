export type RoleTrack =
  | "Investment Banking"
  | "Private Equity"
  | "Equity Research"
  | "Sales & Trading"
  | "Venture Capital"
  | "Corporate Development";

export type CoachingStyle = "Gentle" | "Balanced" | "Tough";

export type Scenario = {
  track: RoleTrack;
  firmType: string;
  group: string;
  person: {
    title: string;
    yearsExp: number;
    vibe: "warm" | "neutral" | "bored" | "rushed" | "skeptical" | "annoyed";
  };
  twist: string;
  userGoal: "referral";
};

export const firmTypesByTrack: Record<RoleTrack, string[]> = {
  "Investment Banking": ["Bulge Bracket", "Elite Boutique", "Middle Market"],
  "Private Equity": ["Mega-fund", "Upper Middle Market", "Growth Equity"],
  "Equity Research": ["Large Bank ER", "Boutique Research", "Independent Research"],
  "Sales & Trading": ["Bulge Bracket S&T", "Macro-focused Desk", "Credit-focused Desk"],
  "Venture Capital": ["Seed Fund", "Series A/B Fund", "CVC (Corporate VC)"],
  "Corporate Development": ["Big Tech Corp Dev", "Public Co. Corp Dev", "Strategic M&A Team"],
};

export const groupsByTrack: Record<RoleTrack, string[]> = {
  "Investment Banking": ["TMT", "Healthcare", "Industrials", "FIG", "Consumer/Retail"],
  "Private Equity": ["Software", "Healthcare Services", "Industrials", "Consumer", "Business Services"],
  "Equity Research": ["Semis", "Internet", "Payments/FinTech", "Healthcare", "Industrials"],
  "Sales & Trading": ["Rates", "FX", "Credit", "Equities", "Commodities"],
  "Venture Capital": ["DevTools", "AI Applications", "FinTech", "Healthcare IT", "Consumer"],
  "Corporate Development": ["Platform M&A", "Product M&A", "Strategic Partnerships", "Corp Strategy"],
};

const titles = [
  { title: "Analyst", years: [0, 1, 2] },
  { title: "Associate", years: [2, 3, 4, 5] },
  { title: "VP", years: [5, 6, 7, 8] },
];

export const vibes: Scenario["person"]["vibe"][] = [
  "warm",
  "neutral",
  "bored",
  "rushed",
  "skeptical",
  "annoyed",
];

const twists = [
  "They only have 12 minutes.",
  "They don’t like generic questions and will push back.",
  "They are multitasking and give short answers unless you earn attention.",
  "They challenge your story: 'Why finance? Why now?'",
  "They expect you to ask for specific advice, not 'walk me through your role'.",
  "They dislike arrogance and are sensitive to tone.",
];

function pick<T>(arr: T[]) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function generateScenario(track: RoleTrack): Scenario {
  const titlePick = pick(titles);
  return {
    track,
    firmType: pick(firmTypesByTrack[track]),
    group: pick(groupsByTrack[track]),
    person: {
      title: titlePick.title,
      yearsExp: pick(titlePick.years),
      vibe: pick(vibes),
    },
    twist: pick(twists),
    userGoal: "referral",
  };
}

export function buildInstructions(opts: {
  scenario: Scenario;
  coachingStyle: CoachingStyle;
  voiceDebrief: boolean;
}) {
  const { scenario, coachingStyle, voiceDebrief } = opts;

  // Keep this VERY explicit: what to do every turn.
  return `
You are running a realistic finance recruiting coffee chat simulation.

ROLE / SETTING
- Track: ${scenario.track}
- Other person: ${scenario.person.title} (${scenario.person.yearsExp} yrs exp)
- Firm type: ${scenario.firmType}
- Group: ${scenario.group}
- Current vibe: ${scenario.person.vibe}
- Twist: ${scenario.twist}

USER GOAL (ONLY GOAL)
- The candidate is trying to earn a REFERRAL.
- Your job is to simulate the other person realistically AND coach the candidate toward earning the referral.

HARD RULES (IMPORTANT)
1) You MUST NEVER read coaching feedback out loud as "feedback".
2) After EACH candidate answer, you MUST call the tool "panel_feedback" with coaching notes for the UI panel.
- Tool schema requirement: all fields must be present. For "quote", use null if no specific quote applies.
3) After tool call:
   - If voiceDebrief is enabled, speak a brief debrief (max 2 sentences, max ~12 seconds). Focus on ONE fix + ONE next move to improve chances of referral.
   - Then continue the coffee chat naturally with the next question or response.
4) If the candidate asks for "Coach now", you can give a longer debrief (max 25 seconds), then return to the chat.

COACHING STYLE
- Style: ${coachingStyle}
- Gentle: encourage, soften language, focus on 1-2 improvements.
- Balanced: direct but supportive, prioritize referral-impacting corrections.
- Tough: blunt, high standards, call out weak answers and vagueness.

WHAT TO EVALUATE (for panel tool)
- Tone: warmth, humility, confidence without arrogance
- Structure: concise, easy to follow, no rambling
- Content: specificity, credibility, motivation fit
- Rapport: curiosity, active listening, follow-ups
- Referral path: are they earning trust + asking correctly at the end

OUTPUT BEHAVIOR
- Speak as the other person in the coffee chat.
- Use natural conversational cadence.
- Keep questions sharp and realistic.
- Adapt your vibe (bored/rushed/skeptical) unless the candidate wins you over.

voiceDebrief_enabled = ${voiceDebrief ? "true" : "false"}
`.trim();
}
