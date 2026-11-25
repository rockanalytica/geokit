import { expect, it } from "vitest";
import { cn } from "./cn";

it("merges and de-duplicates tailwind utilities", () => {
  expect(cn("p-2", "p-4", false && "hidden", "text-fg")).toBe("p-4 text-fg");
});
