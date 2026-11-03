"""Board regions and pin mapping.

Pins are only mapped from a user alignment, never guessed. Automatic placement
was tried and rejected: on real photos, chips, shadows and dark PCBs produced
fits that passed every check while being rotated, and a wrong map labels a 5V
wire as D0. A photo also cannot separate a 38-pin DevKitC from a 30-pin clone.
Three clicked pins solve both problems, and they can be checked against the
board's known geometry.
"""
from __future__ import annotations

import json
from pathlib import Path

import cv2
import numpy as np

from .geometry import largest_component, project

DATA_DIR = Path(__file__).resolve().parents[2] / "frontend" / "data" / "pinouts"

#: A board is a profile in the pinout folder, so adding one needs no change here.
BOARD_IDS = tuple(sorted(path.stem for path in DATA_DIR.glob("*.json")))
_cache: dict[str, dict] = {}


def load_pinout(board_id: str) -> dict:
    if board_id not in _cache:
        _cache[board_id] = json.loads((DATA_DIR / f"{board_id}.json").read_text(encoding="utf-8"))
    return _cache[board_id]


def pcb_region(board_id: str, bgr: np.ndarray, breadboard_quad: np.ndarray | None = None) -> np.ndarray | None:
    """PCB area. Used for the detection box and to keep silkscreen out of the wire tracer."""
    pcb = load_pinout(board_id)["vision"]["pcb"]
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    if pcb["type"] == "colour":
        raw = cv2.inRange(hsv, tuple(pcb["hsvLow"]), tuple(pcb["hsvHigh"]))
        if breadboard_quad is not None:
            # A bluish white balance on the plastic must not merge into the PCB blob.
            cv2.fillConvexPoly(raw, breadboard_quad.astype(np.int32), 0)
        return _solid_region(raw, bgr.shape)
    raw = ((hsv[..., 2] < pcb["maxValue"]) * 255).astype(np.uint8)
    if breadboard_quad is not None:
        inside = np.zeros(raw.shape, np.uint8)
        cv2.fillConvexPoly(inside, breadboard_quad.astype(np.int32), 255)
        # A dark board is usually plugged into the breadboard, so only look there when one is present.
        raw = cv2.bitwise_and(raw, inside)
    return _solid_region(raw, bgr.shape)


def recognise_pcb(bgr: np.ndarray, breadboard_quad: np.ndarray | None = None) -> tuple[str, np.ndarray, str] | None:
    """A board whose PCB colour is distinctive enough to name it when CLIP cannot."""
    for board_id in BOARD_IDS:
        evidence = load_pinout(board_id)["vision"].get("pcbEvidence")
        region = pcb_region(board_id, bgr, breadboard_quad) if evidence else None
        if region is not None:
            return board_id, region, evidence
    return None


def _solid_region(raw: np.ndarray, shape) -> np.ndarray | None:
    size = max(7, int(max(shape[:2]) * 0.03)) | 1
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (size, size))
    opened = cv2.morphologyEx(raw, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
    mask = largest_component(cv2.morphologyEx(opened, cv2.MORPH_CLOSE, kernel))
    if mask is None or cv2.countNonZero(mask) < 0.015 * shape[0] * shape[1]:
        return None
    return mask


class PinMap:
    """Image positions of a board's pins, from the corners set by the user's alignment."""

    def __init__(self, pinout: dict, quad: np.ndarray):
        self.ids = [p["id"] for p in pinout["pins"]]
        unit = np.array([[0, 0], [1, 0], [1, 1], [0, 1]], dtype=np.float32)
        matrix = cv2.getPerspectiveTransform(unit, quad.astype(np.float32))
        uv = np.array([[p["u"], p["v"]] for p in pinout["pins"]], dtype=np.float64)
        self.points = project(matrix, uv)
        length = (np.linalg.norm(quad[1] - quad[0]) + np.linalg.norm(quad[2] - quad[3])) / 2
        self.pitch_px = float(length * pinout["pitchMm"] / pinout["outlineMm"]["width"])

    def nearest(self, point) -> tuple[str, float]:
        """Closest pin to an image point, with its distance in pitches."""
        return self.nearby(point, float("inf"))[0]

    def nearby(self, point, radius: float) -> list[tuple[str, float]]:
        """Pins within `radius` pitches of an image point, closest first."""
        distances = np.linalg.norm(self.points - np.asarray(point, dtype=np.float64), axis=1) / self.pitch_px
        return [(f"pin:{self.ids[i]}", float(distances[i])) for i in np.argsort(distances) if distances[i] <= radius]
