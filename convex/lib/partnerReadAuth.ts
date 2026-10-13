const encoder = new TextEncoder();

export async function hasPartnerBearerToken(header: string | null, expected: string | undefined): Promise<boolean> {
  if (!expected || expected.length < 32 || !header || header.length > 520) return false;
  const match = /^Bearer ([A-Za-z0-9_-]{43,})$/.exec(header);
  if (!match) return false;

  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(match[1])),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(providedHash);
  const right = new Uint8Array(expectedHash);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}

export function partnerPageOptions(url: URL): { cursor?: string; limit: number } | null {
  const limitValue = url.searchParams.get("limit");
  const limit = limitValue === null ? 50 : Number(limitValue);
  const cursor = url.searchParams.get("cursor") ?? undefined;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return null;
  if (cursor !== undefined && (!cursor || cursor.length > 2048)) return null;
  return { ...(cursor ? { cursor } : {}), limit };
}
