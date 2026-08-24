import { describe, expect, it } from "vitest";
import { checkServiceJwt, rsaModulusBytes } from "./service-jwt.js";

/**
 * @param {object} payload
 * @param {number} signatureBytes
 * @param {object} [header]
 */
function makeJwt(payload, signatureBytes, header = { typ: "JWT", alg: "RS512" }) {
  const b64 = (/** @type {object} */ o) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  const sig = Buffer.alloc(signatureBytes, 7).toString("base64url");
  return `${b64(header)}.${b64(payload)}.${sig}`;
}

const servicePayload = {
  iss: "lucuma-sso",
  sub: "260",
  aud: "lucuma",
  exp: 2418331266,
  "lucuma-user": { type: "service", id: "u-104", name: "odb" },
};

describe("checkServiceJwt", () => {
  it("accepts a service token whose signature matches the key size", () => {
    const result = checkServiceJwt(makeJwt(servicePayload, 256), {
      modulusBytes: 256,
    });
    expect(result).toEqual({ ok: true, serviceName: "odb" });
  });

  it("rejects a token signed by a different (larger) key — the obscalc failure", () => {
    // The real symptom: SSO was reissued with an RSA-2048 keypair, but the inherited token
    // carried a 512-byte signature from an RSA-4096 one. obscalc reported it minutes later
    // as "Bad signature length: got 512 but was expecting 256".
    const result = checkServiceJwt(makeJwt(servicePayload, 512), {
      modulusBytes: 256,
    });
    if (result.ok) throw new Error("expected the token to be rejected");
    expect(result.reason).toMatch(/signature is 512 bytes.*expects 256/i);
  });

  it("rejects a token that is not for a service user", () => {
    const guest = {
      ...servicePayload,
      "lucuma-user": { type: "guest", id: "u-1" },
    };
    const result = checkServiceJwt(makeJwt(guest, 256), { modulusBytes: 256 });
    if (result.ok) throw new Error("expected the token to be rejected");
    expect(result.reason).toMatch(/service user/i);
  });

  it("rejects malformed input rather than trusting it", () => {
    for (const bad of ["", "not-a-jwt", "a.b", "eyJ.eyJ"]) {
      expect(checkServiceJwt(bad, { modulusBytes: 256 }).ok).toBe(false);
    }
  });

  it("rejects a token whose payload is not JSON", () => {
    const jwt = `${Buffer.from('{"alg":"RS512"}').toString("base64url")}.bm90LWpzb24.${Buffer.alloc(256).toString("base64url")}`;
    expect(checkServiceJwt(jwt, { modulusBytes: 256 }).ok).toBe(false);
  });

  it("rejects an already-expired token", () => {
    const expired = { ...servicePayload, exp: 1000 };
    const result = checkServiceJwt(makeJwt(expired, 256), {
      modulusBytes: 256,
      now: 2000 * 1000,
    });
    if (result.ok) throw new Error("expected the token to be rejected");
    expect(result.reason).toMatch(/expired/i);
  });

  it("skips the size check when the key size is unknown", () => {
    // Better a weaker check than a false alarm: the structural checks still apply.
    expect(checkServiceJwt(makeJwt(servicePayload, 512), {}).ok).toBe(true);
    expect(checkServiceJwt(makeJwt(servicePayload, 512), { modulusBytes: 0 }).ok).toBe(
      true,
    );
  });
});

describe("rsaModulusBytes", () => {
  it("reads the RSA key size out of an ASCII-armored PGP public key", () => {
    // A real 2048-bit key produced by stack/scripts/gen-sso-keys.sh.
    const armored = `-----BEGIN PGP PUBLIC KEY BLOCK-----

mQENBGqF/h0BCADKnYzgc3iXiMpfS8W1IYPeF/bJ0BH6XoxAsNHaEQjl8D3D8tj3
45HKuglLJ1DjP/if6F+LEriqppBzSHlKMyGWD8hjY/uhRMENVXE26kbpvU/PxxFq
mQAbzq0rPib+irWmRw2Zs8qpZeknEJ8h0M0b83rm/0KHD9IcQTkyOjVecpBjfJeC
ff1RK7B70KfIxoVwQJfgh/lugTqRovCMVwicFxMrsX6Gk0sMoYGspwi9pJMVanKY
0d79qeTVaEw1XPq+SFR+Jt0vWU8ndqmBFKzRUctCBHngup4FbH5HFsKqoDwdlhE4
QCmuk9nuFH0Ln5EHD53z9cgI7VWOUbtgvzZVABEBAAG0Jm9kYmF0dHIgdGVzdCBT
U08gPG9kYmF0dHJAZXhhbXBsZS5jb20+iQFOBBMBCgA4FiEEb5MRM4jHogGvqll8
o2L+O5dC8xsFAmqF/h0CGwMFCwkIBwIGFQoJCAsCBBYCAwECHgECF4AACgkQo2L+
O5dC8xvH0ggAvkFsylAfQopA8vvRMlwsudI4djfdrRNiMAlEzHMRrcjk4AO/S7Ry
N+7wjpIPk/gF47y+rSfMPYFuHU2VO58/xE7W6hJzBFxZ1BIrAc3XnghInUefhlMH
hcI67flMX+FXF382F0LOhO4IQyu+k2odNlHXsspOOsCIOJoUSVlPZkzH2NaNPCM/
SK+5ay7guXuE+USDetlmrS9kc9WNsIplmgBKvYRjvTsExFICwZuxMkfyrzJzil96
Vv/v57go3ZjhN39+VwL3aZyS1C9D0D2OlxFARJbXaEb1DGojKOBPyR2M0RpwxSVn
F82rdkeezg3bkMYfUiPSJlqfC2mP/GxViA==
=0/eV
-----END PGP PUBLIC KEY BLOCK-----`;
    expect(rsaModulusBytes(armored)).toBe(256);
  });

  it("returns undefined for anything it cannot parse, rather than guessing", () => {
    expect(rsaModulusBytes("")).toBeUndefined();
    expect(rsaModulusBytes("not a key")).toBeUndefined();
    expect(
      rsaModulusBytes("-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nZm9v\n-----END PGP PUBLIC KEY BLOCK-----"),
    ).toBeUndefined();
  });
});
