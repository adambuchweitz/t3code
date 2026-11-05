import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, ThreadId, TotId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Project managers delegate the work; hands-on Tots do it themselves. */
export const TotJob = Schema.Literals(["manager", "hands_on"]);
export type TotJob = typeof TotJob.Type;

const TotName = TrimmedNonEmptyString.check(Schema.isMaxLength(40));

/** Open on purpose: clients fall back for art they don't have, so new art needs no contract change. */
const TotCharacterId = TrimmedNonEmptyString.check(Schema.isMaxLength(64));

/** A lasting identity wrapped around one thread. The thread itself is unchanged. */
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
});
export type TotAdoptInput = typeof TotAdoptInput.Type;

export const TotUpdateInput = Schema.Struct({
  id: TotId,
  name: Schema.optionalKey(TotName),
  nameEnabled: Schema.optionalKey(Schema.Boolean),
  character: Schema.optionalKey(TotCharacterId),
  job: Schema.optionalKey(TotJob),
});
export type TotUpdateInput = typeof TotUpdateInput.Type;

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
