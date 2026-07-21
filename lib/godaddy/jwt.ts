// ----------------------------------------------------------------
// GoDaddy Poynt — self-signed JWT (jwt-bearer grant)
//
// Poynt's cloud APIs use OAuth 2.0 with a self-signed JWT bearer
// grant. Our app signs a short-lived JWT with our RSA private key;
// Poynt verifies the signature with the public key we uploaded
// during app creation.
//
// Two places we use these JWTs:
//   1. Section 1a of the Poynt integration spec: exchange for an
//      *app* access token (grantType=urn:ietf:params:oauth:grant-
//      type:jwt-bearer, assertion=<this JWT>).
//   2. Section 3 of the spec: exchange a merchant `code` for their
//      access + refresh tokens (Authorization: Bearer <this JWT>
//      header on the token endpoint).
//
// Both cases use the same self-signed JWT — the same claim shape,
// same private key. Only the surrounding call differs.
//
// Claims (per Poynt spec §1a):
//   iss = urn:aid:<APP_ID>
//   sub = urn:aid:<APP_ID>
//   aud = https://services.poynt.net  (or the EU host)
//   iat = now
//   exp = now + 300s
//   jti = uuidv4 (unique per request)
//
// Signing alg: RS256 (Poynt supports RS256/384/512 and PS variants;
// RS256 is the documented default).
// ----------------------------------------------------------------

import { SignJWT, importPKCS8 } from 'jose'
import { randomUUID } from 'crypto'

const JWT_ALG = 'RS256'
const JWT_LIFETIME_SEC = 300

// The env var holds the PEM contents (BEGIN PRIVATE KEY / END
// PRIVATE KEY). Vercel handles multi-line values fine; a common
// gotcha is escaping newlines as `\n` and getting a literal
// backslash-n at runtime. `unescapePem` normalizes both shapes.
function unescapePem(pem: string): string {
  return pem.includes('\\n') ? pem.replace(/\\n/g, '\n') : pem
}

// Cache the imported key across warm invocations. jose's
// importPKCS8 does key parsing on every call; caching skips it
// when the same process handles multiple sign operations. Reset
// on env-var change is handled by process restart (Vercel
// redeploy), which is the correct model.
let cachedKey: CryptoKey | null = null
let cachedKeyPem: string | null = null

async function getSigningKey(): Promise<CryptoKey> {
  const rawPem = process.env.GODADDY_POYNT_PRIVATE_KEY
  if (!rawPem) {
    throw new Error(
      'GODADDY_POYNT_PRIVATE_KEY is not set. The GoDaddy Poynt Cloud App JWT signer needs your app private key as a PEM string in this env var.',
    )
  }
  const pem = unescapePem(rawPem)
  if (cachedKey && cachedKeyPem === pem) return cachedKey
  const key = await importPKCS8(pem, JWT_ALG)
  cachedKey = key
  cachedKeyPem = pem
  return key
}

/** Sign a fresh self-signed JWT with the shape Poynt expects for
 *  both the app-token grant and the merchant-code exchange. */
export async function signPoyntAppJwt(): Promise<string> {
  const appId = process.env.GODADDY_POYNT_APP_ID
  if (!appId) {
    throw new Error(
      'GODADDY_POYNT_APP_ID is not set. Expected value looks like "urn:aid:<uuid>" — copy it from the Poynt Developer Center → your app → Application ID.',
    )
  }
  const audience = process.env.GODADDY_POYNT_BASE_URL || 'https://services.poynt.net'

  const key = await getSigningKey()
  const now = Math.floor(Date.now() / 1000)

  return await new SignJWT({})
    .setProtectedHeader({ alg: JWT_ALG })
    .setIssuer(appId)
    .setSubject(appId)
    .setAudience(audience)
    .setIssuedAt(now)
    .setExpirationTime(now + JWT_LIFETIME_SEC)
    .setJti(randomUUID())
    .sign(key)
}
