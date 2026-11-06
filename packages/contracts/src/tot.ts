import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ScheduledTaskId,
  ThreadId,
  TotId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderApprovalDecision } from "./providerPolicy.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/** Project managers delegate the work; hands-on Tots do it themselves. */
export const TotJob = Schema.Literals(["manager", "hands_on"]);
export type TotJob = typeof TotJob.Type;

const TotName = TrimmedNonEmptyString.check(Schema.isMaxLength(40));

/** Open on purpose: clients fall back for art they don't have, so new art needs no contract change. */
const TotCharacterId = TrimmedNonEmptyString.check(Schema.isMaxLength(64));

/** Applies to the app's words and how the Tot writes to the user, never to commits or PRs. */
export const TotVoice = Schema.Literals(["toddler", "polite", "grown_up"]);
export type TotVoice = typeof TotVoice.Type;

/** Sent on every turn, so its size is a standing cost to the Tot's context. */
export const TOT_CHARTER_MAX_LENGTH = 8000;
const TotCharter = Schema.String.check(Schema.isMaxLength(TOT_CHARTER_MAX_LENGTH));

/** A Tot's proposed replacement for its whole charter, until the user answers it. */
export const TotCharterProposal = Schema.Struct({
  /** Which proposal was on screen when the user answered, so a newer one can't be approved unseen. */
  id: TrimmedNonEmptyString,
  charter: TotCharter,
  reason: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
  proposedAt: IsoDateTime,
});
export type TotCharterProposal = typeof TotCharterProposal.Type;

const TotClockTime = Schema.String.check(Schema.isPattern(/^([01]\d|2[0-3]):[0-5]\d$/));

/** On the Tot's machine's clock. The window can cross midnight; equal times mean no window. */
export const TotQuietHours = Schema.Struct({ start: TotClockTime, end: TotClockTime });
export type TotQuietHours = typeof TotQuietHours.Type;

/** A plain command run before a schedule wakes the Tot: exit 1 skips the wake. */
export const TotWakeCheck = Schema.Struct({
  scheduledTaskId: ScheduledTaskId,
  command: TrimmedNonEmptyString.check(Schema.isMaxLength(2000)),
});
export type TotWakeCheck = typeof TotWakeCheck.Type;

export const TotWakeSettings = Schema.Struct({
  quietHours: Schema.NullOr(TotQuietHours),
  /** Scheduled wakes a day. Anything over the limit waits for the next day. */
  dailyWakeLimit: Schema.NullOr(PositiveInt),
  wakeChecks: Schema.Array(TotWakeCheck).check(Schema.isMaxLength(64)),
});
export type TotWakeSettings = typeof TotWakeSettings.Type;

export const EMPTY_TOT_WAKE_SETTINGS: TotWakeSettings = {
  quietHours: null,
  dailyWakeLimit: null,
  wakeChecks: [],
};

/** Which model a Tot should give each kind of crew work. Told to the Tot, not enforced. */
export const TotCrewModel = Schema.Struct({
  role: TrimmedNonEmptyString.check(Schema.isMaxLength(60)),
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
});
export type TotCrewModel = typeof TotCrewModel.Type;

const TotCrewModels = Schema.Array(TotCrewModel).check(Schema.isMaxLength(12));

export const TOT_MAX_OPEN_REQUESTS = 8;
const TotRequestOptionLabel = TrimmedNonEmptyString.check(Schema.isMaxLength(80));

/** Something a Tot needs from the user. It stays open until answered, dismissed or closed. */
export const TotRequest = Schema.Struct({
  id: TrimmedNonEmptyString,
  question: TrimmedNonEmptyString.check(Schema.isMaxLength(300)),
  summary: Schema.String.check(Schema.isMaxLength(1000)),
  details: Schema.String.check(Schema.isMaxLength(TOT_CHARTER_MAX_LENGTH)),
  options: Schema.Array(TotRequestOptionLabel).check(Schema.isMaxLength(6)),
  recommendedOption: Schema.NullOr(TotRequestOptionLabel),
  blocks: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
  askedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type TotRequest = typeof TotRequest.Type;

/** A lasting identity wrapped around one thread. */
export const Tot = Schema.Struct({
  id: TotId,
  threadId: ThreadId,
  /** Read from the thread, which clients can't always see: old settled threads load on demand. */
  projectId: ProjectId,
  name: TotName,
  /** When off, the Tot goes by its project's name. The chosen name is kept for turning it back on. */
  nameEnabled: Schema.Boolean,
  character: TotCharacterId,
  job: TotJob,
  // Defaults: servers and cached lists from before charters have none of these.
  charter: TotCharter.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
  voice: TotVoice.pipe(Schema.withDecodingDefaultKey(Effect.succeed("toddler" as const))),
  charterProposal: Schema.NullOr(TotCharterProposal).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  wakeSettings: TotWakeSettings.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(EMPTY_TOT_WAKE_SETTINGS)),
  ),
  crewModels: TotCrewModels.pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  wakesHeld: NonNegativeInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  requests: Schema.Array(TotRequest).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  watchedThreadIds: Schema.Array(ThreadId).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Tot = typeof Tot.Type;

export const TotListInput = Schema.Struct({});
export type TotListInput = typeof TotListInput.Type;

export const TotListResult = Schema.Struct({
  tots: Schema.Array(Tot),
});
export type TotListResult = typeof TotListResult.Type;

export const TotAdoptInput = Schema.Struct({
  threadId: ThreadId,
  name: TotName,
  nameEnabled: Schema.Boolean,
  character: TotCharacterId,
  job: TotJob,
  charter: Schema.optionalKey(TotCharter),
  voice: Schema.optionalKey(TotVoice),
});
export type TotAdoptInput = typeof TotAdoptInput.Type;

export const TotUpdateInput = Schema.Struct({
  id: TotId,
  name: Schema.optionalKey(TotName),
  nameEnabled: Schema.optionalKey(Schema.Boolean),
  character: Schema.optionalKey(TotCharacterId),
  job: Schema.optionalKey(TotJob),
  charter: Schema.optionalKey(TotCharter),
  voice: Schema.optionalKey(TotVoice),
  wakeSettings: Schema.optionalKey(TotWakeSettings),
  crewModels: Schema.optionalKey(TotCrewModels),
  unwatchThreadIds: Schema.optionalKey(Schema.Array(ThreadId)),
});
export type TotUpdateInput = typeof TotUpdateInput.Type;

export const TotProposeCharterInput = Schema.Struct({
  charter: TotCharter.annotate({ description: "The complete new charter, not just the change." }),
  reason: TotCharterProposal.fields.reason.annotate({
    description: "One or two sentences on why, for the user deciding.",
  }),
});
export type TotProposeCharterInput = typeof TotProposeCharterInput.Type;

export const TotAskUserInput = Schema.Struct({
  requestId: Schema.optional(TrimmedNonEmptyString).annotate({
    description: "One of your open requests, to replace it instead of asking something new.",
  }),
  question: TotRequest.fields.question.annotate({
    description: "What you need from the user, in a sentence they can read on its own.",
  }),
  summary: Schema.optional(TotRequest.fields.summary).annotate({
    description: "What you found and what you recommend, in two or three sentences.",
  }),
  details: Schema.optional(TotRequest.fields.details).annotate({
    description: "Your research, as Markdown. Hidden until the user asks for it.",
  }),
  options: Schema.optional(TotRequest.fields.options).annotate({
    description:
      "Short answers the user can pick with one click. They can always write their own. Mark your pick with `recommendedOption`, not in the label.",
  }),
  recommendedOption: Schema.optional(TotRequestOptionLabel).annotate({
    description: "The option you recommend, spelled exactly as in `options`.",
  }),
  blocks: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))).annotate({
    description: "What can't move until this is answered.",
  }),
});
export type TotAskUserInput = typeof TotAskUserInput.Type;

export const TotCloseRequestInput = Schema.Struct({
  requestId: TrimmedNonEmptyString,
});
export type TotCloseRequestInput = typeof TotCloseRequestInput.Type;

export const TotAnswerRequestInput = Schema.Struct({
  id: TotId,
  requestId: TrimmedNonEmptyString,
  /** Null when the user dismisses the request without answering it. */
  answer: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(TOT_CHARTER_MAX_LENGTH))),
});
export type TotAnswerRequestInput = typeof TotAnswerRequestInput.Type;

export const TotWatchInput = Schema.Struct({
  action: Schema.Literals(["watch", "unwatch"]),
  threadId: ThreadId,
});
export type TotWatchInput = typeof TotWatchInput.Type;

export const TotCrewApprovalInput = Schema.Struct({
  action: Schema.Literals(["list", "read", "respond"]),
  threadId: ThreadId,
  requestId: Schema.optional(TrimmedNonEmptyString),
  decision: Schema.optional(ProviderApprovalDecision),
});
export type TotCrewApprovalInput = typeof TotCrewApprovalInput.Type;

export const TotAnswerCharterProposalInput = Schema.Struct({
  id: TotId,
  proposalId: TrimmedNonEmptyString,
  approve: Schema.Boolean,
  /** The user's edit of the proposal, to approve instead of what the Tot wrote. */
  charter: Schema.optionalKey(TotCharter),
});
export type TotAnswerCharterProposalInput = typeof TotAnswerCharterProposalInput.Type;

export const TotMutationResult = Schema.Struct({
  tot: Tot,
});
export type TotMutationResult = typeof TotMutationResult.Type;

export const TotReleaseInput = Schema.Struct({
  id: TotId,
});
export type TotReleaseInput = typeof TotReleaseInput.Type;

export const TotReleaseResult = Schema.Struct({
  id: TotId,
});
export type TotReleaseResult = typeof TotReleaseResult.Type;

export class TotError extends Schema.TaggedError<TotError>()("TotError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}
