"""Trace jumper wires as coloured ribbons.

A false wire is the worst failure here, because it can invent a short or hide
the real topology. Candidates must therefore look like a wire: thin, smooth,
in contrast with their surroundings, and not a straight printed rail line.
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass

import cv2
import numpy as np
from skimage.morphology import skeletonize

from .breadboard import BreadboardFit, read_rail_polarity
from .geometry import project

# OpenCV HSV ranges. Low-saturation colours are excluded so wood desks and skin do not read as orange.
COLOURS: dict[str, list[tuple[tuple[int, int, int], tuple[int, int, int]]]] = {
    "red": [((0, 110, 70), (7, 255, 255)), ((170, 110, 70), (179, 255, 255))],
    "orange": [((8, 130, 90), (19, 255, 255))],
    "yellow": [((20, 110, 90), (34, 255, 255))],
    "green": [((35, 70, 40), (85, 255, 255))],
    "blue": [((95, 70, 40), (130, 255, 255))],
    "purple": [((131, 70, 40), (165, 255, 255))],
}

# Only blue overlaps a teal PCB's hue. Masking the board for every colour would
# erase the wire ends that land on its pins.
PCB_LOOKALIKES = {"blue"}

# The printed rail lines. A faded red line can read as orange.
LINE_LOOKALIKES = {"red", "orange", "blue"}
#: How far the rail strips reach past the rail holes, in pitches. Enough to hold the lines, not the column blocks.
RAIL_STRIP_MARGIN = 1.5
#: Thicker than a printed line and thinner than a jumper wire.
LINE_OPENING_PITCHES = 0.3

MIN_LENGTH_PITCHES = 3.0
MIN_WIDTH_PITCHES = 0.2
MIN_ELONGATION = 3.0
MIN_CONTRAST = 22.0
MAX_ROUGHNESS = 1.22


@dataclass
class Ribbon:
    colour: str
    path: list[tuple[int, int]]
    width: float
    contrast: float
    roughness: float


def _longest_path(skeleton: np.ndarray) -> list[tuple[int, int]]:
    """Longest geodesic through a skeleton, found with two breadth-first sweeps."""
    ys, xs = np.nonzero(skeleton)
    pixels = set(zip(xs.tolist(), ys.tolist()))
    if not pixels:
        return []

    def sweep(start):
        parents = {start: None}
        queue = deque([start])
        last = start
        while queue:
            last = queue.popleft()
            x, y = last
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    step = (x + dx, y + dy)
                    if step in pixels and step not in parents:
                        parents[step] = last
                        queue.append(step)
        return last, parents

    far, _ = sweep(next(iter(pixels)))
    end, parents = sweep(far)
    path, cursor = [], end
    while cursor is not None:
        path.append(cursor)
        cursor = parents[cursor]
    return path


def _roughness(path: list[tuple[int, int]], window: int) -> float:
    """Path length over smoothed path length. Wires are smooth; colour blotches wander."""
    points = np.array(path, dtype=np.float64)
    if len(points) <= window * 2:
        return 1.0
    kernel = np.ones(window) / window
    smooth = np.column_stack([np.convolve(points[:, i], kernel, mode="valid") for i in (0, 1)])
    raw = np.linalg.norm(np.diff(points, axis=0), axis=1).sum()
    return float(raw / max(np.linalg.norm(np.diff(smooth, axis=0), axis=1).sum(), 1.0))


def _contrast(lab: np.ndarray, blob: np.ndarray, x: int, y: int, ring_size: int) -> float:
    """Lab colour distance between the ribbon and the band of pixels around it."""
    pad = ring_size + 1
    x0, y0 = max(0, x - pad), max(0, y - pad)
    x1, y1 = min(lab.shape[1], x + blob.shape[1] + pad), min(lab.shape[0], y + blob.shape[0] + pad)
    region = np.zeros((y1 - y0, x1 - x0), np.uint8)
    region[y - y0:y - y0 + blob.shape[0], x - x0:x - x0 + blob.shape[1]] = blob
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (ring_size * 2 + 1, ring_size * 2 + 1))
    ring = (cv2.dilate(region, kernel) > 0) & (region == 0)
    patch = lab[y0:y1, x0:x1]
    if not ring.any():
        return 0.0
    return float(np.linalg.norm(patch[region > 0].mean(axis=0) - patch[ring].mean(axis=0)))


def _is_printed_line(path: list[tuple[int, int]], fit: BreadboardFit | None) -> bool:
    """Rail stripes run dead straight along the board. A wire, even a straight one, leaves that line."""
    if fit is None:
        return False
    board = project(fit.to_board, np.array(path[:: max(1, len(path) // 60)], dtype=np.float64))
    return abs(float(np.median(board[:, 1]))) > 6 and float(board[:, 1].std()) < 0.35


def _rail_strips(bgr: np.ndarray, fit: BreadboardFit) -> np.ndarray:
    """Where printed rail lines were really found.

    A mini breadboard has no rails, and the same bands then land on whatever sits
    beside it. Opening a red PCB there breaks it into shapes that pass as wires.
    """
    strips = np.zeros(bgr.shape[:2], np.uint8)
    half = fit.half_length
    polarity = read_rail_polarity(bgr, fit)
    for sign, side in ((-1, "top"), (1, "bottom")):
        if polarity[side]["inner"] is None:
            continue
        near, far = fit.rails[side]["inner"] - RAIL_STRIP_MARGIN, fit.rails[side]["outer"] + RAIL_STRIP_MARGIN
        corners = np.array([[-half, sign * near], [half, sign * near], [half, sign * far], [-half, sign * far]])
        cv2.fillConvexPoly(strips, np.rint(project(fit.to_image, corners)).astype(np.int32), 255)
    return strips


def _without_printed_lines(mask: np.ndarray, strips: np.ndarray, pitch: float) -> np.ndarray:
    """A wire crossing a line of its own colour would merge with it and follow it down the board.

    A printed line is much thinner than a wire, so an opening inside the rail
    strips removes the line and leaves the wire. Elsewhere the mask is untouched.
    """
    size = max(3, int(pitch * LINE_OPENING_PITCHES)) | 1
    opened = cv2.morphologyEx(mask, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (size, size)))
    return np.where(strips > 0, opened, mask)


def ribbons(bgr: np.ndarray, pitch: float, exclude: np.ndarray | None = None, fit: BreadboardFit | None = None) -> list[Ribbon]:
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB).astype(np.float32)
    lab[..., 0] *= 100 / 255  # Lightness on the same scale as a and b.
    close_size = max(3, int(pitch * 0.3)) | 1
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (close_size, close_size))
    ring_size = max(3, int(pitch * 0.3))
    min_length = MIN_LENGTH_PITCHES * pitch
    min_width = MIN_WIDTH_PITCHES * pitch
    found: list[Ribbon] = []
    strips = _rail_strips(bgr, fit) if fit is not None else None

    for colour, ranges in COLOURS.items():
        mask = np.zeros(bgr.shape[:2], np.uint8)
        for lo, hi in ranges:
            mask |= cv2.inRange(hsv, lo, hi)
        if exclude is not None and colour in PCB_LOOKALIKES:
            mask[exclude > 0] = 0
        if strips is not None and colour in LINE_LOOKALIKES:
            mask = _without_printed_lines(mask, strips, pitch)
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
        count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
        for i in range(1, count):
            x, y, w, h, area = stats[i]
            if max(w, h) < min_length * 0.7 or area < min_length * min_width:
                continue
            blob = (labels[y:y + h, x:x + w] == i)
            skeleton = skeletonize(blob)
            if not skeleton.any():
                continue
            distance = cv2.distanceTransform(blob.astype(np.uint8), cv2.DIST_L2, 3)
            width = float(np.median(distance[skeleton]) * 2)
            if width < min_width:
                continue
            path = _longest_path(skeleton)
            if len(path) < min_length or len(path) / max(width, 1) < MIN_ELONGATION:
                continue
            path = [(px + x, py + y) for px, py in path]
            roughness = _roughness(path, max(5, int(pitch)))
            if roughness > MAX_ROUGHNESS or _is_printed_line(path, fit):
                continue
            contrast = _contrast(lab, blob.astype(np.uint8), x, y, ring_size)
            if contrast < MIN_CONTRAST:
                continue
            found.append(Ribbon(colour, path, width, contrast, roughness))
    return found


def simplify(path: list[tuple[int, int]], tolerance: float) -> list[list[float]]:
    points = np.array(path, dtype=np.float32).reshape(-1, 1, 2)
    return cv2.approxPolyDP(points, tolerance, False).reshape(-1, 2).astype(float).tolist()
