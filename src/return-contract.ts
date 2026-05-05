import Ajv from "ajv";
import type { SealedReturnContract } from "./types.js";

type AjvCtor = new (
	...args: unknown[]
) => {
	compile: (schema: unknown) => {
		(data: unknown): boolean;
		errors?: unknown[];
	};
};

export function validateReturnContract(
	value: unknown,
	contract?: SealedReturnContract,
): { ok: true } | { ok: false; errors: unknown[] } {
	if (!contract?.schema) return { ok: true };

	const ajv = new (Ajv as unknown as AjvCtor)({
		allErrors: true,
		strict: false,
	});
	const validate = ajv.compile(contract.schema);

	if (!validate(value)) {
		return {
			ok: false,
			errors: validate.errors ?? [],
		};
	}

	return { ok: true };
}
