import { twMerge } from 'tailwind-merge';

type ClassValue = string | undefined | null | false | ClassValue[];

function flatten(input: ClassValue): string {
  if (!input) return '';
  if (Array.isArray(input)) return input.map(flatten).filter(Boolean).join(' ');
  return input;
}

export function cn(...inputs: ClassValue[]): string {
  return twMerge(inputs.map(flatten).filter(Boolean).join(' '));
}