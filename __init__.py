"""Interactive regional bounding-box conditioning for LTX 2.5."""

import json
import re
from pathlib import Path

from aiohttp import web
from server import PromptServer

from .node import LTXRegionalBBoxAnimator
from .regional_conditioning import (
    LTXApplyRegionalConditioning,
    LTXRegionalPrompt,
    LTXRegionalPromptFromImage,
)


NODE_CLASS_MAPPINGS = {
    "LTXRegionalBBoxAnimator": LTXRegionalBBoxAnimator,
    "LTXApplyRegionalConditioning": LTXApplyRegionalConditioning,
    "LTXRegionalPrompt": LTXRegionalPrompt,
    "LTXRegionalPromptFromImage": LTXRegionalPromptFromImage,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LTXRegionalBBoxAnimator": "LTX BBox Animator",
    "LTXApplyRegionalConditioning": "LTX Apply Regional Conditioning",
    "LTXRegionalPrompt": "LTX Regional Prompt (Mask)",
    "LTXRegionalPromptFromImage": "LTX Regional Prompt (Video Frames)",
}

WEB_DIRECTORY = "./web"
TEMPLATES_DIRECTORY = Path(__file__).resolve().parent / "templates"


@PromptServer.instance.routes.get("/ltx_bbox_animator/templates")
async def list_bbox_templates(request):
    templates = []
    if TEMPLATES_DIRECTORY.is_dir():
        for path in sorted(TEMPLATES_DIRECTORY.glob("*.json")):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                templates.append({
                    "id": path.stem,
                    "name": str(data.get("name", path.stem.replace("_", " ").title())),
                    "description": str(data.get("description", "")),
                    "object_count": len(data.get("objects", [])),
                })
            except (OSError, json.JSONDecodeError, TypeError, ValueError):
                continue
    return web.json_response({"templates": templates})


@PromptServer.instance.routes.get("/ltx_bbox_animator/templates/{template_id}")
async def get_bbox_template(request):
    template_id = request.match_info["template_id"]
    if not re.fullmatch(r"[A-Za-z0-9_-]+", template_id):
        raise web.HTTPBadRequest(text="Invalid template ID")
    path = TEMPLATES_DIRECTORY / f"{template_id}.json"
    if not path.is_file():
        raise web.HTTPNotFound(text="Template not found")
    try:
        return web.json_response(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, json.JSONDecodeError) as exc:
        raise web.HTTPInternalServerError(text=f"Cannot load template: {exc}") from exc


@PromptServer.instance.routes.post("/ltx_bbox_animator/templates")
async def save_bbox_template(request):
    try:
        data = await request.json()
    except (json.JSONDecodeError, ValueError):
        raise web.HTTPBadRequest(text="Invalid template JSON")
    if not isinstance(data, dict):
        raise web.HTTPBadRequest(text="Template must be a JSON object")
    name = str(data.get("name", "")).strip()
    if not name:
        raise web.HTTPBadRequest(text="Template name is required")
    if not isinstance(data.get("objects"), list) or not data["objects"]:
        raise web.HTTPBadRequest(text="Template must contain at least one object")
    slug = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")[:80] or "template"
    TEMPLATES_DIRECTORY.mkdir(parents=True, exist_ok=True)
    path = TEMPLATES_DIRECTORY / f"{slug}.json"
    suffix = 2
    while path.exists():
        path = TEMPLATES_DIRECTORY / f"{slug}_{suffix}.json"
        suffix += 1
    try:
        path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    except OSError as exc:
        raise web.HTTPInternalServerError(text=f"Cannot save template: {exc}") from exc
    return web.json_response({"id": path.stem, "name": name}, status=201)

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
