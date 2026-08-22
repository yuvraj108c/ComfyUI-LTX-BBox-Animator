"""Generate training-matched LTX controls and independently encoded regions."""

from __future__ import annotations

import json
import logging
from collections import deque
from dataclasses import dataclass
from typing import Any

import numpy as np
import torch

from .regional_conditioning import LTXRegionalPrompt


LOGGER = logging.getLogger("ltx_regional_bbox")

BORDER_THICKNESS = 2
TRAIL_LENGTH = 5
TRAIL_THICKNESS = 1
DOT_RADIUS = 2
WHITE = np.uint8(255)


@dataclass(frozen=True)
class ObjectTrack:
    track_id: str
    name: str
    prompt: str
    strength: float
    start_frame: int
    end_frame: int
    keyframes: tuple[tuple[int, tuple[float, float, float, float]], ...]


def _encode_prompt(clip: Any, prompt: str) -> list:
    if not prompt.strip():
        raise ValueError("Cannot encode an empty prompt")
    tokens = clip.tokenize(prompt)
    if hasattr(clip, "encode_from_tokens_scheduled"):
        return clip.encode_from_tokens_scheduled(tokens)

    encoded = clip.encode_from_tokens(tokens, return_pooled=True, return_dict=True)
    if not isinstance(encoded, dict) or "cond" not in encoded:
        raise TypeError("CLIP encoder did not return a valid conditioning dictionary")
    conditioning = encoded.pop("cond")
    return [[conditioning, encoded]]


def _parse_project(raw: str, total_frames: int) -> tuple[str, str, list[ObjectTrack]]:
    try:
        project = json.loads(raw or "{}")
    except json.JSONDecodeError as exc:
        raise ValueError(f"BBox editor data is invalid JSON: {exc}") from exc

    if not isinstance(project, dict):
        raise ValueError("BBox editor data must be a JSON object")

    style = str(project.get("style_prompt", "")).strip()
    scene = str(project.get("scene_prompt", "")).strip()
    raw_tracks = project.get("objects")

    # Keep existing saved color-based projects usable during migration.
    if raw_tracks is None:
        raw_tracks = []
        old_keyframes = project.get("keyframes", {})
        old_prompts = project.get("layer_prompts", {})
        for track_id, frames in old_keyframes.items():
            raw_tracks.append({
                "id": str(track_id),
                "name": f"Object {len(raw_tracks) + 1}",
                "prompt": old_prompts.get(str(track_id), ""),
                "enabled": True,
                "strength": 1.0,
                "start_frame": 0,
                "end_frame": total_frames - 1,
                "keyframes": frames,
            })

    if not isinstance(raw_tracks, list):
        raise ValueError("BBox editor objects must be an array")

    tracks = []
    seen_ids = set()
    for index, item in enumerate(raw_tracks, 1):
        if not isinstance(item, dict) or not item.get("enabled", True):
            continue
        track_id = str(item.get("id", index))
        if track_id in seen_ids:
            raise ValueError(f"Duplicate object track ID: {track_id}")
        seen_ids.add(track_id)

        name = str(item.get("name", f"Object {index}")).strip() or f"Object {index}"
        prompt = str(item.get("prompt", "")).strip()
        if not prompt:
            raise ValueError(f"{name} has no regional prompt")

        raw_keyframes = item.get("keyframes", [])
        if not isinstance(raw_keyframes, list) or not raw_keyframes:
            raise ValueError(f"{name} has no bounding-box keyframes")

        parsed = {}
        for keyframe in raw_keyframes:
            if not isinstance(keyframe, dict):
                raise ValueError(f"{name} contains an invalid keyframe")
            frame = int(keyframe.get("frame", 0))
            if frame < 0 or frame >= total_frames:
                raise ValueError(f"{name} has keyframe {frame}, outside 0–{total_frames - 1}")
            box = keyframe.get("box", [])
            if not isinstance(box, (list, tuple)) or len(box) != 4:
                raise ValueError(f"{name} has an invalid bbox at frame {frame}")
            parsed[frame] = tuple(float(value) for value in box)

        start = max(0, min(total_frames - 1, int(item.get("start_frame", 0))))
        end = max(0, min(total_frames - 1, int(item.get("end_frame", total_frames - 1))))
        if end < start:
            raise ValueError(f"{name} has an end frame before its start frame")

        tracks.append(ObjectTrack(
            track_id=track_id,
            name=name,
            prompt=prompt,
            strength=max(0.0, min(5.0, float(item.get("strength", 1.0)))),
            start_frame=start,
            end_frame=end,
            keyframes=tuple(sorted(parsed.items())),
        ))

    if not tracks:
        raise ValueError("Add at least one enabled object with a prompt and bounding box")
    if not style:
        raise ValueError("The global style prompt is empty")
    if not scene:
        raise ValueError("The global scene prompt is empty")
    return style, scene, tracks


def _interpolate_box(track: ObjectTrack, frame: int, width: int, height: int):
    if frame < track.start_frame or frame > track.end_frame:
        return None

    keyframes = track.keyframes
    if frame <= keyframes[0][0]:
        values = keyframes[0][1]
    elif frame >= keyframes[-1][0]:
        values = keyframes[-1][1]
    else:
        values = keyframes[0][1]
        for (left_frame, left_box), (right_frame, right_box) in zip(keyframes, keyframes[1:]):
            if left_frame <= frame <= right_frame:
                ratio = (frame - left_frame) / max(1, right_frame - left_frame)
                values = tuple(a + (b - a) * ratio for a, b in zip(left_box, right_box))
                break

    x1, y1, x2, y2 = (int(round(value)) for value in values)
    x1, x2 = sorted((max(0, min(width, x1)), max(0, min(width, x2))))
    y1, y2 = sorted((max(0, min(height, y1)), max(0, min(height, y2))))
    if x2 <= x1 or y2 <= y1:
        return None
    return x1, y1, x2, y2


def _draw_control(canvas: np.ndarray, box: tuple[int, int, int, int], history: deque) -> None:
    x1, y1, x2, y2 = box
    thickness = min(BORDER_THICKNESS, x2 - x1, y2 - y1)
    canvas[y1:y1 + thickness, x1:x2] = WHITE
    canvas[y2 - thickness:y2, x1:x2] = WHITE
    canvas[y1:y2, x1:x1 + thickness] = WHITE
    canvas[y1:y2, x2 - thickness:x2] = WHITE

    for start, end in zip(history, list(history)[1:]):
        steps = max(abs(end[0] - start[0]), abs(end[1] - start[1]), 1) + 1
        line_x = np.rint(np.linspace(start[0], end[0], steps)).astype(np.int32)
        line_y = np.rint(np.linspace(start[1], end[1], steps)).astype(np.int32)
        radius = max(0, TRAIL_THICKNESS - 1)
        for offset_y in range(-radius, radius + 1):
            for offset_x in range(-radius, radius + 1):
                draw_x, draw_y = line_x + offset_x, line_y + offset_y
                valid = (draw_x >= x1) & (draw_x < x2) & (draw_y >= y1) & (draw_y < y2)
                canvas[draw_y[valid], draw_x[valid]] = WHITE

    if history:
        center_x, center_y = history[-1]
        left, top = max(x1, center_x - DOT_RADIUS), max(y1, center_y - DOT_RADIUS)
        right, bottom = min(x2, center_x + DOT_RADIUS + 1), min(y2, center_y + DOT_RADIUS + 1)
        if right > left and bottom > top:
            yy, xx = np.ogrid[top:bottom, left:right]
            dot = (xx - center_x) ** 2 + (yy - center_y) ** 2 <= (DOT_RADIUS + 0.5) ** 2
            canvas[top:bottom, left:right][dot] = WHITE


class LTXRegionalBBoxAnimator:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "clip": ("CLIP",),
                "width": ("INT", {"default": 768, "min": 64, "max": 4096, "step": 32}),
                "height": ("INT", {"default": 448, "min": 64, "max": 4096, "step": 32}),
                "total_frames": ("INT", {"default": 121, "min": 1, "max": 4096, "step": 1}),
                "frame_rate": ("FLOAT", {"default": 24.0, "min": 1.0, "max": 120.0, "step": 0.1}),
                "bbox_data_json": ("STRING", {"default": "{}", "multiline": False}),
            },
        }

    RETURN_TYPES = ("IMAGE", "CONDITIONING", "LTX_REGIONS", "STRING")
    RETURN_NAMES = ("control_images", "global_conditioning", "regions", "global_prompt")
    FUNCTION = "generate"
    CATEGORY = "LTX/BBox Animator"

    def generate(self, clip, width, height, total_frames, frame_rate, bbox_data_json):
        del frame_rate  # Frame rate controls editor playback; IMAGE batches carry no FPS metadata.
        style, scene, tracks = _parse_project(bbox_data_json, total_frames)
        global_prompt = f"style: {style}\nscene: {scene}"

        controls = np.zeros((total_frames, height, width), dtype=np.uint8)
        masks = {track.track_id: np.zeros((total_frames, height, width), dtype=np.uint8) for track in tracks}
        histories = {track.track_id: deque(maxlen=TRAIL_LENGTH) for track in tracks}

        for frame in range(total_frames):
            for track in tracks:
                box = _interpolate_box(track, frame, width, height)
                if box is None:
                    histories[track.track_id].clear()
                    continue
                x1, y1, x2, y2 = box
                masks[track.track_id][frame, y1:y2, x1:x2] = WHITE
                histories[track.track_id].append(((x1 + x2) // 2, (y1 + y2) // 2))
                _draw_control(controls[frame], box, histories[track.track_id])

        controls_tensor = torch.from_numpy(np.repeat(controls[..., None], 3, axis=-1)).float().div_(255.0)
        global_conditioning = _encode_prompt(clip, global_prompt)

        regions = ()
        for track in tracks:
            mask = torch.from_numpy(masks[track.track_id]).float().div_(255.0)
            if not bool(mask.any()):
                raise ValueError(f"{track.name} never appears inside the video frame")
            object_conditioning = _encode_prompt(clip, track.prompt)
            regions = LTXRegionalPrompt().add(object_conditioning, mask, track.strength, regions)[0]
            LOGGER.info(
                "Prepared regional object %s: %s, %d keyframes, strength %.2f, frames %d-%d",
                track.track_id, track.name, len(track.keyframes), track.strength,
                track.start_frame, track.end_frame,
            )

        LOGGER.info(
            "Generated regional bbox controls: %dx%d, %d frames, %d objects; "
            "white border=%dpx, trail=%d frames, dot radius=%dpx",
            width, height, total_frames, len(tracks), BORDER_THICKNESS, TRAIL_LENGTH, DOT_RADIUS,
        )
        return controls_tensor, global_conditioning, regions, global_prompt
