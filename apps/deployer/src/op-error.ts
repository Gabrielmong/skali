/** A refused operation; the API answers with `status` and `{ error: message }`. */
export class OpError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = 'OpError';
  }
}
