/**
 * One observation per observing mode (wayfinder ticket 030).
 *
 * The fixture table for the `observing-modes` scenario. Each entry is a configuration the
 * ODB and ITC accept, not merely one the schema accepts: nearly every mode field is
 * nullable in `schema/OdbSchema.graphql`, so validity is only known at runtime. Every entry
 * was verified against a live stack; record why in a comment when a value is not obvious.
 *
 * The k6 scenario builds each observation from `observingMode` + `scienceRequirements`
 * directly. The browser scenario seeds only `scienceRequirements` and picks the mode in
 * Explore through `explore`, accepting Explore's defaults — so the two layers build
 * different observations on purpose, and a mode that is green in k6 but red in the browser
 * points at Explore's defaults.
 *
 * MOS modes (GMOS North/South, Flamingos-2) are absent: a custom mask is an upload, and the
 * stack has no object store yet (ticket 028).
 *
 * Pure and dependency-free: k6 imports this module directly.
 */

/**
 * @typedef {"sequence" | "created"} ModeCheck
 *   `sequence`: pass when the observation has a time estimate and a science sequence.
 *   `created`: visitor and exchange modes have no calculation; pass on create + read-back.
 *
 * @typedef {"optical" | "nearIr" | "nearIrFaint" | "bright"} TargetFamily
 *
 * @typedef {object} ExploreSelection  How the browser scenario picks the mode.
 * @property {"Spectroscopy" | "Imaging" | "Visitor" | "Keck" | "Subaru"} configMode
 *   the label of Explore's "Mode" dropdown (`ConfigurationMode`)
 * @property {string} [instrument] Explore's instrument filter label (`Instrument.longName`,
 *   per `given Display[Instrument]` in explore/model/display.scala)
 * @property {string} [instrumentTag] the row's `data-instrument` (`Instrument.tag`)
 * @property {string} [focalPlane] the row's `data-focal-plane` (`FocalPlane.tag`), spectroscopy only
 * @property {VisitorForm} [visitor] the visitor editor's fields, which have no defaults
 *
 * @typedef {object} VisitorForm  Typed as a user would, in Explore's units.
 * @property {string} site               Site label (`Site.shortName`): GN, GS
 * @property {string} name
 * @property {string} centralWavelength  nanometers
 * @property {string} agsDiameter        arcseconds
 * @property {string} scienceFovDiameter arcseconds
 * @property {string} totalTime          h:mm
 *
 * @typedef {object} ObservingModeFixture
 * @property {string} key       stable id: k6 `mode` tag value and test-title suffix source
 * @property {string} title     human name, used in the e2e test title
 * @property {string} modeType  the `ObservingModeType` the read-back must report
 * @property {ModeCheck} check
 * @property {TargetFamily} [target]  absent for `created` modes, which need none
 * @property {Record<string, unknown>} observingMode        an `ObservingModeInput`
 * @property {Record<string, unknown>} [scienceRequirements] a `ScienceRequirementsInput`
 * @property {ExploreSelection} explore
 * @property {{reason: string, link: string, tolerate?: string}} [expectedFailure]
 *   Runs the mode as an expected failure (`test.fail`, inverted k6 check), so the entry turns
 *   red the day the mode starts passing and cannot go stale. Never skip a mode silently.
 *   `tolerate` is the `odb_error` tag of the expected error, so k6 does not also count it
 *   in `odb_graphql_errors` (whose threshold is zero).
 */

/** @param {number} nanometers */
const nm = (nanometers) => ({ nanometers });

/**
 * A point source with the given magnitudes; the ITC needs a brightness in the mode's band.
 * @param {string} sed a `StellarLibrarySpectrum`
 * @param {[string, number][]} brightnesses band and Vega magnitude
 */
function pointSource(sed, brightnesses) {
  return {
    point: {
      bandNormalized: {
        sed: { stellarLibrary: sed },
        brightnesses: brightnesses.map(([band, value]) => ({
          band,
          value,
          units: "VEGA_MAGNITUDE",
        })),
      },
    },
  };
}

/**
 * One target per instrument family. Positions are real (M1 and nearby) and reachable from
 * both sites; what differs is which bands carry a brightness, since the ITC refuses a mode
 * whose band has none.
 *
 * @type {Record<TargetFamily, import("./odb-operations.js").TargetFixture>}
 */
export const MODE_TARGETS = {
  optical: {
    name: "GPP Optical Star (gpp-tests)",
    sidereal: {
      ra: { hms: "05:34:31.940" },
      dec: { dms: "+22:00:52.20" },
      epoch: "J2000.000",
    },
    sourceProfile: pointSource("A0_V", [
      ["V", 15],
      ["R", 15],
      ["I", 15],
    ]),
  },
  nearIr: {
    name: "GPP Near-IR Star (gpp-tests)",
    sidereal: {
      ra: { hms: "05:34:31.940" },
      dec: { dms: "+22:00:52.20" },
      epoch: "J2000.000",
    },
    sourceProfile: pointSource("K0_III", [
      ["J", 12],
      ["H", 12],
      ["K", 12],
    ]),
  },
  // Flamingos-2 imaging saturates on the 12 mag star ("well half filled in 1.33 seconds"),
  // while Flamingos-2 long slit at 15 mag needs thousands of exposures and the ITC refuses.
  nearIrFaint: {
    name: "GPP Faint Near-IR Star (gpp-tests)",
    sidereal: {
      ra: { hms: "05:34:31.940" },
      dec: { dms: "+22:00:52.20" },
      epoch: "J2000.000",
    },
    sourceProfile: pointSource("K0_III", [
      ["J", 15],
      ["H", 15],
      ["K", 15],
    ]),
  },
  bright: {
    name: "GPP Bright Star (gpp-tests)",
    sidereal: {
      ra: { hms: "05:34:31.940" },
      dec: { dms: "+22:00:52.20" },
      epoch: "J2000.000",
    },
    sourceProfile: pointSource("G2_V", [
      ["V", 10],
      ["R", 10],
      ["J", 9],
      ["H", 9],
      ["K", 9],
    ]),
  },
};

/**
 * @param {number} wavelength nanometers
 * @param {{resolution?: number, focalPlane?: string, signalToNoise?: number}} [opts]
 */
function spectroscopy(wavelength, opts = {}) {
  return {
    exposureTimeMode: {
      signalToNoise: { value: opts.signalToNoise ?? 50, at: nm(wavelength) },
    },
    spectroscopy: {
      wavelength: nm(wavelength),
      resolution: opts.resolution ?? 1000,
      focalPlane: opts.focalPlane ?? "SINGLE_SLIT",
    },
  };
}

/** @param {number} wavelength nanometers, where the S/N is evaluated */
function imaging(wavelength) {
  return {
    exposureTimeMode: { signalToNoise: { value: 50, at: nm(wavelength) } },
    imaging: { broadFilters: true },
  };
}

/** GHOST's per-channel exposure: TimeAndCount only, same wavelength in both channels. */
const GHOST_EXPOSURE = {
  timeAndCount: { time: { seconds: 600 }, count: 1, at: nm(600) },
};

/** @type {ObservingModeFixture[]} */
export const OBSERVING_MODES = [
  // --- GMOS ---------------------------------------------------------------------------
  {
    key: "gmos-north-long-slit",
    title: "GMOS North long slit",
    modeType: "GMOS_NORTH_LONG_SLIT",
    check: "sequence",
    target: "optical",
    // Unfiltered on purpose — see gmosNorthLongSlit() in odb-operations.js.
    observingMode: {
      gmosNorthLongSlit: {
        grating: "R831_G5302",
        fpu: "LONG_SLIT_0_50",
        centralWavelength: nm(500),
      },
    },
    scienceRequirements: spectroscopy(500),
    explore: {
      configMode: "Spectroscopy",
      instrument: "GMOS North",
      instrumentTag: "GmosNorth",
      focalPlane: "single_slit",
    },
  },
  {
    key: "gmos-south-long-slit",
    title: "GMOS South long slit",
    modeType: "GMOS_SOUTH_LONG_SLIT",
    check: "sequence",
    target: "optical",
    observingMode: {
      gmosSouthLongSlit: {
        grating: "R831_G5322",
        fpu: "LONG_SLIT_0_50",
        centralWavelength: nm(500),
      },
    },
    scienceRequirements: spectroscopy(500),
    explore: {
      configMode: "Spectroscopy",
      instrument: "GMOS South",
      instrumentTag: "GmosSouth",
      focalPlane: "single_slit",
    },
  },
  {
    key: "gmos-north-imaging",
    title: "GMOS North imaging",
    modeType: "GMOS_NORTH_IMAGING",
    check: "sequence",
    target: "optical",
    observingMode: {
      gmosNorthImaging: {
        variant: { grouped: {} },
        filters: [{ filter: "R_PRIME" }],
      },
    },
    scienceRequirements: imaging(630),
    explore: { configMode: "Imaging", instrument: "GMOS North", instrumentTag: "GmosNorth" },
  },
  {
    key: "gmos-south-imaging",
    title: "GMOS South imaging",
    modeType: "GMOS_SOUTH_IMAGING",
    check: "sequence",
    target: "optical",
    observingMode: {
      gmosSouthImaging: {
        variant: { grouped: {} },
        filters: [{ filter: "R_PRIME" }],
      },
    },
    scienceRequirements: imaging(630),
    explore: { configMode: "Imaging", instrument: "GMOS South", instrumentTag: "GmosSouth" },
  },

  // --- Flamingos-2 --------------------------------------------------------------------
  {
    key: "flamingos2-long-slit",
    title: "Flamingos-2 long slit",
    modeType: "FLAMINGOS_2_LONG_SLIT",
    check: "sequence",
    target: "nearIr",
    observingMode: {
      flamingos2LongSlit: { disperser: "R1200_JH", filter: "JH", fpu: "LONG_SLIT_2" },
    },
    scienceRequirements: spectroscopy(1400),
    explore: {
      configMode: "Spectroscopy",
      instrument: "Flamingos 2",
      instrumentTag: "Flamingos2",
      focalPlane: "single_slit",
    },
  },
  {
    key: "flamingos2-imaging",
    title: "Flamingos-2 imaging",
    modeType: "FLAMINGOS_2_IMAGING",
    check: "sequence",
    target: "nearIrFaint",
    observingMode: {
      flamingos2Imaging: { variant: { grouped: {} }, filters: [{ filter: "H" }] },
    },
    scienceRequirements: imaging(1650),
    explore: { configMode: "Imaging", instrument: "Flamingos 2", instrumentTag: "Flamingos2" },
  },

  // --- GNIRS --------------------------------------------------------------------------
  {
    key: "gnirs-imaging",
    title: "GNIRS imaging",
    modeType: "GNIRS_IMAGING",
    check: "sequence",
    target: "nearIr",
    // "A 'camera' is required on creation", though the schema marks it optional.
    observingMode: {
      gnirsImaging: {
        variant: { grouped: {} },
        filters: [{ filter: "K" }],
        camera: "SHORT_BLUE",
      },
    },
    scienceRequirements: imaging(2200),
    explore: { configMode: "Imaging", instrument: "GNIRS", instrumentTag: "Gnirs" },
  },
  {
    key: "gnirs-long-slit",
    title: "GNIRS long slit",
    modeType: "GNIRS_LONG_SLIT",
    check: "sequence",
    target: "nearIr",
    observingMode: {
      gnirsSpectroscopy: {
        centralWavelengths: [{ centralWavelength: nm(1650) }],
        filter: "ORDER4",
        camera: "SHORT_BLUE",
        grating: "D32",
        prism: "MIRROR",
        slit: { fpu: "LONG_SLIT_0_30" },
      },
    },
    scienceRequirements: spectroscopy(1650),
    explore: {
      configMode: "Spectroscopy",
      instrument: "GNIRS",
      instrumentTag: "Gnirs",
      focalPlane: "single_slit",
    },
  },
  {
    key: "gnirs-ifu",
    title: "GNIRS IFU",
    modeType: "GNIRS_IFU",
    check: "sequence",
    target: "nearIr",
    observingMode: {
      gnirsSpectroscopy: {
        centralWavelengths: [{ centralWavelength: nm(1650) }],
        filter: "ORDER4",
        camera: "SHORT_BLUE",
        grating: "D32",
        prism: "MIRROR",
        ifu: { fpu: "LOW_RESOLUTION" },
      },
    },
    scienceRequirements: spectroscopy(1650, { focalPlane: "IFU" }),
    explore: {
      configMode: "Spectroscopy",
      instrument: "GNIRS",
      instrumentTag: "Gnirs",
      focalPlane: "ifu",
    },
  },

  // --- IGRINS-2, GHOST ----------------------------------------------------------------
  {
    key: "igrins2-long-slit",
    title: "IGRINS-2 long slit",
    modeType: "IGRINS_2_LONG_SLIT",
    check: "sequence",
    target: "bright",
    // IGRINS-2 has no instrument configuration: the mode is the whole H+K spectrum.
    observingMode: { igrins2LongSlit: {} },
    scienceRequirements: spectroscopy(2200, { resolution: 45000 }),
    explore: {
      configMode: "Spectroscopy",
      instrument: "IGRINS-2",
      instrumentTag: "Igrins2",
      focalPlane: "single_slit",
    },
  },
  {
    key: "ghost-ifu",
    title: "GHOST IFU",
    modeType: "GHOST_IFU",
    check: "sequence",
    target: "bright",
    // resolutionMode is documented "must be specified". The ODB refuses GHOST unless both
    // channels carry a TimeAndCount exposure mode at the same wavelength, so the requirements
    // use TimeAndCount too.
    observingMode: {
      ghostIfu: {
        resolutionMode: "STANDARD",
        red: { exposureTimeMode: GHOST_EXPOSURE },
        blue: { exposureTimeMode: GHOST_EXPOSURE },
      },
    },
    scienceRequirements: {
      ...spectroscopy(600, { resolution: 50000, focalPlane: "IFU" }),
      exposureTimeMode: GHOST_EXPOSURE,
    },
    explore: {
      configMode: "Spectroscopy",
      instrument: "GHOST",
      instrumentTag: "Ghost",
      focalPlane: "ifu",
    },
  },

  // --- No calculation: create and read back -------------------------------------------
  {
    key: "visitor",
    title: "visitor",
    modeType: "VISITOR_NORTH",
    check: "created",
    observingMode: {
      visitor: {
        mode: "VISITOR_NORTH",
        name: "gpp-tests visitor",
        centralWavelength: nm(500),
        // Both "not optional" on create, though nullable in the schema.
        agsDiameter: { arcseconds: 60 },
        scienceFovDiameter: { arcseconds: 60 },
        totalRequestTime: { hours: 1 },
      },
    },
    // Explore's visitor editor starts empty and Accept stays disabled until every field is
    // set, so this is the one mode whose browser side types values rather than taking
    // defaults. Same values as the k6 side.
    explore: {
      configMode: "Visitor",
      visitor: {
        site: "GN",
        name: "gpp-tests visitor",
        centralWavelength: "500",
        agsDiameter: "60",
        scienceFovDiameter: "60",
        totalTime: "1:00",
      },
    },
  },
  {
    key: "exchange-keck",
    title: "Keck exchange",
    modeType: "EXCHANGE_KECK",
    check: "created",
    observingMode: {
      exchange: { keckInstrument: "HIRES", totalRequestTime: { hours: 1 } },
    },
    explore: { configMode: "Keck" },
  },
  {
    key: "exchange-subaru",
    title: "Subaru exchange",
    modeType: "EXCHANGE_SUBARU",
    check: "created",
    observingMode: {
      exchange: { subaruInstrument: "HSC", totalRequestTime: { hours: 1 } },
    },
    explore: { configMode: "Subaru" },
  },
];

/** The e2e test title for a mode — the parity catalog lists these verbatim. */
export function modeTestTitle(/** @type {ObservingModeFixture} */ mode) {
  return `observing mode: ${mode.title}`;
}

/**
 * Structural problems in a fixture table: duplicate keys, a `sequence` mode without a
 * target or requirements, an `ObservingModeInput` that sets anything but exactly one mode.
 *
 * @param {ObservingModeFixture[]} modes
 * @returns {string[]}
 */
export function fixtureProblems(modes) {
  const problems = [];
  const keys = new Set();
  for (const m of modes) {
    if (keys.has(m.key)) problems.push(`duplicate key: ${m.key}`);
    keys.add(m.key);
    const set = Object.keys(m.observingMode);
    if (set.length !== 1) {
      problems.push(`${m.key}: observingMode sets ${set.length} modes, not exactly one`);
    }
    if (m.check === "sequence" && (!m.target || !m.scienceRequirements)) {
      problems.push(`${m.key}: a sequence mode needs a target and science requirements`);
    }
    if (m.expectedFailure && (!m.expectedFailure.reason || !m.expectedFailure.link)) {
      problems.push(`${m.key}: expectedFailure needs a reason and a link`);
    }
  }
  return problems;
}
