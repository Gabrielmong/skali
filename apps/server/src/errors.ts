export class BadRequestError extends Error {
  constructor(message: string) { super(message); this.name = "BadRequestError"; }
}
export class ConflictError extends Error {
  constructor(message: string) { super(message); this.name = "ConflictError"; }
}
export class NotFoundError extends Error {
  constructor(message: string) { super(message); this.name = "NotFoundError"; }
}
/** An error whose message is meant for the client, with its own status. */
export class ExposedError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = "ExposedError"; }
}
