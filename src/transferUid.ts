import { randomInt } from "crypto";

export function generate11DigitId(): string {
  const timestamp = Date.now().toString().slice(-8); // last 8 digits
  const randomPart = randomInt(0, 1000).toString().padStart(3, "0");

  return timestamp + randomPart; // always 11 digits
}