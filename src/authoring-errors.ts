export class AuthoringCompileError extends Error {
	constructor(
		message: string,
		readonly sourcePointer?: string,
	) {
		super(sourcePointer ? `${sourcePointer}: ${message}` : message);
		this.name = "AuthoringCompileError";
	}
}
