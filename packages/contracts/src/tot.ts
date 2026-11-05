import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, ThreadId, TotId, TrimmedNonEmptyString } from "./baseSchemas.ts";

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
  charter: TotCharter,
  reason: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
  proposedAt: IsoDateTime,
});
export type TotCharterProposal = typeof TotCharterProposal.Type;

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
});
export type TotUpdateInput = typeof TotUpdateInput.Type;

export const TotProposeCharterInput = Schema.Struct({
  charter: TotCharter.annotate({ description: "The complete new charter, not just the change." }),
  reason: TotCharterProposal.fields.reason.annotate({
    description: "One or two sentences on why, for the user deciding.",
  }),
});
export type TotProposeCharterInput = typeof TotProposeCharterInput.Type;

export const TotAnswerCharterProposalInput = Schema.Struct({
  id: TotId,
  /** Which proposal was on screen, so a newer one can't be approved unseen. */
  proposedAt: IsoDateTime,
  approve: Schema.Boolean,
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
