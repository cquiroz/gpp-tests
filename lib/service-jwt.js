/**
 * Validating the ODB service JWT at the moment it is minted.
 *
 * The service JWT is the one credential in the stack that is scraped from a CLI's stdout and
 * then handed to three services. When it is wrong, nothing says so: odb and itc boot happily
 * (they only use it lazily), and the failure surfaces minutes later inside obscalc as
 * `java.security.SignatureException: Bad signature length: got 512 but was expecting 256` —
 * a message that points at neither the token nor bootstrap.
 *
 * These checks are cheap and catch that class outright: the token must be a service-user
 * token, unexpired, and signed by a key of the size this stack is actually running.
 */

/**
 * @typedef {{ok: true, serviceName?: string} | {ok: false, reason: string}} CheckResult
 */

/**
 * @param {unknown} jwt
 * @param {{modulusBytes?: number, now?: number}} [opts] `modulusBytes` is the RSA modulus
 *   size of the SSO signing key; omit it (or pass 0) to skip the size comparison.
 * @returns {CheckResult}
 */
export function checkServiceJwt(jwt, opts = {}) {
  if (typeof jwt !== "string" || jwt.length === 0) {
    return { ok: false, reason: "no token was produced" };
  }

  const parts = jwt.split(".");
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) {
    return { ok: false, reason: "not a three-segment JWT" };
  }

  /** @type {Record<string, any>} */
  let payload;
  try {
    payload = JSON.parse(
      Buffer.from(/** @type {string} */ (parts[1]), "base64url").toString("utf8"),
    );
  } catch {
    return { ok: false, reason: "payload is not valid JSON" };
  }
  if (!payload || typeof payload !== "object") {
    return { ok: false, reason: "payload is not a JSON object" };
  }

  const user = payload["lucuma-user"];
  if (!user || user.type !== "service") {
    return {
      ok: false,
      reason: `token is not for a service user (lucuma-user.type = ${JSON.stringify(user?.type)})`,
    };
  }

  if (typeof payload.exp === "number") {
    const nowSeconds = Math.floor((opts.now ?? Date.now()) / 1000);
    if (payload.exp <= nowSeconds) {
      return { ok: false, reason: `token expired at ${new Date(payload.exp * 1000).toISOString()}` };
    }
  }

  // The decisive check. An RSA signature is exactly as long as the modulus, so a token signed
  // by a different keypair than the one this stack runs is caught here rather than by a JVM
  // stack trace much later.
  const modulusBytes = opts.modulusBytes;
  if (modulusBytes) {
    const signatureBytes = Buffer.from(
      /** @type {string} */ (parts[2]),
      "base64url",
    ).length;
    if (signatureBytes !== modulusBytes) {
      return {
        ok: false,
        reason:
          `signature is ${signatureBytes} bytes but this stack's SSO key expects ${modulusBytes} ` +
          `— the token was signed by a different keypair`,
      };
    }
  }

  return { ok: true, serviceName: typeof user.name === "string" ? user.name : undefined };
}

/**
 * RSA modulus size, in bytes, of an ASCII-armored PGP public key.
 *
 * Parses just enough of RFC 4880 to read the key: unwrap the armor, walk the packet headers
 * to the public-key packet (tag 6), skip its version/timestamp/algorithm bytes, and read the
 * MPI bit-length that precedes the modulus. Deliberately no OpenPGP dependency — this runs
 * during bootstrap, where the only guaranteed runtime is Node itself.
 *
 * @param {string} armored
 * @returns {number|undefined} undefined when the key cannot be parsed or is not RSA
 */
export function rsaModulusBytes(armored) {
  if (typeof armored !== "string" || !armored.includes("BEGIN PGP PUBLIC KEY")) {
    return undefined;
  }

  const body = armored
    .replace(/-----BEGIN PGP PUBLIC KEY BLOCK-----/, "")
    .replace(/-----END PGP PUBLIC KEY BLOCK-----/, "")
    .split("\n")
    // Drop armor headers (`Version: …`), the CRC line (`=abcd`) and blanks.
    .filter((line) => {
      const l = line.trim();
      return l.length > 0 && !l.startsWith("=") && !/^[A-Za-z][\w-]*:/.test(l);
    })
    .join("");

  let data;
  try {
    data = Buffer.from(body, "base64");
  } catch {
    return undefined;
  }
  if (data.length < 12) return undefined;

  // First packet: old-format header, tag 6 (public key). Bit 7 set, bit 6 clear.
  const tagByte = data[0];
  if (tagByte === undefined || (tagByte & 0x80) === 0) return undefined;

  let offset;
  if ((tagByte & 0x40) === 0) {
    // Old format: tag in bits 5-2, length-type in bits 1-0.
    const tag = (tagByte & 0x3c) >> 2;
    if (tag !== 6) return undefined;
    const lengthType = tagByte & 0x03;
    offset = 1 + (lengthType === 0 ? 1 : lengthType === 1 ? 2 : lengthType === 2 ? 4 : 0);
  } else {
    // New format: tag in bits 5-0, then a variable-length length field.
    if ((tagByte & 0x3f) !== 6) return undefined;
    const first = data[1];
    if (first === undefined) return undefined;
    offset = first < 192 ? 2 : first < 224 ? 3 : first === 255 ? 6 : 2;
  }

  // Public-key packet body: version(1) creation(4) algorithm(1), then the MPIs.
  const version = data[offset];
  if (version !== 4) return undefined; // v3 keys predate everything we run
  const algorithm = data[offset + 5];
  // 1 = RSA (encrypt or sign), 2 = RSA encrypt-only, 3 = RSA sign-only.
  if (algorithm !== 1 && algorithm !== 2 && algorithm !== 3) return undefined;

  // First MPI is the modulus: a two-byte big-endian bit count, then that many bits.
  const bits = data.readUInt16BE(offset + 6);
  if (!bits || bits > 16384) return undefined;
  return Math.ceil(bits / 8);
}
