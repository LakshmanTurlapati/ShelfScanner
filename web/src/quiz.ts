import type { ProfilePick } from "./profile";

export const QUIZ_PAIRS: readonly (readonly [string, string])[] = [
  ["The Hobbit", "Dune"],
  ["Pride and Prejudice", "Frankenstein"],
  ["The Left Hand of Darkness", "The Name of the Wind"],
  ["Beloved", "The Road"],
  ["Circe", "The Midnight Library"],
];

export function picksFrom(choices: readonly (string | undefined)[]): ProfilePick[] {
  return QUIZ_PAIRS.flatMap((pair, index) => {
    const choice = choices[index];
    if (!choice || !pair.includes(choice)) return [];
    const over = pair.find((title) => title !== choice);
    return over ? [{ prefer: choice, over }] : [];
  });
}
