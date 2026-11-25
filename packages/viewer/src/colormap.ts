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

/** Resample a continuous map into an RGBA table of `size` entries. */
export function buildLut(map: Colormap, size = 256): Uint8Array {
  const out = new Uint8Array(size * 4);
  const n = map.colors.length;
  for (let i = 0; i < size; i++) {
    let rgb: [number, number, number];
    if (map.kind === "categorical") {
      rgb = map.colors[i % n] ?? [0, 0, 0];
    } else {
      const t = (i / (size - 1)) * (n - 1);
      const k = Math.min(n - 2, Math.floor(t));
      const f = t - k;
      const a = map.colors[k] ?? [0, 0, 0];
      const b = map.colors[k + 1] ?? a;
      rgb = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
    }
    out[i * 4] = Math.round(rgb[0]);
    out[i * 4 + 1] = Math.round(rgb[1]);
    out[i * 4 + 2] = Math.round(rgb[2]);
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** Relative luminance of an sRGB colour, for uniformity checks. */
export function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
