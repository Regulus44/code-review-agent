import { createHmac, createVerify, timingSafeEqual } from "node:crypto";
import type { PrincipalBackend, SessionOwnership } from "@code-review-agent/contracts";
import { brand } from "@code-review-agent/contracts";

export interface ProductizationJwtKey {
  readonly kid: string;
  readonly alg: "HS256" | "RS256";
  readonly secret?: string;
  readonly publicKey?: string;
}

export interface ProductizationJwtOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly keys: readonly ProductizationJwtKey[];
  /** Optional host-owned JWKS refresh hook; callers control network policy. */
  readonly jwks?: () => Promise<readonly ProductizationJwtKey[]>;
  readonly subjectClaim?: string;
  readonly tenantClaim?: string;
  readonly clockSkewSeconds?: number;
}

export class JwtVerificationError extends Error {
  readonly code = "JWT_INVALID";
}

interface JwtPayload {
  readonly [key: string]: unknown;
}

export async function verifyProductizationJwt(token: string, options: ProductizationJwtOptions, principals: PrincipalBackend | undefined): Promise<SessionOwnership> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new JwtVerificationError("JWT must have three compact-serialization segments");
  const encodedHeader = parts[0];
  const encodedPayload = parts[1];
  const encodedSignature = parts[2];
  if (encodedHeader === undefined || encodedPayload === undefined || encodedSignature === undefined) throw new JwtVerificationError("JWT segments are incomplete");
  const header = parseJson(encodedHeader, "JWT header");
  const payload = parseJson(encodedPayload, "JWT payload");
  if (header.alg !== "HS256" && header.alg !== "RS256") throw new JwtVerificationError("JWT algorithm is not allowed");
  if (typeof header.kid !== "string" || header.kid.length === 0) throw new JwtVerificationError("JWT key id is required");
  const staticKeys = options.keys;
  const refreshedKeys = options.jwks === undefined ? [] : await options.jwks();
  const key = [...staticKeys, ...refreshedKeys].find((candidate) => candidate.kid === header.kid && candidate.alg === header.alg);
  if (key === undefined) throw new JwtVerificationError("JWT signing key is unavailable");
  if (!verifySignature(`${encodedHeader}.${encodedPayload}`, encodedSignature, key)) throw new JwtVerificationError("JWT signature is invalid");

  if (payload.iss !== options.issuer) throw new JwtVerificationError("JWT issuer is invalid");
  if (!audienceContains(payload.aud, options.audience)) throw new JwtVerificationError("JWT audience is invalid");
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const skew = Math.max(0, Math.floor(options.clockSkewSeconds ?? 30));
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp) || payload.exp + skew < nowSeconds) throw new JwtVerificationError("JWT is expired");
  if (payload.nbf !== undefined && (typeof payload.nbf !== "number" || payload.nbf - skew > nowSeconds)) throw new JwtVerificationError("JWT is not active yet");

  const subjectClaim = options.subjectClaim ?? "sub";
  const tenantClaim = options.tenantClaim ?? "tenant_id";
  const subject = payload[subjectClaim];
  if (typeof subject !== "string" || subject.length === 0) throw new JwtVerificationError("JWT subject is required");
  if (principals === undefined) throw new JwtVerificationError("JWT principal catalog is not configured");
  const principal = principals.getPrincipal(subject);
  if (principal === undefined || principal.status !== "active") throw new JwtVerificationError("JWT principal is not active in the host catalog");
  const claimedTenant = payload[tenantClaim];
  if (claimedTenant !== undefined && claimedTenant !== principal.tenantId) throw new JwtVerificationError("JWT tenant claim does not match the principal catalog");
  return { principalId: brand<string, "PrincipalId">(principal.id), tenantId: principal.tenantId };
}

function parseJson(segment: string, label: string): JwtPayload {
  try {
    const value = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object");
    return value as JwtPayload;
  } catch {
    throw new JwtVerificationError(`${label} is invalid`);
  }
}

function verifySignature(signingInput: string, encodedSignature: string, key: ProductizationJwtKey): boolean {
  const signature = Buffer.from(encodedSignature, "base64url");
  if (key.alg === "HS256") {
    if (key.secret === undefined) return false;
    const expected = createHmac("sha256", key.secret).update(signingInput).digest();
    return expected.length === signature.length && timingSafeEqual(expected, signature);
  }
  if (key.publicKey === undefined) return false;
  const verifier = createVerify("RSA-SHA256");
  verifier.update(signingInput);
  verifier.end();
  return verifier.verify(key.publicKey, signature);
}

function audienceContains(value: unknown, expected: string): boolean {
  return typeof value === "string" ? value === expected : Array.isArray(value) && value.includes(expected);
}
