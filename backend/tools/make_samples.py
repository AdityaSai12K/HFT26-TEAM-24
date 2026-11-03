"""Write the dashboard's sample scenes to frontend/public/samples.

Run from backend/: python -m tools.make_samples

The breadboard and wire stages run for real on the rendered image. The board is
marked as aligned and the parts come from the script, because a drawing is not
a fair test of the zero-shot models.
"""
import json
from pathlib import Path

import cv2

from app import breadboard as bb
from app.pipeline import Options, analyze
from app.scene_render import SCENARIOS, node_xy, render, uno_quad
from app.zeroshot import Models

OUT = Path(__file__).resolve().parents[2] / "frontend" / "public" / "samples"


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    models = Models()
    index = []
    for scenario in SCENARIOS:
        image, parts = render(scenario)
        scene = analyze(image, models, Options(board="arduino_uno", quad=uno_quad().tolist(), full=False))
        fit = bb.locate(image)
        for number, part in enumerate(parts):
            terminals = []
            for true_node in part["terminals"]:
                point = node_xy(true_node, row=1)
                node, _ = bb.nearest_node(fit, point)
                terminals.append({"point": list(point), "node": node, "confidence": 0.9})
            scene["detections"].append({
                "id": f"{part['kind']}-sample-{number}",
                "kind": part["kind"],
                "label": "Sample part",
                "confidence": 0.9,
                "box": list(part["box"]),
                "source": "manual",
                "terminals": terminals,
            })
        scene["detections"].append({
            "id": "arduino_uno-sample",
            "kind": "arduino_uno",
            "label": "Sample board",
            "confidence": 0.95,
            "box": [90, 200, 522, 536],
            "source": "manual",
            "terminals": [],
        })
        scene["board"]["evidence"] = ["sample scene"]
        scene["warnings"] = []
        cv2.imwrite(str(OUT / f"{scenario.name}.jpg"), image, [cv2.IMWRITE_JPEG_QUALITY, 88])
        (OUT / f"{scenario.name}.json").write_text(json.dumps(scene), encoding="utf-8")
        index.append({"id": scenario.name, "title": scenario.title})
    (OUT / "index.json").write_text(json.dumps(index, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(index)} samples to {OUT}")


if __name__ == "__main__":
    main()
