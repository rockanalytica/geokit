import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge class names, letting later Tailwind utilities win. The shadcn/ui convention. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
