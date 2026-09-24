export class TwgError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "TwgError";
    this.code = code;
  }
}

export function fail(code: string, message: string): never {
  throw new TwgError(code, message);
}
