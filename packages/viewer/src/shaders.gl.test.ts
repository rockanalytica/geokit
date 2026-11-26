// Opt-in: compiles and runs the shaders in a real browser, headless, on its
// software GL (SwiftShader). Skipped unless GEOKIT_BROWSER names a Chromium
// based browser's executable (Chrome, Edge, Chromium):
//
//   $env:GEOKIT_BROWSER = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
//   pnpm --filter @geokit/viewer test -- shaders.gl
//
// It serves the playground with Vite, opens it with `?selftest` and reads back
// what the page wrote: that every program linked with no error logged, and
// that a sweep of picks found blocks and the mesh, fewer of them under a clip
// box. No new dependency: Vite is the playground's own.

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const browser = process.env.GEOKIT_BROWSER;

interface Selftest {
  ok: boolean;
  errors: string[];
  programs: number;
  open: Record<string, number>;
  boxed: Record<string, number>;
  cutOut: Record<string, number>;
  resident: number;
  marked: number;
  cameras: number;
  glError: number;
}

describe.skipIf(!browser)("the shaders in a browser", () => {
  it("link, draw and pick", { timeout: 120_000 }, async () => {
    const { createServer } = await import("vite");
    const root = fileURLToPath(new URL("../playground", import.meta.url));
    const server = await createServer({
      root,
      logLevel: "error",
      server: { port: 0, strictPort: false },
    });
    await server.listen();
    const address = server.httpServer?.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const profile = mkdtempSync(join(tmpdir(), "geokit-browser-"));
    try {
      const { stdout } = await promisify(execFile)(
        browser as string,
        [
          "--headless=new",
          "--use-angle=swiftshader",
          "--enable-unsafe-swiftshader",
          "--ignore-gpu-blocklist",
          `--user-data-dir=${profile}`,
          "--window-size=1000,700",
          "--virtual-time-budget=20000",
          "--dump-dom",
          `http://localhost:${port}/?selftest`,
        ],
        { maxBuffer: 16 * 1024 * 1024, timeout: 100_000 },
      );
      const text = /<pre id="result"[^>]*>([^<]*)<\/pre>/.exec(stdout)?.[1];
      expect(text, "the page wrote no result").toBeTruthy();
      const r = JSON.parse((text ?? "").replaceAll("&quot;", '"')) as Selftest;
      expect(r.errors).toEqual([]);
      expect(r.ok).toBe(true);
      expect(r.glError).toBe(0);
      expect(r.programs).toBeGreaterThan(5);
      expect(r.open.element ?? 0).toBeGreaterThan(0);
      expect(r.open.mesh ?? 0).toBeGreaterThan(0);
      // a clip box takes some of the blocks away, and cutting it out takes more
      expect(r.cutOut.element ?? 0).toBeLessThan(r.open.element ?? 0);
      expect(r.cutOut.mesh ?? 0).toBe(0);
      // the lasso marked points, and the second look drew with no error
      expect(r.marked).toBeGreaterThan(0);
      expect(r.cameras).toBeGreaterThan(0);
    } finally {
      await server.close();
      rmSync(profile, { recursive: true, force: true });
    }
  });
});
