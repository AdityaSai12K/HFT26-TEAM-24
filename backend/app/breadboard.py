"""Locate a solderless breadboard from its hole lattice and map image points to electrical nodes.

The lattice is the defining feature: a desk or sheet of paper is also pale and
rectangular, but it has no grid of holes. Holes are found first, walked
neighbour-to-neighbour into integer grid coordinates (which tolerates
perspective), then a homography is fitted to those coordinates.

Board coordinates are in header pitches (2.54 mm), with x along the columns and
y across them, and the centre channel on y = 0. Columns are numbered relative
to the visible lattice, so they need not match the numbers printed on the board.
Electrical identity only depends on relative position.
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass

import cv2
import numpy as np
from scipy.spatial import cKDTree

from .geometry import project

ROW_OFFSETS = [1.5, 2.5, 3.5, 4.5, 5.5]
RAIL_OFFSETS = {"inner": 8.4, "outer": 9.4}
HALF_WIDTH = 10.75
EDGE_MARGIN = 1.75

MIN_LATTICE_HOLES = 60
MIN_BLOCK_ROWS = 4
MIN_BLOCK_COLUMNS = 6
MIN_COLUMN_HOLES = 3
ROW_FILL = 0.3
RAIL_MIN_HOLES = 8

#: Where the printed rail lines sit, in pitches beyond the rail holes.
STRIPE_REACH = (0.35, 1.35)
#: How far a line's a or b channel must sit from the plastic's, in 8-bit Lab units.
STRIPE_MIN_SHIFT = 9
#: Share of the board's length a line must cover to count as printed.
STRIPE_MIN_SHARE = 0.3


@dataclass
class BreadboardFit:
    columns: int
    half_length: float
    to_image: np.ndarray
    to_board: np.ndarray
    holes_matched: int
    rails: dict[str, dict[str, float]]

    @property
    def quad(self) -> np.ndarray:
        half = self.half_length
        corners = np.array([[-half, -HALF_WIDTH], [half, -HALF_WIDTH], [half, HALF_WIDTH], [-half, HALF_WIDTH]])
        return project(self.to_image, corners)

    def pitch_px(self) -> float:
        a, b = project(self.to_image, np.array([[0.0, 0.0], [1.0, 0.0]]))
        return float(np.linalg.norm(a - b))

    def contains(self, point, margin: float = 1.0) -> bool:
        x, y = project(self.to_board, np.array([point], dtype=np.float64))[0]
        return abs(x) <= self.half_length + margin and abs(y) <= HALF_WIDTH + margin


def find_holes(gray: np.ndarray) -> np.ndarray:
    """Centres of small, compact dark blobs anywhere in the image."""
    window = max(15, int(max(gray.shape) / 30)) | 1
    dark = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, window, 14)
    count, _, stats, centroids = cv2.connectedComponentsWithStats(dark, connectivity=8)
    max_side = max(gray.shape) / 35
    keep = []
    for i in range(1, count):
        w, h, area = stats[i, cv2.CC_STAT_WIDTH], stats[i, cv2.CC_STAT_HEIGHT], stats[i, cv2.CC_STAT_AREA]
        if area >= 4 and max(w, h) <= max_side and max(w, h) <= 2.5 * min(w, h) and area >= 0.35 * w * h:
            keep.append(centroids[i])
    return np.array(keep, dtype=np.float64).reshape(-1, 2)


def _dominant_pitch(points: np.ndarray, tree: cKDTree) -> float | None:
    """The nearest-neighbour spacing shared by most holes."""
    distances, _ = tree.query(points, k=3)
    regular = distances[(distances[:, 2] / np.maximum(distances[:, 1], 1e-6)) < 1.3, 1]
    return float(np.median(regular)) if len(regular) >= MIN_LATTICE_HOLES / 2 else None


def _local_angle(points: np.ndarray, neighbours: list[list[int]], index: int, pitch: float) -> float | None:
    """Lattice orientation around one hole, modulo 90 degrees."""
    delta = points[[n for n in neighbours[index] if n != index]] - points[index]
    lengths = np.linalg.norm(delta, axis=1) if len(delta) else np.array([])
    delta = delta[(lengths > 0.7 * pitch) & (lengths < 1.3 * pitch)] if len(delta) else delta
    if len(delta) < 2:
        return None
    return float(np.angle(np.exp(4j * np.arctan2(delta[:, 1], delta[:, 0])).mean()) / 4)


def _walk_lattice(points: np.ndarray, tree: cKDTree, pitch: float) -> dict[int, tuple[int, int]]:
    """Largest grid reachable from any seed. Other lattices, like IC pins, stay smaller."""
    neighbours = tree.query_ball_point(points, 1.45 * pitch)
    visited: set[int] = set()
    best: dict[int, tuple[int, int]] = {}
    for seed in np.argsort([-len(n) for n in neighbours]):
        seed = int(seed)
        if seed in visited or len(points) - len(visited) <= len(best):
            continue
        angle = _local_angle(points, neighbours, seed, pitch)
        if angle is None:
            continue
        grid = _flood(points, neighbours, pitch, angle, seed)
        visited.update(grid)
        if len(grid) > len(best):
            best = grid
    return best


def _flood(points: np.ndarray, neighbours: list[list[int]], pitch: float, angle: float, seed: int) -> dict[int, tuple[int, int]]:
    """Assign integer grid coordinates outward from one hole."""
    start = (np.array([np.cos(angle), np.sin(angle)]) * pitch, np.array([-np.sin(angle), np.cos(angle)]) * pitch)
    grid: dict[int, tuple[int, int]] = {seed: (0, 0)}
    queue = deque([(seed, start[0], start[1])])
    while queue:
        index, e1, e2 = queue.popleft()
        basis_inverse = np.linalg.inv(np.column_stack([e1, e2]))
        for other in neighbours[index]:
            if other in grid or other == index:
                continue
            step = basis_inverse @ (points[other] - points[index])
            rounded = np.round(step)
            if np.abs(step - rounded).max() > 0.3 or np.abs(rounded).sum() != 1:
                continue
            i, j = grid[index]
            grid[other] = (i + int(rounded[0]), j + int(rounded[1]))
            delta = points[other] - points[index]
            # The local basis drifts with perspective, so it is updated along the walk.
            queue.append((other, e1 * 0.7 + 0.3 * rounded[0] * delta if rounded[0] else e1,
                          e2 * 0.7 + 0.3 * rounded[1] * delta if rounded[1] else e2))
    return grid


def _extend(points: np.ndarray, grid: dict[int, tuple[int, int]]) -> tuple[np.ndarray, np.ndarray] | None:
    """Fit a homography, then pull in holes the walk could not reach, such as across the channel."""
    ids = np.array(list(grid.keys()))
    coords = np.array([grid[i] for i in ids], dtype=np.float64)
    matrix = None
    for _ in range(6):
        matrix, inliers = cv2.findHomography(coords, points[ids], cv2.RANSAC, 3.0)
        if matrix is None:
            return None
        keep = inliers.ravel().astype(bool)
        ids, coords = ids[keep], coords[keep]
        fractional = project(np.linalg.inv(matrix), points)
        rounded = np.round(fractional)
        close = np.abs(fractional - rounded).max(axis=1) < 0.28
        lo, hi = coords.min(axis=0) - 16, coords.max(axis=0) + 16
        close &= ((rounded >= lo) & (rounded <= hi)).all(axis=1)
        if close.sum() <= len(ids):
            break
        ids, coords = np.flatnonzero(close), rounded[close]
    return matrix, coords


def _blocks(occupied: np.ndarray) -> list[tuple[int, int]]:
    """Runs of well-filled grid lines along one axis, as (first, last)."""
    runs, start = [], None
    for index, filled in enumerate(occupied):
        if filled and start is None:
            start = index
        if not filled and start is not None:
            runs.append((start, index - 1))
            start = None
    if start is not None:
        runs.append((start, len(occupied) - 1))
    return runs


def _axis_layout(values: np.ndarray, others: np.ndarray) -> tuple[int, float] | None:
    """Score this axis as the across-rows axis. Returns (score, centre line) on a match."""
    lo = int(values.min())
    span = int(values.max()) - lo + 1
    counts = np.bincount((values - lo).astype(int), minlength=span)
    length = int(others.max() - others.min()) + 1
    occupied = counts >= max(3, ROW_FILL * length)
    best = None
    for first, last in _blocks(occupied):
        rows = last - first + 1
        if rows < MIN_BLOCK_ROWS or rows > 6:
            continue
        # Prefer the two-block layout: 5 rows, a 2-row channel, 5 rows.
        for other_first, other_last in _blocks(occupied):
            if other_first - last == 3 and other_last - other_first + 1 >= MIN_BLOCK_ROWS:
                return 2, lo + (last + other_first) / 2
        if best is None:
            best = (1, lo + last + 1.5)
    return best


def locate(bgr: np.ndarray) -> BreadboardFit | None:
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    points = find_holes(gray)
    if len(points) < MIN_LATTICE_HOLES:
        return None
    tree = cKDTree(points)
    pitch = _dominant_pitch(points, tree)
    if pitch is None:
        return None
    grid = _walk_lattice(points, tree, pitch)
    if len(grid) < MIN_LATTICE_HOLES / 2:
        return None
    extended = _extend(points, grid)
    if extended is None:
        return None
    matrix, coords = extended
    if len(coords) < MIN_LATTICE_HOLES:
        return None

    across_i = _axis_layout(coords[:, 0], coords[:, 1])
    across_j = _axis_layout(coords[:, 1], coords[:, 0])
    if across_i is None and across_j is None:
        return None  # No 5-row block, so this grid is not a breadboard.
    use_i = across_j is None or (across_i is not None and across_i[0] > across_j[0])
    across = 0 if use_i else 1
    along = 1 - across
    centre = (across_i if use_i else across_j)[1]

    in_rows = np.abs(np.abs(coords[:, across] - centre) - 3.5) <= 2.25
    along_values = coords[in_rows, along].astype(int)
    lowest = int(along_values.min())
    # A real column stacks several holes. A board's single row of header pins does not.
    filled = np.bincount(along_values - lowest) >= MIN_COLUMN_HOLES
    # Parts and wires hide holes, so small gaps stay inside one run.
    closed = cv2.morphologyEx(filled.astype(np.uint8).reshape(1, -1), cv2.MORPH_CLOSE, np.ones((1, 5), np.uint8)).ravel()
    runs = _blocks(closed > 0)
    if not runs:
        return None
    start, stop = max(runs, key=lambda run: run[1] - run[0])
    first, last = lowest + start, lowest + stop
    if last - first + 1 < MIN_BLOCK_COLUMNS:
        return None
    middle = (first + last) / 2

    # Board (x, y) to grid (i, j), then grid to image.
    board_to_grid = np.zeros((3, 3))
    board_to_grid[along, 0] = 1
    board_to_grid[along, 2] = middle
    board_to_grid[across, 1] = 1
    board_to_grid[across, 2] = centre
    board_to_grid[2, 2] = 1
    to_image = matrix @ board_to_grid
    to_board = np.linalg.inv(to_image)
    columns = last - first + 1
    half_length = (columns - 1) / 2 + EDGE_MARGIN
    in_board = project(to_board, points)
    in_board = in_board[np.abs(in_board[:, 0]) <= half_length]
    rails = {
        "top": _measure_rails(-in_board[in_board[:, 1] < 0, 1]),
        "bottom": _measure_rails(in_board[in_board[:, 1] > 0, 1]),
    }
    return BreadboardFit(columns, half_length, to_image, to_board, len(coords), rails)


def _measure_rails(distances: np.ndarray) -> dict[str, float]:
    """Rail spacing varies by manufacturer, so it is read from the holes when enough are visible."""
    best, best_score = None, RAIL_MIN_HOLES - 1
    for inner in np.arange(6.6, 10.0, 0.05):
        score = int((np.abs(distances - inner) < 0.2).sum() + (np.abs(distances - inner - 1) < 0.2).sum())
        if score > best_score:
            best, best_score = float(inner), score
    return {"inner": best, "outer": best + 1} if best is not None else dict(RAIL_OFFSETS)


def _stripe_colour(lab: np.ndarray, fit: BreadboardFit, sign: int, near: float, far: float) -> str | None:
    """The colour of the printed line in a band across the board, or None if there is no clear one."""
    along = np.arange(-fit.half_length, fit.half_length, 0.5)
    across = np.arange(near, far, 0.1)
    board = np.array([(x, sign * y) for x in along for y in across])
    image = np.rint(project(fit.to_image, board)).astype(int)
    inside = (image[:, 0] >= 0) & (image[:, 0] < lab.shape[1]) & (image[:, 1] >= 0) & (image[:, 1] < lab.shape[0])
    if not inside.any():
        return None
    samples = np.full((len(board), 3), np.nan)
    samples[inside] = lab[image[inside, 1], image[inside, 0]]
    # Measured against the plastic beside the line, so a colour cast on the photo cancels out.
    shift = samples - np.nanmedian(samples, axis=0)
    redder, bluer = shift[:, 1], -shift[:, 2]
    shape = (len(along), len(across))
    red = np.nan_to_num((redder >= STRIPE_MIN_SHIFT) & (redder > bluer)).astype(bool).reshape(shape)
    blue = np.nan_to_num((bluer >= STRIPE_MIN_SHIFT) & (bluer > redder)).astype(bool).reshape(shape)
    # A line runs the length of the board. Counting positions along it, not pixels, stops one crossing wire from counting.
    red_share, blue_share = red.any(axis=1).mean(), blue.any(axis=1).mean()
    if max(red_share, blue_share) < STRIPE_MIN_SHARE or min(red_share, blue_share) > max(red_share, blue_share) / 2:
        return None
    return "+" if red_share > blue_share else "-"


def read_rail_polarity(bgr: np.ndarray, fit: BreadboardFit) -> dict[str, dict[str, str | None]]:
    """Read + and - from the red and blue lines printed beside each rail.

    Both lines must be found and must disagree. Anything else leaves that pair
    unknown, because a rail with the wrong sign would raise a false short.
    """
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB).astype(np.float32)
    polarity: dict[str, dict[str, str | None]] = {}
    for side, sign in (("top", -1), ("bottom", 1)):
        inner, outer = fit.rails[side]["inner"], fit.rails[side]["outer"]
        inner_line = _stripe_colour(lab, fit, sign, inner - STRIPE_REACH[1], inner - STRIPE_REACH[0])
        outer_line = _stripe_colour(lab, fit, sign, outer + STRIPE_REACH[0], outer + STRIPE_REACH[1])
        known = inner_line is not None and outer_line is not None and inner_line != outer_line
        polarity[side] = {"inner": inner_line if known else None, "outer": outer_line if known else None}
    return polarity


def rail_marks(bgr: np.ndarray, fit: BreadboardFit, scale: float) -> list[dict]:
    """Rails whose sign was read, as lines in original image pixels."""
    marks = []
    polarity = read_rail_polarity(bgr, fit)
    for side, sign in (("top", -1), ("bottom", 1)):
        for name, offset in fit.rails[side].items():
            if polarity[side][name] is None:
                continue
            ends = project(fit.to_image, np.array([[-fit.half_length, sign * offset], [fit.half_length, sign * offset]]))
            marks.append({
                "node": f"rail:{side}-{name}",
                "sign": polarity[side][name],
                "from": [round(float(v) / scale, 1) for v in ends[0]],
                "to": [round(float(v) / scale, 1) for v in ends[1]],
            })
    return marks


def nearby_nodes(fit: BreadboardFit, point, radius: float) -> list[tuple[str, float]]:
    """Electrical nodes within `radius` pitches of an image point, closest first."""
    x, y = project(fit.to_board, np.array([point], dtype=np.float64))[0]
    if abs(x) > fit.half_length + radius or abs(y) > HALF_WIDTH + radius:
        return []
    found: list[tuple[str, float]] = []
    x0 = (fit.columns - 1) / 2
    first = max(0, int(np.ceil(x + x0 - radius)))
    last = min(fit.columns - 1, int(np.floor(x + x0 + radius)))
    for side, sign in (("top", -1), ("bottom", 1)):
        across = y * sign
        # All five holes in a column are one net, so landing anywhere along it counts.
        past_block = max(0.0, across - ROW_OFFSETS[-1], ROW_OFFSETS[0] - across)
        for column in range(first, last + 1):
            distance = float(np.hypot(x - (column - x0), past_block))
            if distance <= radius:
                found.append((f"bb:{column + 1}:{side}", distance))
        for name, offset in fit.rails[side].items():
            # Rails run the whole board, so only the distance across them matters.
            distance = float(abs(across - offset))
            if distance <= radius:
                found.append((f"rail:{side}-{name}", distance))
    return sorted(found, key=lambda item: item[1])


def nearest_node(fit: BreadboardFit, point) -> tuple[str, float] | None:
    """Closest tie point to an image point, with its distance in pitches."""
    nodes = nearby_nodes(fit, point, 3.0)
    return nodes[0] if nodes else None
