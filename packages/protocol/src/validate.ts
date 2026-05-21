/**
 * Ajv validator for V1 routine specs. Single source of truth: the JSON
 * Schemas under `./schemas/`. The visual builder (Phase 3) reads the same
 * files to drive per-step form rendering.
 *
 * Schemas are registered with Ajv by their `$id` (e.g.
 * `omp-deck/schemas/step-common.json`), and the root `routine-spec.json`
 * `$ref`-resolves against that namespace.
 */

import Ajv2020, { type ErrorObject } from "ajv/dist/2020";
import addFormats from "ajv-formats";

import routineSpecSchema from "./schemas/routine-spec.json";
import stepAgentSchema from "./schemas/step-agent.json";
import stepCommonSchema from "./schemas/step-common.json";
import stepDeckSchema from "./schemas/step-deck.json";
import stepHttpSchema from "./schemas/step-http.json";
import stepMcpSchema from "./schemas/step-mcp.json";
import stepRunSchema from "./schemas/step-run.json";
import stepSetStateSchema from "./schemas/step-set_state.json";
import stepTransformSchema from "./schemas/step-transform.json";
import stepWaitSchema from "./schemas/step-wait.json";
import stepWriteSchema from "./schemas/step-write.json";
import triggerCronSchema from "./schemas/trigger-cron.json";
import triggerEventSchema from "./schemas/trigger-event.json";
import triggerManualSchema from "./schemas/trigger-manual.json";
import triggerWebhookSchema from "./schemas/trigger-webhook.json";

export interface ValidationError {
	/** JSON Pointer to the offending node (Ajv's `instancePath`). */
	path: string;
	/** Ajv's keyword that triggered (e.g. "required", "enum", "type"). */
	keyword: string;
	/** Human-readable message. */
	message: string;
	/** Schema-side context (e.g. {missingProperty: "id"} for required-keyword errors). */
	params: Record<string, unknown>;
}

export interface ValidationResult {
	valid: boolean;
	errors?: ValidationError[];
}

const SUB_SCHEMAS = [
	stepCommonSchema,
	stepRunSchema,
	stepAgentSchema,
	stepWriteSchema,
	stepHttpSchema,
	stepDeckSchema,
	stepMcpSchema,
	stepTransformSchema,
	stepWaitSchema,
	stepSetStateSchema,
	triggerCronSchema,
	triggerWebhookSchema,
	triggerManualSchema,
	triggerEventSchema,
] as const;

let cachedValidator: ((spec: unknown) => boolean) | null = null;
let cachedAjv: Ajv2020 | null = null;

function getValidator(): { ajv: Ajv2020; validate: (spec: unknown) => boolean } {
	if (cachedValidator && cachedAjv) {
		return { ajv: cachedAjv, validate: cachedValidator };
	}

	// strict:false lets us use additionalProperties selectively without Ajv
	// complaining about every minor schema feature. allErrors:true returns
	// the full list rather than failing fast so the UI can surface multiple
	// problems at once.
	const ajv = new Ajv2020({ allErrors: true, strict: false });
	addFormats(ajv);

	for (const schema of SUB_SCHEMAS) {
		ajv.addSchema(schema);
	}
	const validate = ajv.compile(routineSpecSchema);

	cachedAjv = ajv;
	cachedValidator = validate;
	return { ajv, validate };
}

function normalizeErrors(errors: ErrorObject[] | null | undefined): ValidationError[] {
	if (!errors) return [];
	return errors.map((e) => ({
		path: e.instancePath || "/",
		keyword: e.keyword,
		message: e.message ?? "(no message)",
		params: (e.params as Record<string, unknown>) ?? {},
	}));
}

/**
 * Validate a V1 routine spec object. The argument should already be the
 * parsed-from-YAML JavaScript object; YAML parsing is the caller's
 * responsibility (and lives in the server's routine runner).
 */
export function validateRoutineSpec(spec: unknown): ValidationResult {
	const { validate } = getValidator();
	const valid = validate(spec);
	if (valid) return { valid: true };
	// Cast: Ajv attaches `.errors` to the compiled validator function.
	const errors = (validate as unknown as { errors?: ErrorObject[] | null }).errors;
	return { valid: false, errors: normalizeErrors(errors) };
}
