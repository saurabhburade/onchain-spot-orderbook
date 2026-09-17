import "server-only";

import { PrivyClient } from "@privy-io/node";

let client: PrivyClient | null = null;

export function getPrivyServerClient() {
  if (client) return client;
  const appId = process.env.PRIVY_APP_ID ?? process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  const appSecret = process.env.PRIVY_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error("Privy Wallet API is not configured: set NEXT_PUBLIC_PRIVY_APP_ID and PRIVY_APP_SECRET");
  }
  client = new PrivyClient({
    appId,
    appSecret,
    ...(process.env.PRIVY_JWT_VERIFICATION_KEY ? { jwtVerificationKey: process.env.PRIVY_JWT_VERIFICATION_KEY } : {}),
  });
  return client;
}

export async function authenticatePrivyRequest(request: Request) {
  const authorization = request.headers.get("authorization");
  const accessToken = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
  if (!accessToken) throw new Error("Missing Privy access token");
  const privy = getPrivyServerClient();
  await privy.utils().auth().verifyAuthToken(accessToken);
  return privy;
}
