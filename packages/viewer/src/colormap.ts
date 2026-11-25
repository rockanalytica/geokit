// Colormaps and lookup tables. The default continuous
// map, Ember, climbs steadily in lightness and stays out of the brand's
// blue–purple band, so data never looks like UI. Categorical defaults are the
// Okabe–Ito set, safe for the common colour-vision deficiencies.

export interface Colormap {
  name: string;
  kind: "sequential" | "diverging" | "cyclic" | "categorical";
  /** Colours as [r, g, b] in 0–255. Continuous maps are sampled at these stops. */
  colors: [number, number, number][];
}

/** Colours given as 6-digit hex, run together. */
export function unpackHex(run: string): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let i = 0; i + 6 <= run.length; i += 6) {
    const n = Number.parseInt(run.slice(i, i + 6), 16);
    out.push([(n >> 16) & 255, (n >> 8) & 255, n & 255]);
  }
  return out;
}

/**
 * Ember: deep maroon → red → orange → pale cream, 64 stops, the default
 * sequential map. Kept dark to light, the way it has always been stored, so
 * a Colouring saved as reversed still runs the way it did.
 */
export const EMBER: Colormap = {
  name: "Ember",
  kind: "sequential",
  colors: unpackHex(
    "5b19106119106619106c19107119107718107d18108317108916108e151094130f9a120f" +
      "a0100ea5120ea81b0faa2210ad2910b02e11b23411b53912b83e13ba4313bd4714bf4c15" +
      "c25115c45516c75918c95e1acc621cce661fd16a21d36e23d57225d87627da7b29dd7f2b" +
      "df832de1872fe38b33e3903ae39541e49a48e49f4ee4a455e3a95be3ad61e3b266e3b76c" +
      "e2bc72e2c077e1c57de2c984e4cd8ce5d095e7d39de9d7a5eadaadecdeb5eee1bcefe4c4" +
      "f1e8ccf3ebd4f4efdbf6f2e3",
  ),
};

/** Okabe–Ito, safe for the common colour-vision deficiencies; a larger legend cycles through it. */
export const OKABE_ITO: Colormap = {
  name: "Okabe–Ito",
  kind: "categorical",
  colors: unpackHex("e69f0056b4e9009e73f0e4420072b2d55e00cc79a7000000"),
};

/**
 * Viridis, the perceptual sequential map: dark purple → blue-green → yellow,
 * rising steadily in lightness and printing well in grey. 64 stops sampled
 * evenly from its 256 values. Source: Nathaniel J. Smith, Stefan van der Walt
 * and Eric Firing's matplotlib colormaps (github.com/BIDS/colormap), released
 * under CC0 1.0 / public domain; credit requested, not required.
 */
export const VIRIDIS: Colormap = {
  name: "Viridis",
  kind: "sequential",
  colors: unpackHex(
    "44015446075a470d6047136548186a481d6f482374482878472d7b46327e453781433d84" +
      "4241864046883e4a893c4f8a3a538b38588c365c8d34608d32648e31688e2f6c8e2d708e" +
      "2c738e2a778e297b8e277f8e26828e24868e238a8d218e8d20928c1f968b1f9a8a1f9e89" +
      "1fa18721a58523a98326ad812ab07f2fb47c35b7793bbb7542be714ac16d52c5695ac864" +
      "63cb5f6ccd5a75d0547fd34e89d54895d840a0da39aadc32b5de2bc0df25cae11fd5e21a" +
      "dfe318eae51af4e61efde725",
  ),
};

/**
 * Blue–Orange, a diverging map: dark blue → pale neutral → dark orange, the
 * ends equally dark so neither side outweighs the other, and safe for the
 * common colour-vision deficiencies (blue against orange). Its middle is the
 * pale neutral, at 0.5: centre the colour range on the value that means "no
 * difference" with `symmetricRange`. Made for the kit: 33 stops computed in
 * OKLab (Björn Ottosson, 2020; public domain) with lightness falling and
 * chroma rising from the middle to each end, chroma reduced where sRGB cannot
 * hold it. Apache-2.0 with the rest of the kit.
 */
export const BLUE_ORANGE: Colormap = {
  name: "Blue–Orange",
  kind: "diverging",
  colors: unpackHex(
    "00468c09519b095baf2367b73673be467fc5568acb6695d276a1d885acde95b7e3a4c2e8" +
      "b4ccecc3d7f0d3e0f3e2eaf4f2f2f2f3e6e0f0daceeccebde7c1ace2b49bdba78ad59a79" +
      "ce8d68c67f57be7245b66431ae561aa24a01914305813b06713405",
  ),
};

/**
 * Cycle, a cyclic map for values that wrap — an azimuth, a phase, a time of
 * day: its last stop runs on into its first, so 360° and 0° are one colour.
 * Hue goes once round while lightness swings once, so the two halves tell
 * apart in grey. Made for the kit: 48 stops computed in OKLab (Björn
 * Ottosson, 2020; public domain), chroma reduced where sRGB cannot hold it.
 * Apache-2.0 with the rest of the kit. The stops do not repeat the first at
 * the end; `buildLut` and `sampleColormap` close the circle.
 */
export const CYCLE: Colormap = {
  name: "Cycle",
  kind: "cyclic",
  colors: unpackHex(
    "fea8a7fda499fe9e86f79c77ee9a69e5985cda964ece9442c29238b5902fa78f29998d26" +
      "8b8c277d8b2c6e8a325f8a3a4f89423e894b2a8955098a5f0d896b0689750d897e058b88" +
      "0a8d92178f9d1892a90a96b91f98c63a9bd1509ddb63a0e475a2ec86a4f397a6f8a7a8fc" +
      "b6aaffc4acfcd2acfedeacfbe9acf7f2acf0faace9feaddffeafd4feafcaffadbffeabb4",
  ),
};

type Rgb = [number, number, number];

/**
 * A colormap at `t` in 0–1, as [r, g, b] 0–255 and not rounded. Sequential
 * and diverging maps are clamped to their ends; a cyclic map wraps, its last
 * stop running on into its first; a categorical one has no between: t
 * picks the colour whose band it falls in.
 */
export function sampleColormap(map: Colormap, t: number): Rgb {
  const n = map.colors.length;
  if (n === 0) return [0, 0, 0];
  const at = (i: number): Rgb => map.colors[i] ?? [0, 0, 0];
  if (n === 1) return at(0);
  if (map.kind === "categorical") return at(Math.min(n - 1, Math.max(0, Math.floor(t * n))));
  let x: number;
  let k: number;
  let next: number;
  if (map.kind === "cyclic") {
    const w = (((t % 1) + 1) % 1) * n;
    k = Math.floor(w);
    x = w - k;
    next = (k + 1) % n;
  } else {
    const w = Math.min(1, Math.max(0, t)) * (n - 1);
    k = Math.min(n - 2, Math.floor(w));
    x = w - k;
    next = k + 1;
  }
  const a = at(k);
  const b = at(next);
  return [a[0] + (b[0] - a[0]) * x, a[1] + (b[1] - a[1]) * x, a[2] + (b[2] - a[2]) * x];
}

/**
 * Resample a map into an RGBA table of `size` entries. A categorical map
 * repeats its colours round the table. A cyclic one runs once round it: the
 * last entry is one step short of the first, so a table repeated end to end
 * has no seam. A table of one entry holds a diverging map's middle, and any
 * other map's first colour.
 */
export function buildLut(map: Colormap, size = 256): Uint8Array {
  const out = new Uint8Array(size * 4);
  const n = map.colors.length;
  for (let i = 0; i < size; i++) {
    let rgb: Rgb;
    if (map.kind === "categorical") {
      rgb = map.colors[i % Math.max(1, n)] ?? [0, 0, 0];
    } else if (map.kind === "cyclic") {
      rgb = sampleColormap(map, i / size);
    } else if (size === 1) {
      rgb = sampleColormap(map, map.kind === "diverging" ? 0.5 : 0);
    } else {
      rgb = sampleColormap(map, i / (size - 1));
    }
    out[i * 4] = Math.round(rgb[0]);
    out[i * 4 + 1] = Math.round(rgb[1]);
    out[i * 4 + 2] = Math.round(rgb[2]);
    out[i * 4 + 3] = 255;
  }
  return out;
}

/**
 * A colour range centred on `centre`, wide enough for `range`: what a
 * diverging map needs for its neutral middle to mean the centre. [-3, 10]
 * about 0 is [-10, 10].
 */
export function symmetricRange(range: [number, number], centre = 0): [number, number] {
  const half = Math.max(Math.abs(range[0] - centre), Math.abs(range[1] - centre));
  return [centre - half, centre + half];
}

/** Relative luminance of an sRGB colour, for uniformity checks. */
export function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
