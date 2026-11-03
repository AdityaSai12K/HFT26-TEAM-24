"""VisionGuard vision API."""
from __future__ import annotations

import json
import logging
import os
from contextlib import asynccontextmanager
from typing import Annotated

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware

from .boards import BOARD_IDS
from .pipeline import Options, analyze
from .zeroshot import Models

logging.basicConfig(level=logging.INFO)
MAX_UPLOAD_BYTES = 25 * 1024 * 1024
ORIGINS = os.environ.get("VG_ALLOWED_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000").split(",")

models = Models()


@asynccontextmanager
async def lifespan(_: FastAPI):
    await run_in_threadpool(models.load)
    yield


app = FastAPI(title="VisionGuard vision API", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=ORIGINS, allow_methods=["GET", "POST"], allow_headers=["*"])


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "clip": models.clip is not None, "yolo": models.yolo is not None, "device": models.device, "errors": models.errors}


def _parse_quad(raw: str | None) -> list[list[float]] | None:
    if not raw:
        return None
    try:
        quad = json.loads(raw)
        valid = len(quad) == 4 and all(len(corner) == 2 for corner in quad)
        array = np.array(quad, dtype=np.float64)
    except (ValueError, TypeError) as error:
        raise HTTPException(422, "quad must be four [x, y] corners") from error
    if not valid or not np.isfinite(array).all():
        raise HTTPException(422, "quad must be four [x, y] corners")
    return array.tolist()


@app.post("/detect")
async def detect(
    image: Annotated[UploadFile, File()],
    board: Annotated[str | None, Form()] = None,
    quad: Annotated[str | None, Form()] = None,
    full: Annotated[bool, Form()] = True,
) -> dict:
    if board is not None and board not in BOARD_IDS:
        raise HTTPException(422, f"board must be one of {', '.join(BOARD_IDS)}")
    corners = _parse_quad(quad)
    data = await image.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "Image is larger than 25 MB")
    decoded = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if decoded is None:
        raise HTTPException(422, "Could not decode that image")
    return await run_in_threadpool(analyze, decoded, models, Options(board=board, quad=corners, full=full))
