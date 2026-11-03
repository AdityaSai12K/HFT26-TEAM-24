"""Draw a synthetic bench photo with known wiring.

Used for two things: ground truth in the tests, and the sample scenes in the
dashboard, which let it run with no hardware or camera. The wire and breadboard
stages run on these images for real. Only the parts come from the script.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np

from .boards import load_pinout

PITCH = 16
CANVAS = (900, 1280, 3)
DESK = (150, 175, 195)
PLASTIC = (235, 238, 240)
TEAL = (130, 95, 0)
WIRE_BGR = {"red": (40, 40, 215), "yellow": (40, 215, 225), "green": (60, 170, 40), "blue": (210, 90, 20), "orange": (30, 120, 240), "purple": (170, 50, 140)}

BB_COLUMNS = 30
BB_LEFT, BB_TOP = 590, 240
ROWS = [0, 1, 2, 3, 4, 7, 8, 9, 10, 11]
RAILS = [-4.9, -3.9, 14.9, 15.9]

UNO_LEFT, UNO_TOP = 90, 200
UNO_SCALE = PITCH / 100  # Pixels per mil.


@dataclass
class Part:
    kind: str
    a: str
    b: str


@dataclass
class Scenario:
    name: str
    title: str
    #: Wires as (colour, from node, to node).
    wires: list[tuple[str, str, str]]
    parts: list[Part] = field(default_factory=list)
    #: A wire end stopped short of its target: (colour, from node, near node, gap in pitches).
    loose: list[tuple[str, str, str, float]] = field(default_factory=list)


def uno_quad() -> np.ndarray:
    w, h = 2700 * UNO_SCALE, 2100 * UNO_SCALE
    return np.array([[UNO_LEFT, UNO_TOP], [UNO_LEFT + w, UNO_TOP], [UNO_LEFT + w, UNO_TOP + h], [UNO_LEFT, UNO_TOP + h]], dtype=np.float64)


def node_xy(node: str, row: int = 3) -> tuple[float, float]:
    """Image position of a node. Parts sit on a different row of the column than wires."""
    kind, *rest = node.split(":")
    if kind == "pin":
        pin = next(p for p in load_pinout("arduino_uno")["pins"] if p["id"] == rest[0])
        return UNO_LEFT + pin["u"] * 2700 * UNO_SCALE, UNO_TOP + pin["v"] * 2100 * UNO_SCALE
    if kind == "bb":
        column, side = int(rest[0]), rest[1]
        return BB_LEFT + (column - 1) * PITCH, BB_TOP + (row if side == "top" else row + 7) * PITCH
    side, position = rest[0].split("-")
    row = {("top", "outer"): RAILS[0], ("top", "inner"): RAILS[1], ("bottom", "inner"): RAILS[2], ("bottom", "outer"): RAILS[3]}[(side, position)]
    return BB_LEFT + 6 * PITCH, BB_TOP + row * PITCH


def _breadboard(image: np.ndarray) -> None:
    top_left = (BB_LEFT - 2 * PITCH, int(BB_TOP - 6.2 * PITCH))
    bottom_right = (BB_LEFT + (BB_COLUMNS + 1) * PITCH, int(BB_TOP + 17.2 * PITCH))
    cv2.rectangle(image, top_left, bottom_right, PLASTIC, -1)
    cv2.rectangle(image, (top_left[0], BB_TOP + int(4.8 * PITCH)), (bottom_right[0], BB_TOP + int(6.2 * PITCH)), (222, 225, 228), -1)
    for column in range(BB_COLUMNS):
        x = BB_LEFT + column * PITCH
        for row in ROWS:
            cv2.rectangle(image, (x - 2, BB_TOP + row * PITCH - 2), (x + 2, BB_TOP + row * PITCH + 2), (45, 45, 45), -1)
        for row in RAILS:
            y = int(BB_TOP + row * PITCH)
            cv2.rectangle(image, (x - 2, y - 2), (x + 2, y + 2), (45, 45, 45), -1)
    for row, colour in ((-5.7, (40, 40, 200)), (-3.1, (190, 90, 20)), (14.1, (40, 40, 200)), (16.7, (190, 90, 20))):
        y = int(BB_TOP + row * PITCH)
        cv2.line(image, (BB_LEFT - PITCH, y), (BB_LEFT + BB_COLUMNS * PITCH, y), colour, 2)


def _uno(image: np.ndarray) -> None:
    quad = uno_quad().astype(np.int32)
    cv2.fillConvexPoly(image, quad, TEAL)
    x, y = UNO_LEFT, UNO_TOP
    cv2.rectangle(image, (x - 32, y + 80), (x + 60, y + 170), (170, 170, 170), -1)
    cv2.rectangle(image, (x - 12, y + 250), (x + 70, y + 320), (20, 20, 20), -1)
    for pin in load_pinout("arduino_uno")["pins"]:
        px, py = int(x + pin["u"] * 2700 * UNO_SCALE), int(y + pin["v"] * 2100 * UNO_SCALE)
        cv2.rectangle(image, (px - 8, py - 8), (px + 8, py + 8), (25, 25, 25), -1)
        cv2.circle(image, (px, py), 3, (60, 60, 60), -1)


def _wire(image: np.ndarray, colour: str, start, end, bow: float) -> None:
    """An arc, as a real jumper makes. `bow` is the sideways bulge in pixels."""
    a, b = np.array(start, dtype=np.float64), np.array(end, dtype=np.float64)
    middle = (a + b) / 2
    normal = np.array([-(b - a)[1], (b - a)[0]])
    length = np.linalg.norm(normal)
    bulge = normal / max(length, 1) * bow
    t = np.linspace(0, 1, 60)[:, None]
    curve = ((1 - t) ** 2) * a + 2 * (1 - t) * t * (middle + bulge) + t ** 2 * b
    cv2.polylines(image, [curve.astype(np.int32)], False, WIRE_BGR[colour], 7, cv2.LINE_AA)


def _part(image: np.ndarray, part: Part) -> tuple[int, int, int, int]:
    a, b = np.array(node_xy(part.a, row=1)), np.array(node_xy(part.b, row=1))
    cv2.line(image, tuple(a.astype(int).tolist()), tuple(b.astype(int).tolist()), (150, 150, 150), 2)
    center = ((a + b) / 2).astype(int)
    x, y = int(center[0]), int(center[1])
    if part.kind == "resistor":
        cv2.rectangle(image, (x - 18, y - 6), (x + 18, y + 6), (120, 180, 215), -1)
        for offset, band in ((-10, (20, 20, 150)), (-3, (20, 20, 150)), (4, (30, 80, 120))):
            cv2.line(image, (x + offset, y - 6), (x + offset, y + 6), band, 3)
    elif part.kind == "led":
        cv2.circle(image, (x, y), 12, (30, 30, 225), -1)
        cv2.circle(image, (x - 3, y - 3), 3, (160, 160, 255), -1)
    elif part.kind == "button":
        cv2.rectangle(image, (x - 18, y - 18), (x + 18, y + 18), (35, 35, 35), -1)
        cv2.circle(image, (x, y), 9, (90, 90, 90), -1)
    half = 20
    return x - half, y - half, x + half, y + half


def render(scenario: Scenario, noise: float = 4.0, seed: int = 0) -> tuple[np.ndarray, list[dict]]:
    """Returns the image and the parts, with their boxes and true terminals."""
    image = np.full(CANVAS, DESK, np.uint8)
    _breadboard(image)
    _uno(image)
    parts = []
    for part in scenario.parts:
        box = _part(image, part)
        parts.append({"kind": part.kind, "box": box, "terminals": [part.a, part.b]})
    bows = iter([70, -70, 130, -130, 180])
    for colour, start, end in scenario.wires:
        _wire(image, colour, node_xy(start), node_xy(end), next(bows))
    for colour, start, near, gap in scenario.loose:
        a, b = np.array(node_xy(start)), np.array(node_xy(near))
        stop = b + (a - b) / np.linalg.norm(a - b) * gap * PITCH
        _wire(image, colour, a, stop, next(bows))
    if noise:
        grain = np.random.default_rng(seed).normal(0, noise, image.shape)
        image = np.clip(image.astype(np.float64) + grain, 0, 255).astype(np.uint8)
    return image, parts


SCENARIOS = [
    Scenario(
        "blink-ok", "LED Blink, wired correctly",
        wires=[("yellow", "pin:D13", "bb:8:top"), ("green", "pin:GND3", "bb:14:top")],
        parts=[Part("resistor", "bb:8:top", "bb:11:top"), Part("led", "bb:11:top", "bb:14:top")],
    ),
    Scenario(
        "no-resistor", "LED with no resistor",
        wires=[("yellow", "pin:D13", "bb:8:top"), ("green", "pin:GND3", "bb:11:top")],
        parts=[Part("led", "bb:8:top", "bb:11:top")],
    ),
    Scenario(
        "short", "5V shorted to GND through a rail",
        wires=[("red", "pin:5V", "rail:bottom-inner"), ("orange", "pin:GND1", "bb:12:bottom"), ("purple", "rail:bottom-inner", "bb:12:bottom")],
    ),
    Scenario(
        "rails-joined", "Wire across the + and - rails",
        wires=[("red", "rail:top-outer", "rail:bottom-outer")],
    ),
    Scenario(
        "approach-far", "5V wire heading for GND",
        wires=[("green", "pin:GND1", "bb:12:bottom")],
        loose=[("red", "pin:5V", "bb:12:bottom", 2.6)],
    ),
    Scenario(
        "approach-near", "5V wire about to reach GND",
        wires=[("green", "pin:GND1", "bb:12:bottom")],
        loose=[("red", "pin:5V", "bb:12:bottom", 1.2)],
    ),
    Scenario(
        "approach-touch", "5V wire lands on the GND column",
        wires=[("green", "pin:GND1", "bb:12:bottom"), ("red", "pin:5V", "bb:12:bottom")],
    ),
]
