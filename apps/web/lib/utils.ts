import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

const ASCII_DIGIT = /^[0-9]$/;

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function sanitizeDecimalInput(value: string): string {
  let sanitized = "";
  let hasDecimalSeparator = false;

  for (const character of value) {
    if (ASCII_DIGIT.test(character)) {
      sanitized += character;
    } else if (character === "." && !hasDecimalSeparator) {
      sanitized += character;
      hasDecimalSeparator = true;
    }
  }

  return sanitized;
}

export function sanitizeIntegerInput(value: string): string {
  let sanitized = "";

  for (const character of value) {
    if (ASCII_DIGIT.test(character)) {
      sanitized += character;
    }
  }

  return sanitized;
}
