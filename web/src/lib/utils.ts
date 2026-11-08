// Class-name composition shared by every component.
import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Later classes win over earlier ones, so a caller's className overrides a variant. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
