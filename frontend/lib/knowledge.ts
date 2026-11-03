import type { ComponentKind } from "./types";

export interface ComponentFacts {
  name: string;
  role: string;
  features: string[];
  ratings?: string;
  tip: string;
}

export const COMPONENTS: Record<ComponentKind, ComponentFacts> = {
  arduino_uno: {
    name: "Arduino Uno R3",
    role: "5 V ATmega328P development board.",
    features: ["14 digital pins", "6 analog inputs", "USB programming"],
    ratings: "5 V logic. 20 mA recommended per pin.",
    tip: "Align the pins so wires reaching this board can be checked.",
  },
  esp32: {
    name: "ESP32 board",
    role: "3.3 V Wi-Fi and Bluetooth development board.",
    features: ["Dual-core MCU", "Wi-Fi and Bluetooth", "ADC, DAC, touch"],
    ratings: "3.3 V logic. GPIOs are not 5 V tolerant.",
    tip: "Avoid GPIO6-11, which connect to the SPI flash.",
  },
  microcontroller: {
    name: "Integrated circuit",
    role: "A chip such as a microcontroller.",
    features: ["Pin 1 is marked by a dot or notch"],
    tip: "Check the orientation against the datasheet before powering up.",
  },
  pin_header: {
    name: "Pin header",
    role: "Row of connection points on a board.",
    features: ["2.54 mm pitch"],
    tip: "Seat jumpers fully, because a loose pin looks connected but is not.",
  },
  usb_port: {
    name: "USB port",
    role: "Power and programming connection.",
    features: ["Supplies 5 V", "Carries serial data"],
    ratings: "5.5 V maximum on the Uno.",
    tip: "Unplug this first whenever you change the wiring.",
  },
  led: {
    name: "LED",
    role: "Lights up when current flows from anode to cathode.",
    features: ["Polarised", "Long leg is the anode", "Flat rim marks the cathode"],
    ratings: "Typically about 20 mA. Always needs a series resistor.",
    tip: "If it stays dark, try reversing it, and check the resistor is in series.",
  },
  resistor: {
    name: "Resistor",
    role: "Limits current, for example through an LED.",
    features: ["Not polarised", "Value is read from the colour bands"],
    ratings: "220 ohm to 1 k suits most LEDs on 5 V.",
    tip: "Both legs must be in different columns, or it is shorted out.",
  },
  capacitor: {
    name: "Capacitor",
    role: "Stores charge and smooths supply noise.",
    features: ["Electrolytics are polarised", "The stripe marks the negative leg"],
    ratings: "The rated voltage must exceed the supply.",
    tip: "Check the polarity of electrolytics before powering up.",
  },
  button: {
    name: "Pushbutton",
    role: "Connects its two sides while pressed.",
    features: ["Pairs of legs are joined internally", "Should straddle the centre channel"],
    tip: "Use INPUT_PULLUP so the pin does not float when the button is open.",
  },
  jumper_wire: {
    name: "Jumper wire",
    role: "Connects two points.",
    features: ["Colour has no electrical meaning"],
    tip: "Use red for power and black for ground so mistakes are easier to spot.",
  },
  breadboard: {
    name: "Breadboard",
    role: "Prototyping board with connected columns and power rails.",
    features: ["Columns a-e and f-j are separate", "Rails may be split at the middle"],
    tip: "Test rail continuity. Some boards split the rails halfway along.",
  },
  unknown: {
    name: "Unknown part",
    role: "Could not be identified.",
    features: [],
    tip: "Use the component dropdown to name it.",
  },
};

export const KIND_OPTIONS = Object.entries(COMPONENTS).map(([kind, facts]) => ({
  kind: kind as ComponentKind,
  name: facts.name,
}));
