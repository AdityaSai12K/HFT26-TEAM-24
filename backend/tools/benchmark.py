"""Time the full pipeline and count the parts it finds, to compare before and after a change.

Run from backend/: python -m tools.benchmark [folder of images]

With no folder it uses the dashboard's samples. Those are drawings, which is not
a fair test of the zero-shot models, so pass real photos for a detection change.

A higher count is not better by itself. A false part counts the same as a real
one, so check the boxes by eye before believing a gain.
"""
import argparse
import statistics
import time
from collections import Counter
from pathlib import Path

import cv2

from app.boards import BOARD_IDS, load_pinout
from app.pipeline import analyze
from app.zeroshot import Models

SAMPLES = Path(__file__).resolve().parents[2] / "frontend" / "public" / "samples"
EXTENSIONS = {".jpg", ".jpeg", ".png"}
#: Found by the structure stages, so a change to part detection cannot move them.
STRUCTURE = {"breadboard"} | {load_pinout(board_id)["vision"]["kind"] for board_id in BOARD_IDS}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("folder", nargs="?", type=Path, default=SAMPLES)
    folder = parser.parse_args().folder

    paths = sorted(p for p in folder.iterdir() if p.suffix.lower() in EXTENSIONS)
    if not paths:
        raise SystemExit(f"No images in {folder}")

    models = Models()
    models.load()
    for warning in models.errors:
        print(f"Warning: {warning}")

    # The first inference builds lazy state, which is not a cost of any one image.
    analyze(cv2.imread(str(paths[0])), models)

    times: list[float] = []
    totals: Counter[str] = Counter()
    for path in paths:
        image = cv2.imread(str(path))
        if image is None:
            print(f"{path.name:24} could not be read")
            continue
        started = time.perf_counter()
        scene = analyze(image, models)
        elapsed = (time.perf_counter() - started) * 1000
        parts = Counter(d["kind"] for d in scene["detections"] if d["kind"] not in STRUCTURE)
        times.append(elapsed)
        totals += parts
        print(f"{path.name:24} {elapsed:7.0f} ms  {sum(parts.values()):3} part(s)  {dict(parts)}")

    print(f"\n{len(times)} image(s) in {folder}")
    print(f"Time per image: {statistics.mean(times):.0f} ms mean, {statistics.median(times):.0f} ms median")
    print(f"Parts found: {sum(totals.values())}  {dict(totals)}")


if __name__ == "__main__":
    main()
