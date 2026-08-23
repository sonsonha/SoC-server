import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const GOOGLE_ISSUERS = new Set([
  'https://accounts.google.com',
  'accounts.google.com',
]);

const googleJwks = createRemoteJWKSet(
  new URL('https://www.googleapis.com/oauth2/v3/certs'),
);

export type VerifiedGoogleIdentity = {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
};

/**
 * Verify a Google Identity Services ID token (openid/email/profile).
 * Does not accept Calendar OAuth access tokens.
 */
export async function verifyGoogleIdToken(
  idToken: string,
  audience: string,
): Promise<VerifiedGoogleIdentity> {
  let payload;
  try {
    ({ payload } = await jwtVerify(idToken, googleJwks, { audience }));
  } catch {
    throw Object.assign(new Error('Invalid or expired Google identity token'), {
      statusCode: 401,
      code: 'INVALID_GOOGLE_TOKEN',
    });
  }

  const issuer = typeof payload.iss === 'string' ? payload.iss : '';
  if (!GOOGLE_ISSUERS.has(issuer)) {
    throw Object.assign(new Error('Invalid Google token issuer'), {
      statusCode: 401,
      code: 'INVALID_GOOGLE_TOKEN',
    });
  }

  const exp = typeof payload.exp === 'number' ? payload.exp : 0;
  if (exp * 1000 < Date.now()) {
    throw Object.assign(new Error('Google identity token expired'), {
      statusCode: 401,
      code: 'INVALID_GOOGLE_TOKEN',
    });
  }

  const sub = typeof payload.sub === 'string' ? payload.sub : '';
  if (!sub) {
    throw Object.assign(new Error('Google token missing subject'), {
      statusCode: 401,
      code: 'INVALID_GOOGLE_TOKEN',
    });
  }

  const email = typeof payload.email === 'string' ? payload.email : '';
  if (!email) {
    throw Object.assign(new Error('Google token missing email'), {
      statusCode: 401,
      code: 'INVALID_GOOGLE_TOKEN',
    });
  }

  const emailVerified = payload.email_verified === true
    || payload.email_verified === 'true';
  if (!emailVerified) {
    throw Object.assign(new Error('Google email is not verified'), {
      statusCode: 401,
      code: 'EMAIL_NOT_VERIFIED',
    });
  }

  return {
    sub,
    email,
    emailVerified,
    name: typeof payload.name === 'string' ? payload.name : null,
    picture: typeof payload.picture === 'string' ? payload.picture : null,
  };
}

export function hashSessionToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}
