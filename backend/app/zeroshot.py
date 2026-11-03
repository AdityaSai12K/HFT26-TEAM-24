"""Zero-shot models: YOLO-World proposes regions, CLIP names them.

Measured on real bench photos, YOLO-World alone scored these parts at 0.03-0.25
and mostly mislabelled them, while CLIP named the board correctly in every photo
tried. So a YOLO-World box is only a proposal, and CLIP decides what it is.

Both models are optional: if they cannot load, the OpenCV stages keep working
and the Scene carries a warning.
"""
from __future__ import annotations

import logging
import os
from pathlib import Path

import cv2
import numpy as np

from .boards import BOARD_IDS, load_pinout

log = logging.getLogger("visionguard")

WEIGHTS = Path(os.environ.get("VG_WEIGHTS_DIR", Path(__file__).resolve().parents[1] / "weights"))
YOLO_MODEL = os.environ.get("VG_YOLO_MODEL", "yolov8s-worldv2.pt")
CLIP_MODEL = "ViT-B/32"

# Each prompt only proposes a box for CLIP to name, so synonyms just widen the net.
YOLO_PROMPTS = [
    "led", "light emitting diode", "resistor", "axial lead resistor", "push button", "tactile switch",
    "capacitor", "electrolytic capacitor", "integrated circuit", "microchip", "usb connector", "pin header",
]
# An empty class gives the model somewhere to put everything else, which raised
# scores from about 0.1 and found LEDs the plain prompts missed on real photos.
# Ultralytics documents this as scene-dependent, so recheck it on real photos.
YOLO_BACKGROUND = ""
YOLO_MIN_CONFIDENCE = 0.02

BOARD_PROMPTS = {
    **{board_id: load_pinout(board_id)["vision"]["clipPrompt"] for board_id in BOARD_IDS},
    None: "a photo of a white solderless breadboard",
    "background": "a photo of a desk",
}

PART_PROMPTS = {
    "resistor": "a photo of a resistor with colored bands",
    "led": "a photo of a light emitting diode LED",
    "button": "a photo of a tactile push button switch",
    "capacitor": "a photo of an electrolytic capacitor",
    "microcontroller": "a photo of a black integrated circuit chip",
    "usb_port": "a photo of a metal USB connector",
    "pin_header": "a photo of a black pin header strip",
    "jumper_wire": "a photo of jumper wires",
    "breadboard": "a photo of an empty white breadboard",
    "background": "a photo of a wooden desk",
}
# Named so CLIP can reject them, but not reported as parts.
REJECT = {"background", "breadboard", "jumper_wire"}


def pick_device() -> str:
    """The fastest device torch can use here. Without torch the models are off anyway."""
    try:
        import torch
    except ImportError:
        return "cpu"
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


class Models:
    def __init__(self):
        self.yolo = None
        self.clip = None
        self.preprocess = None
        self.text: dict[str, object] = {}
        self.errors: list[str] = []
        self.device = "cpu"

    def load(self) -> None:
        WEIGHTS.mkdir(parents=True, exist_ok=True)
        self.device = pick_device()
        log.info("Running the models on %s", self.device)
        try:
            self._load_clip()
        except Exception as error:  # A missing model must not stop the OpenCV stages.
            log.exception("CLIP failed to load")
            self.errors.append(f"CLIP unavailable ({error}), so board identification and part names are off.")
        try:
            self._load_yolo()
        except Exception as error:
            log.exception("YOLO-World failed to load")
            self.errors.append(f"YOLO-World unavailable ({error}), so fewer parts will be proposed.")

    def _load_clip(self) -> None:
        import clip
        import torch

        self.clip, self.preprocess = clip.load(CLIP_MODEL, device=self.device, download_root=str(WEIGHTS))
        # CLIP loads as half precision on a GPU. Full precision gives every device the same scores.
        self.clip.float().eval()
        with torch.no_grad():
            for name, prompts in (("board", BOARD_PROMPTS), ("part", PART_PROMPTS)):
                features = self.clip.encode_text(clip.tokenize(list(prompts.values())).to(self.device))
                self.text[name] = features / features.norm(dim=-1, keepdim=True)

    def _load_yolo(self) -> None:
        from ultralytics import YOLOWorld

        previous = Path.cwd()
        os.chdir(WEIGHTS)  # Ultralytics resolves and downloads weights relative to the working directory.
        try:
            self.yolo = YOLOWorld(YOLO_MODEL)
            self.yolo.set_classes([*YOLO_PROMPTS, YOLO_BACKGROUND])
        finally:
            os.chdir(previous)

    def _classify(self, crops: list[np.ndarray], text_key: str) -> np.ndarray:
        import torch
        from PIL import Image

        images = [self.preprocess(Image.fromarray(cv2.cvtColor(c, cv2.COLOR_BGR2RGB))) for c in crops]
        with torch.no_grad():
            features = self.clip.encode_image(torch.stack(images).to(self.device))
            features /= features.norm(dim=-1, keepdim=True)
            return (100 * features @ self.text[text_key].T).softmax(dim=-1).cpu().numpy()

    def identify_board(self, bgr: np.ndarray) -> tuple[str | None, float, str]:
        """Returns (board id or None, probability, evidence)."""
        if self.clip is None:
            return None, 0.0, "board model unavailable"
        probabilities = self._classify([bgr], "board")[0]
        labels = list(BOARD_PROMPTS.keys())
        best = int(probabilities.argmax())
        label = labels[best]
        if label not in BOARD_IDS:
            return None, float(probabilities[best]), "no development board recognised"
        return label, float(probabilities[best]), f"CLIP scored {probabilities[best]:.0%} for this board"

    def label_crops(self, crops: list[np.ndarray]) -> list[tuple[str, float]]:
        if self.clip is None or not crops:
            return []
        labels = list(PART_PROMPTS.keys())
        return [(labels[int(row.argmax())], float(row.max())) for row in self._classify(crops, "part")]

    def propose(self, bgr: np.ndarray) -> list[tuple[float, float, float, float, float]]:
        """YOLO-World boxes as (x1, y1, x2, y2, score)."""
        if self.yolo is None:
            return []
        # Asking only for the real classes keeps background boxes out of the proposals.
        classes = list(range(len(YOLO_PROMPTS)))
        result = self.yolo.predict(bgr, conf=YOLO_MIN_CONFIDENCE, iou=0.5, imgsz=640, verbose=False, max_det=30, device=self.device, classes=classes)[0]
        return [(*box, score) for box, score in zip(result.boxes.xyxy.tolist(), result.boxes.conf.tolist())]
