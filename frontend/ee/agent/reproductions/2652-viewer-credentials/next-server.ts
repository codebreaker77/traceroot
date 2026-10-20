export class NextRequest extends Request {
  get nextUrl() {
    return new URL(this.url);
  }
}
export class NextResponse extends Response {
  static json(data: unknown, init?: ResponseInit) {
    return Response.json(data, init);
  }
}
