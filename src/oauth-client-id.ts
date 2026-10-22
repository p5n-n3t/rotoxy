const CLIENT_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function safeClientId(value: unknown): value is string {
  return typeof value === "string" && CLIENT_ID.test(value);
}
