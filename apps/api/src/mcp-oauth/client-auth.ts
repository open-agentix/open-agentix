import { constants, createPrivateKey, randomUUID, sign, type KeyObject } from 'node:crypto';
import { OaxError } from '@openagentix/core';

/** What a client needs to authenticate at a token or revocation endpoint (values, never logged). */
export interface ClientCredentials {
  clientId: string;
  method: 'client_secret_basic' | 'private_key_jwt';
  /** `client_secret_basic`. */
  secret?: string | undefined;
  /** `private_key_jwt`: PEM. */
  privateKeyPem?: string | undefined;
  keyId?: string | undefined;
}

export interface ClientAuthContext {
  /** `aud` of the client assertion: the endpoint the request is sent to (RFC 7523 section 3). */
  audience: string;
  now: Date;
  /** `token_endpoint_auth_signing_alg_values_supported`, if the server published them. */
  algsSupported?: readonly string[] | undefined;
}

export interface ClientAuthentication {
  headers: Record<string, string>;
  form: Record<string, string>;
  /** Secret-bearing strings to register with the redactors (the minted assertion). */
  sensitive: string[];
}

const formEncode = (v: string) => encodeURIComponent(v).replace(/%20/g, '+');
const b64u = (v: Buffer | string) => Buffer.from(v).toString('base64url');
export const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const ASSERTION_TTL_S = 60;

type Alg = 'RS256' | 'PS256' | 'ES256' | 'EdDSA';

function loadKey(pem: string): KeyObject {
  try {
    return createPrivateKey(pem);
  } catch {
    // The parser's message can quote parts of the input; the operator learns only the reason class.
    throw new OaxError('mcp_oauth_key_invalid', 'the client key is not a usable PEM private key');
  }
}

function pickAlg(key: KeyObject, supported?: readonly string[]): Alg {
  const type = key.asymmetricKeyType;
  let alg: Alg;
  if (type === 'rsa') {
    alg =
      supported && !supported.includes('RS256') && supported.includes('PS256') ? 'PS256' : 'RS256';
  } else if (type === 'rsa-pss') alg = 'PS256';
  else if (type === 'ec') {
    if (key.asymmetricKeyDetails?.namedCurve !== 'prime256v1')
      throw new OaxError('mcp_oauth_key_invalid', 'only P-256 EC keys are supported');
    alg = 'ES256';
  } else if (type === 'ed25519') alg = 'EdDSA';
  else throw new OaxError('mcp_oauth_key_invalid', 'the client key type is not supported');
  if (supported && !supported.includes(alg))
    throw new OaxError(
      'mcp_oauth_unsupported',
      'the authorization server does not accept the algorithm of the client key',
    );
  return alg;
}

function signAssertion(
  pem: string,
  claims: Record<string, unknown>,
  keyId: string | undefined,
  supported?: readonly string[],
): string {
  const key = loadKey(pem);
  const alg = pickAlg(key, supported);
  const header = { alg, typ: 'JWT', ...(keyId ? { kid: keyId } : {}) };
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`;
  const data = Buffer.from(input);
  let sig: Buffer;
  switch (alg) {
    case 'RS256':
      sig = sign('sha256', data, key);
      break;
    case 'PS256':
      sig = sign('sha256', data, {
        key,
        padding: constants.RSA_PKCS1_PSS_PADDING,
        saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
      });
      break;
    case 'ES256':
      sig = sign('sha256', data, { key, dsaEncoding: 'ieee-p1363' });
      break;
    default:
      sig = sign(null, data, key);
  }
  return `${input}.${b64u(sig)}`;
}

/** Client authentication for one request (RFC 6749 section 2.3, RFC 7523). */
export function authenticateClient(
  c: ClientCredentials,
  ctx: ClientAuthContext,
): ClientAuthentication {
  if (c.method === 'client_secret_basic') {
    if (!c.secret) throw new OaxError('mcp_oauth_client_invalid', 'the client secret is empty');
    const basic = Buffer.from(`${formEncode(c.clientId)}:${formEncode(c.secret)}`).toString(
      'base64',
    );
    return { headers: { authorization: `Basic ${basic}` }, form: {}, sensitive: [c.secret, basic] };
  }
  if (!c.privateKeyPem) throw new OaxError('mcp_oauth_client_invalid', 'the client key is empty');
  const iat = Math.floor(ctx.now.getTime() / 1000);
  const jwt = signAssertion(
    c.privateKeyPem,
    {
      iss: c.clientId,
      sub: c.clientId,
      aud: ctx.audience,
      iat,
      nbf: iat,
      exp: iat + ASSERTION_TTL_S,
      jti: randomUUID(),
    },
    c.keyId,
    ctx.algsSupported,
  );
  return {
    headers: {},
    form: { client_id: c.clientId, client_assertion_type: ASSERTION_TYPE, client_assertion: jwt },
    sensitive: [jwt],
  };
}
