"""Interactive regional bounding-box conditioning for LTX 2.5."""

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

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
