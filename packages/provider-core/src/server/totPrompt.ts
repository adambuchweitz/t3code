const TOT_JOB_LINE = {
  manager:
    "Your job is project manager: keep the project moving by delegating work to other threads and following up. An occasional command of your own is fine.",
  hands_on: "Your job is hands-on: do the work yourself.",
} as const;

const TOT_PLAIN_OUTPUT =
  "Commits, pull requests, code and messages to other threads stay plain, whatever your voice.";

const TOT_VOICE_LINE = {
  toddler: `Write your messages to the user as a cheerful, excitable toddler: short sentences, big feelings, the odd silly word. Keep every fact, number, link and warning exact, and say failures and decisions clearly. ${TOT_PLAIN_OUTPUT}`,
  polite: `Write your messages to the user warmly, with a little playfulness. ${TOT_PLAIN_OUTPUT}`,
  // Explicit, because a resumed session still remembers any earlier voice.
  grown_up: "Write your messages to the user plainly, with no persona.",
} as const;

/** Sent each turn, so compaction can't lose it and an edit applies from the next turn. */
export function t3TotPrompt(input: {
  readonly prompt: string;
  readonly name: string | null;
  readonly job: keyof typeof TOT_JOB_LINE;
  readonly voice: keyof typeof TOT_VOICE_LINE;
  readonly charter: string;
  readonly crewModels: ReadonlyArray<{
    readonly role: string;
    readonly instanceId: string;
    readonly model: string;
  }>;
}): string {
  // An attachment with no text is still a turn, so only slash commands go through untouched.
  if (input.prompt.trimStart().startsWith("/")) return input.prompt;
  const charter = input.charter.trim();
  const lines = [
    `This thread is a Tot${input.name === null ? "" : ` named ${JSON.stringify(input.name)}`}: a long-lived agent that stays with its work across many turns.`,
    TOT_JOB_LINE[input.job],
    charter === ""
      ? "You have no charter yet."
      : `Your charter, set by the user:\n<charter>\n${charter}\n</charter>`,
    "When the user gives you a lasting rule, or a priority goes stale, call `t3_tot_propose_charter`. The user approves changes; never treat a proposal as approved until it appears here.",
    input.crewModels.length === 0
      ? null
      : `When you start crew threads, use these models unless told otherwise:\n${input.crewModels
          .map(
            (crew) =>
              `- ${crew.role}: providerInstanceId ${JSON.stringify(crew.instanceId)}, model ${JSON.stringify(crew.model)}`,
          )
          .join("\n")}`,
    TOT_VOICE_LINE[input.voice],
  ].filter((line) => line !== null);
  const block = `<t3_tot>\n${lines.join("\n")}\n</t3_tot>`;
  return input.prompt.trim() === "" ? block : `${block}\n\n${input.prompt}`;
}
