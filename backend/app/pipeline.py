"""Turn one frame into a Scene (see frontend/lib/types.ts for the schema)."""
from __future__ import annotations

import time
from dataclasses import dataclass

import cv2
import numpy as np

from . import boards
from . import breadboard as bb
from .wires import ribbons, simplify
from .zeroshot import REJECT, Models

MAX_DIMENSION = 1280
DEFAULT_PITCH_FRACTION = 1 / 90

#: An end this close to a hole or pin, in pitches, has landed on it.
LANDED_PITCHES = 0.5
#: How far `near` looks for the "moving toward" hazard check.
NEAR_PITCHES = 4.0
MAX_NEARBY = 16
#: A ribbon with no end this close to any node is not part of the circuit.
RELEVANT_PITCHES = 2.0

MIN_PART_CONFIDENCE = 0.4
MAX_PROPOSALS = 14
MAX_WIRE_IN_CROP = 0.12
#: Only checked through their legs in breadboard holes, so anywhere else they are noise.
BREADBOARD_ONLY = {"led", "resistor", "capacitor", "button"}
PCB_COLOUR_CONFIDENCE = 0.5


@dataclass
class Options:
    #: A board the user chose. Overrides recognition.
    board: str | None = None
    #: Board corners from the user's pin alignment, in original image pixels.
    quad: list[list[float]] | None = None
    #: Skip the slower part naming, for live frames in between full ones.
    full: bool = True


def _end(point, fit: bb.BreadboardFit | None, pins: boards.PinMap | None) -> dict:
    nodes: list[tuple[str, float]] = []
    if fit is not None:
        nodes += bb.nearby_nodes(fit, point, NEAR_PITCHES)
    if pins is not None:
        nodes += pins.nearby(point, NEAR_PITCHES)
    nodes.sort(key=lambda item: item[1])
    x, y = float(point[0]), float(point[1])
    if not nodes:
        return {"point": [x, y], "node": None, "confidence": 0.0, "near": None, "nearPitches": None, "nearby": []}
    node, distance = nodes[0]
    return {
        "point": [x, y],
        "node": node if distance <= LANDED_PITCHES else None,
        # Reaches 0.5 at the landing limit, which is the rule engine's evidence floor.
        "confidence": round(float(np.clip(0.95 - 0.9 * distance, 0.0, 0.95)), 3),
        "near": node,
        "nearPitches": round(distance, 2),
        # A hovering wire looks plugged in, so hazards need every node it could be heading for.
        "nearby": [[n, round(d, 2)] for n, d in nodes[:MAX_NEARBY]],
    }


def _detections_for_structure(fit, region, board_id, board_confidence, scale) -> list[dict]:
    found = []
    if fit is not None:
        x, y, w, h = cv2.boundingRect(fit.quad.astype(np.float32))
        # Most of the lattice being matched is what makes this a breadboard.
        confidence = min(0.99, 0.6 + fit.holes_matched / (fit.columns * 10 + 1) * 0.4)
        found.append(_detection("breadboard", f"{fit.holes_matched} holes in a lattice", confidence, (x, y, x + w, y + h), "opencv", scale))
    if region is not None:
        x, y, w, h = cv2.boundingRect(region)
        kind = boards.load_pinout(board_id)["vision"]["kind"]
        found.append(_detection(kind, "PCB region", max(board_confidence, 0.5), (x, y, x + w, y + h), "opencv", scale))
    return found


def _detection(kind, label, confidence, box, source, scale) -> dict:
    return {
        "id": "",
        "kind": kind,
        "label": label,
        "confidence": round(float(confidence), 3),
        "box": [round(float(v) / scale, 1) for v in box],
        "source": source,
        "terminals": [],
    }


def _blob_proposals(bgr: np.ndarray, fit: bb.BreadboardFit, wire_mask: np.ndarray) -> list[tuple[float, float, float, float, float]]:
    """Things sitting on the breadboard that are neither plastic nor wire."""
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    pitch = fit.pitch_px()
    region = np.zeros(bgr.shape[:2], np.uint8)
    cv2.fillConvexPoly(region, fit.quad.astype(np.int32), 255)
    busy = ((hsv[..., 1] > 70) | (hsv[..., 2] < 80)).astype(np.uint8) * 255
    busy = cv2.bitwise_and(busy, region)
    busy[wire_mask > 0] = 0
    size = max(3, int(pitch * 0.5)) | 1
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (size, size))
    busy = cv2.morphologyEx(cv2.morphologyEx(busy, cv2.MORPH_OPEN, kernel), cv2.MORPH_CLOSE, kernel)
    count, _, stats, _ = cv2.connectedComponentsWithStats(busy, connectivity=8)
    boxes = []
    for i in range(1, count):
        x, y, w, h, area = stats[i]
        if area >= (1.2 * pitch) ** 2 and max(w, h) <= 12 * pitch:
            pad = int(pitch * 0.5)
            boxes.append((float(x - pad), float(y - pad), float(x + w + pad), float(y + h + pad), 0.0))
    return boxes


def _box_iou(a, b) -> float:
    x1, y1, x2, y2 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / max(union, 1e-6)


def _parts(bgr, proposals, models: Models, wire_mask: np.ndarray, scale, fit: bb.BreadboardFit | None) -> list[dict]:
    """CLIP has the final say on what each proposal is."""
    h, w = bgr.shape[:2]
    unique: list[tuple] = []
    for box in sorted(proposals, key=lambda b: (b[2] - b[0]) * (b[3] - b[1])):
        clipped = (max(0.0, box[0]), max(0.0, box[1]), min(float(w), box[2]), min(float(h), box[3]), box[4])
        area = (clipped[2] - clipped[0]) * (clipped[3] - clipped[1])
        if area < 100 or area > 0.3 * w * h:
            continue
        # A crop full of wire tells CLIP nothing about any part, and it guesses "resistor".
        if wire_mask[int(clipped[1]):int(clipped[3]), int(clipped[0]):int(clipped[2])].mean() / 255 > MAX_WIRE_IN_CROP:
            continue
        if not any(_box_iou(clipped, other) > 0.5 for other in unique):
            unique.append(clipped)
    # The loop above runs smallest first, so that order must not decide who is cut.
    # Blobs have no score and sit on the breadboard, where parts matter, so they go first.
    unique.sort(key=lambda b: (b[4] == 0, b[4]), reverse=True)
    unique = unique[:MAX_PROPOSALS]
    crops = [bgr[int(b[1]):int(b[3]), int(b[0]):int(b[2])] for b in unique]
    found = []
    for box, (kind, probability) in zip(unique, models.label_crops(crops)):
        if kind in REJECT or probability < MIN_PART_CONFIDENCE:
            continue
        centre = ((box[0] + box[2]) / 2, (box[1] + box[3]) / 2)
        if kind in BREADBOARD_ONLY and (fit is None or not fit.contains(centre)):
            continue
        source = "yolo-world" if box[4] > 0 else "opencv"
        found.append(_detection(kind, f"CLIP: {kind.replace('_', ' ')}", probability, box[:4], source, scale))
    return found


def analyze(original: np.ndarray, models: Models, options: Options | None = None) -> dict:
    options = options or Options()
    started = time.perf_counter()
    timings: dict[str, float] = {}

    def mark(name: str, since: float) -> float:
        now = time.perf_counter()
        timings[name] = round((now - since) * 1000, 1)
        return now

    height, width = original.shape[:2]
    scale = min(1.0, MAX_DIMENSION / max(height, width))
    bgr = cv2.resize(original, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA) if scale < 1 else original
    warnings = list(models.errors)

    now = started
    fit = bb.locate(bgr)
    now = mark("breadboard", now)

    board_id, board_confidence, board_evidence = options.board, 1.0, "chosen by you"
    if options.board is None:
        board_id, board_confidence, board_evidence = models.identify_board(bgr)
    now = mark("board", now)

    breadboard_quad = fit.quad if fit else None
    region = boards.pcb_region(board_id, bgr, breadboard_quad) if board_id else None
    if board_id is None:
        # CLIP is unsure when a board is cropped, but a distinctive PCB is still decent evidence.
        recognised = boards.recognise_pcb(bgr, breadboard_quad)
        if recognised:
            board_id, region, board_evidence = recognised
            board_confidence = PCB_COLOUR_CONFIDENCE

    quad = pins = None
    if options.quad is not None and board_id is not None:
        quad = np.array(options.quad, dtype=np.float64)
        pins = boards.PinMap(boards.load_pinout(board_id), quad * scale)

    pitch = fit.pitch_px() if fit else (pins.pitch_px if pins else max(bgr.shape[:2]) * DEFAULT_PITCH_FRACTION)
    found_ribbons = ribbons(bgr, pitch, exclude=region, fit=fit)
    now = mark("wires", now)

    wires = []
    wire_mask = np.zeros(bgr.shape[:2], np.uint8)
    for ribbon in found_ribbons:
        cv2.polylines(wire_mask, [np.array(ribbon.path, dtype=np.int32)], False, 255, max(3, int(ribbon.width * 1.5)))
        ends = [_end(ribbon.path[0], fit, pins), _end(ribbon.path[-1], fit, pins)]
        if not any(e["nearPitches"] is not None and e["nearPitches"] <= RELEVANT_PITCHES for e in ends):
            continue
        for end in ends:
            end["point"] = [round(v / scale, 1) for v in end["point"]]
        wires.append({
            "id": f"wire-{len(wires)}",
            "color": ribbon.colour,
            "confidence": round(min(0.95, sum(e["confidence"] for e in ends) / 2 + 0.2), 3),
            "path": [[round(x / scale, 1), round(y / scale, 1)] for x, y in simplify(ribbon.path, 2.0)],
            "ends": ends,
        })

    detections = _detections_for_structure(fit, region, board_id, board_confidence, scale)
    if options.full:
        proposals = list(models.propose(bgr))
        now = mark("yolo", now)
        if fit is not None:
            proposals += _blob_proposals(bgr, fit, wire_mask)
        detections += _parts(bgr, proposals, models, wire_mask, scale, fit)
        now = mark("parts", now)
    for index, detection in enumerate(detections):
        detection["id"] = f"{detection['kind']}-{index}"

    evidence = [board_evidence] if board_id else []
    if board_id and pins is None:
        evidence.append("pins are not aligned yet")
        warnings.append("Align the pins to check wires that reach the board.")

    timings["total"] = round((time.perf_counter() - started) * 1000, 1)
    return {
        "imageSize": [width, height],
        "detections": detections,
        "wires": wires,
        "board": {
            "id": board_id,
            "confidence": round(float(board_confidence), 3) if board_id else 0.0,
            "evidence": evidence,
            "quad": quad.tolist() if quad is not None else None,
        },
        "breadboard": {
            "columns": fit.columns,
            "quad": [[round(float(v) / scale, 1) for v in corner] for corner in fit.quad],
            "toBoard": (fit.to_board @ np.diag([scale, scale, 1.0])).tolist(),
            "rails": fit.rails,
            "railMarks": bb.rail_marks(bgr, fit, scale),
        } if fit else None,
        "warnings": warnings,
        "timings": timings,
    }
