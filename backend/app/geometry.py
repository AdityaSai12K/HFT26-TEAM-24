"""Quad fitting and projective helpers shared by the breadboard and board locators."""
from __future__ import annotations

import cv2
import numpy as np


def largest_component(mask: np.ndarray) -> np.ndarray | None:
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    if count < 2:
        return None
    best = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    return (labels == best).astype(np.uint8) * 255


def fit_quad(mask: np.ndarray) -> np.ndarray | None:
    """Four corners of the blob in `mask`, tolerating parts that bite into its edge."""
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    hull = cv2.convexHull(max(contours, key=cv2.contourArea))
    perimeter = cv2.arcLength(hull, True)
    for eps in np.linspace(0.01, 0.12, 24):
        approx = cv2.approxPolyDP(hull, eps * perimeter, True)
        if len(approx) == 4:
            return order_clockwise(approx.reshape(4, 2).astype(np.float32))
    return order_clockwise(cv2.boxPoints(cv2.minAreaRect(hull)).astype(np.float32))


def order_clockwise(points: np.ndarray) -> np.ndarray:
    """Clockwise as seen in the image, starting from the top-left-most corner."""
    center = points.mean(axis=0)
    angles = np.arctan2(points[:, 1] - center[1], points[:, 0] - center[0])
    ordered = points[np.argsort(angles)]
    start = int(np.argmin(ordered.sum(axis=1)))
    return np.roll(ordered, -start, axis=0)


def edge_lengths(quad: np.ndarray) -> tuple[float, float]:
    """Mean lengths of the (0-1, 2-3) and (1-2, 3-0) edge pairs."""
    a = (np.linalg.norm(quad[0] - quad[1]) + np.linalg.norm(quad[2] - quad[3])) / 2
    b = (np.linalg.norm(quad[1] - quad[2]) + np.linalg.norm(quad[3] - quad[0])) / 2
    return float(a), float(b)


def project(matrix: np.ndarray, points: np.ndarray) -> np.ndarray:
    pts = np.asarray(points, dtype=np.float64).reshape(-1, 1, 2)
    return cv2.perspectiveTransform(pts, matrix).reshape(-1, 2)


def quad_area(quad: np.ndarray) -> float:
    return float(cv2.contourArea(quad.astype(np.float32)))
