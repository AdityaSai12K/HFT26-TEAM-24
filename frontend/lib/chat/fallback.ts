import type { Pin, Pinout } from "../types";
import type { ChatContext } from "./context";
import { mentionedPins } from "./grounding";

function describePin(pin: Pin): string {
  const uses = pin.functions.length ? pin.functions.join(", ") : "no listed function";
  const notes = pin.tags?.includes("flash") ? " Connected to the SPI flash, so do not use it." : "";
  return `${pin.label}: ${uses}.${notes}`;
}

/** Answers from rule results and the pinout alone, for when the LLM is down, slow or off-script. */
export function fallbackAnswer(question: string, context: ChatContext, pinout: Pinout | null): string {
  const lines: string[] = [];

  const asked = mentionedPins(question);
  if (asked.length && pinout) {
    for (const token of asked) {
      const pin = pinout.pins.find((p) => [p.id, p.label, ...p.label.split("/")].some((n) => n.toUpperCase() === token));
      lines.push(pin ? describePin(pin) : `${token} is not a pin on the ${pinout.name}.`);
    }
  }

  const failures = context.rules.filter((r) => r.status === "fail");
  const unclear = context.rules.filter((r) => r.status === "unclear");
  for (const r of failures) lines.push(`Failed, ${r.title}: ${r.reason}${r.fix ? ` Fix: ${r.fix}` : ""}`);
  for (const r of unclear) lines.push(`Check by eye, ${r.title}: ${r.reason}`);

  if (!failures.length && !unclear.length) {
    lines.push(context.rules.length ? "All automated checks passed." : "Nothing has been inspected yet.");
  }
  return lines.join("\n");
}
