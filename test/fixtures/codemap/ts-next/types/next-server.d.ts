// Local type stub for next/server, mapped via tsconfig "paths".
export declare class NextRequest extends Request {
  readonly nextUrl: URL;
}

export declare class NextResponse extends Response {
  static json(body: unknown, init?: ResponseInit): NextResponse;
}
