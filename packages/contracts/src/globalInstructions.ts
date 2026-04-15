import { Effect, Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const GlobalInstruction = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  content: TrimmedNonEmptyString,
  filePath: Schema.optional(TrimmedNonEmptyString),
});
export type GlobalInstruction = typeof GlobalInstruction.Type;

const GlobalInstructionMalformedConfigIssue = Schema.Struct({
  kind: Schema.Literal("globalInstructions.malformed-config"),
  id: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
});

const GlobalInstructionInvalidConfigIssue = Schema.Struct({
  kind: Schema.Literal("globalInstructions.invalid-config"),
  id: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
});

export const GlobalInstructionIssue = Schema.Union([
  GlobalInstructionMalformedConfigIssue,
  GlobalInstructionInvalidConfigIssue,
]);
export type GlobalInstructionIssue = typeof GlobalInstructionIssue.Type;

export const GlobalInstructionsState = Schema.Struct({
  globalInstructions: Schema.Array(GlobalInstruction).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  globalInstructionIssues: Schema.Array(GlobalInstructionIssue).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type GlobalInstructionsState = typeof GlobalInstructionsState.Type;

export const CreateGlobalInstructionInput = Schema.Struct({
  name: TrimmedNonEmptyString,
  content: TrimmedNonEmptyString,
});
export type CreateGlobalInstructionInput = typeof CreateGlobalInstructionInput.Type;

export const SetGlobalInstructionEnabledInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
});
export type SetGlobalInstructionEnabledInput = typeof SetGlobalInstructionEnabledInput.Type;

export class GlobalInstructionsConfigError extends Schema.TaggedErrorClass<GlobalInstructionsConfigError>()(
  "GlobalInstructionsConfigError",
  {
    configPath: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Global instructions error at ${this.configPath}: ${this.detail}`;
  }
}
