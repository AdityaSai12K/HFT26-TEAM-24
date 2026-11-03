import unoJson from "@/data/pinouts/arduino_uno.json";
import espJson from "@/data/pinouts/esp32_devkitc.json";
import blinkJson from "@/data/projects/led-blink.json";
import buttonLedJson from "@/data/projects/button-led.json";
import type { BoardId, Pinout, Project } from "./types";

export const PINOUTS: Record<BoardId, Pinout> = {
  arduino_uno: unoJson as unknown as Pinout,
  esp32_devkitc: espJson as unknown as Pinout,
};

export const PROJECTS: Project[] = [blinkJson as Project, buttonLedJson as Project];
