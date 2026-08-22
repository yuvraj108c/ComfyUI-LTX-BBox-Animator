"""ComfyUI custom nodes for LTX 2.5 regional video-prompt conditioning.

Copy this file into ComfyUI/custom_nodes/ and restart ComfyUI.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass

import torch
import torch.nn.functional as F


LOGGER = logging.getLogger("ltx_regional_bbox")


@dataclass(frozen=True)
class Region:
    embedding: torch.Tensor
    mask: torch.Tensor
    strength: float
    unprocessed: bool = False


def _conditioning_embedding(conditioning):
    if not conditioning or not isinstance(conditioning[0], (list, tuple)):
        raise ValueError("Expected conditioning from CLIP Text Encode")
    embedding = conditioning[0][0]
    if embedding.ndim != 3:
        raise ValueError(f"Expected [batch,tokens,channels] text embeddings; got {tuple(embedding.shape)}")
    metadata = conditioning[0][1] if len(conditioning[0]) > 1 else {}
    if not isinstance(metadata, dict):
        metadata = {}

    token_mask = None
    mask_source = None
    for key in ("attention_mask", "text_embedding_mask", "prompt_attention_mask"):
        candidate = metadata.get(key)
        if isinstance(candidate, torch.Tensor):
            candidate = candidate.detach().squeeze()
            if candidate.ndim == 1 and candidate.shape[0] == embedding.shape[1]:
                token_mask = candidate > 0
                mask_source = key
                break

    if token_mask is None:
        for key in ("num_tokens", "token_count", "valid_tokens"):
            candidate = metadata.get(key)
            if isinstance(candidate, (list, tuple)) and candidate:
                candidate = candidate[0]
            if isinstance(candidate, torch.Tensor) and candidate.numel() == 1:
                candidate = int(candidate.item())
            if isinstance(candidate, int) and 0 < candidate <= embedding.shape[1]:
                token_mask = torch.arange(embedding.shape[1], device=embedding.device) < candidate
                mask_source = key
                break

    if token_mask is None:
        return embedding

    token_mask = token_mask.to(device=embedding.device)
    valid_count = int(token_mask.sum().item())
    if valid_count == 0:
        raise ValueError("Regional text attention mask contains no valid prompt tokens")
    trimmed = embedding[:, token_mask]
    LOGGER.info(
        "Trimmed regional prompt padding: %d -> %d text tokens using %s",
        embedding.shape[1], valid_count, mask_source,
    )
    return trimmed


def _normalize_mask(mask):
    if mask.ndim == 4:
        if mask.shape[-1] in (1, 3, 4):
            mask = mask[..., :3].float().mean(dim=-1)
        elif mask.shape[1] == 1:
            mask = mask[:, 0]
        else:
            raise ValueError(f"Unsupported mask/image shape: {tuple(mask.shape)}")
    elif mask.ndim == 2:
        mask = mask.unsqueeze(0)
    if mask.ndim != 3:
        raise ValueError(f"Expected mask video [frames,height,width]; got {tuple(mask.shape)}")
    mask = mask.detach().float().cpu()
    if mask.numel() == 0 or mask.max() <= 0:
        raise ValueError("Regional mask is empty")
    if mask.max() > 1:
        mask /= 255.0
    return mask.clamp(0, 1)


def _latent_mask(mask, latent_frames, latent_height, latent_width, device):
    source = mask.unsqueeze(1)
    # Match the trainer's conservative spatial max-pooling: any covered pixel
    # inside a latent cell makes that video token visible to its object prompt.
    spatial = F.adaptive_max_pool2d(source, (latent_height, latent_width))[:, 0]
    if spatial.shape[0] == 1:
        result = spatial.expand(latent_frames, -1, -1)
    elif spatial.shape[0] == latent_frames:
        result = spatial
    elif spatial.shape[0] >= 2 and latent_frames >= 2:
        first = spatial[:1]
        tail = spatial[1:]
        bins = []
        for index in range(latent_frames - 1):
            start = index * tail.shape[0] // (latent_frames - 1)
            end = max(start + 1, (index + 1) * tail.shape[0] // (latent_frames - 1))
            bins.append(tail[start:end].amax(dim=0))
        result = torch.cat([first, torch.stack(bins)], dim=0)
    else:
        result = spatial[:1].expand(latent_frames, -1, -1)
    return (result > 0.5).reshape(-1).to(device=device)


class LTXRegionalPrompt:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "conditioning": ("CONDITIONING",),
                "mask": ("MASK",),
                "strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 5.0, "step": 0.05}),
            },
            "optional": {"previous_regions": ("LTX_REGIONS",)},
        }

    RETURN_TYPES = ("LTX_REGIONS",)
    RETURN_NAMES = ("regions",)
    FUNCTION = "add"
    CATEGORY = "LTX/BBox Animator"

    def add(self, conditioning, mask, strength, previous_regions=None):
        regions = list(previous_regions or ())
        metadata = conditioning[0][1] if len(conditioning[0]) > 1 else {}
        unprocessed = bool(metadata.get("unprocessed_ltxav_embeds", False)) if isinstance(metadata, dict) else False
        regions.append(Region(
            _conditioning_embedding(conditioning).detach().cpu(),
            _normalize_mask(mask),
            float(strength),
            unprocessed,
        ))
        LOGGER.info(
            "Added LTX regional prompt %d: %d %s text tokens, %d mask frames",
            len(regions), regions[-1].embedding.shape[1],
            "unprocessed" if unprocessed else "processed", regions[-1].mask.shape[0],
        )
        return (tuple(regions),)


class LTXRegionalPromptFromImage:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "conditioning": ("CONDITIONING",),
                "mask_images": ("IMAGE",),
                "strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 5.0, "step": 0.05}),
            },
            "optional": {"previous_regions": ("LTX_REGIONS",)},
        }

    RETURN_TYPES = ("LTX_REGIONS",)
    RETURN_NAMES = ("regions",)
    FUNCTION = "add"
    CATEGORY = "LTX/BBox Animator"

    def add(self, conditioning, mask_images, strength, previous_regions=None):
        return LTXRegionalPrompt().add(conditioning, _normalize_mask(mask_images), strength, previous_regions)


class _RoutingState:
    def __init__(self, regions, latent_shape, regional_weight, global_weight, diffusion_model):
        self.regions = regions
        self.latent_shape = latent_shape
        self.regional_weight = regional_weight
        self.global_weight = global_weight
        self.diffusion_model = diffusion_model
        self.global_tokens = None
        self.token_lengths = None
        self.log_once = False
        self.lock = threading.RLock()
        self.processed_regions = {}

    def _processed_embedding(self, region, index, context):
        cache_key = (index, str(context.device), context.dtype)
        cached = self.processed_regions.get(cache_key)
        if cached is not None:
            return cached

        embedding = region.embedding.to(device=context.device, dtype=context.dtype)
        if region.unprocessed:
            preprocess = getattr(self.diffusion_model, "preprocess_text_embeds", None)
            if preprocess is None:
                raise RuntimeError(
                    "Regional conditioning contains unprocessed LTX embeddings, "
                    "but the diffusion model does not expose preprocess_text_embeds"
                )
            with torch.inference_mode():
                embedding = preprocess(embedding, unprocessed=True)
            LOGGER.info(
                "Processed LTX regional prompt %d through the model's text connectors: "
                "%d raw tokens -> %d connector tokens, %d channels",
                index + 1, region.embedding.shape[1], embedding.shape[1], embedding.shape[-1],
            )

        if embedding.shape[-1] != context.shape[-1]:
            raise ValueError(
                f"Processed regional embedding channels {embedding.shape[-1]} do not "
                f"match processed global channels {context.shape[-1]}"
            )
        self.processed_regions[cache_key] = embedding.detach()
        return self.processed_regions[cache_key]

    def wrap_model(self, model_function, args):
        payload = dict(args.get("c", {}))
        context = payload.get("c_crossattn")
        if context is None:
            raise RuntimeError("LTX regional routing: sampler did not provide c_crossattn")
        self.global_tokens = context.shape[1]
        # ComfyUI processes the global prompt in LTXAV.extra_conds before the
        # model wrapper runs. Regional CLIP outputs must pass through exactly
        # the same video/audio embedding connectors before being appended.
        pieces = [context]
        lengths = []
        for index, region in enumerate(self.regions):
            emb = self._processed_embedding(region, index, context)
            if emb.shape[0] == 1 and context.shape[0] != 1:
                emb = emb.expand(context.shape[0], -1, -1)
            pieces.append(emb)
            lengths.append(emb.shape[1])
        self.token_lengths = lengths
        payload["c_crossattn"] = torch.cat(pieces, dim=1)
        options = dict(payload.get("transformer_options", {}))
        options["ltx_regional_cond_or_uncond"] = list(args.get("cond_or_uncond", options.get("cond_or_uncond", [0])))
        payload["transformer_options"] = options
        return model_function(args["input"], args["timestep"], **payload)

    def attention_mask(self, queries, context, transformer_options, original_mask=None):
        if self.global_tokens is None or self.token_lengths is None:
            raise RuntimeError("LTX regional routing was invoked before the model wrapper")
        batch, query_count = queries.shape[:2]
        frames, height, width = self.latent_shape
        generated_count = frames * height * width
        if generated_count > query_count:
            # The second upscale stage can change the active grid.
            ratio = query_count / max(frames, 1)
            aspect = width / max(height, 1)
            inferred_height = max(1, round((ratio / aspect) ** 0.5))
            inferred_width = max(1, round(inferred_height * aspect))
            if frames * inferred_height * inferred_width <= query_count:
                height, width = inferred_height, inferred_width
                generated_count = frames * height * width
            else:
                generated_count = query_count
        elif query_count > generated_count and query_count % frames == 0:
            candidate_area = query_count // frames
            candidate_h = round((candidate_area * height / max(width, 1)) ** 0.5)
            candidate_w = round(candidate_h * width / max(height, 1))
            if candidate_h * candidate_w == candidate_area and candidate_area >= height * width:
                height, width = candidate_h, candidate_w
                generated_count = query_count

        token_count = context.shape[1]
        visible = torch.zeros((batch, query_count, token_count), device=queries.device, dtype=torch.bool)
        visible[:, :, :self.global_tokens] = True
        flags = transformer_options.get("ltx_regional_cond_or_uncond", transformer_options.get("cond_or_uncond", [0]))
        if not flags:
            flags = [0]
        offset = self.global_tokens
        for region, length in zip(self.regions, self.token_lengths):
            ownership = _latent_mask(region.mask, frames, height, width, queries.device)
            owned_count = min(generated_count, ownership.numel(), query_count)
            for batch_index in range(batch):
                flag = flags[min(batch_index, len(flags) - 1)]
                if flag == 0:
                    visible[batch_index, :owned_count, offset:offset + length] = ownership[:owned_count].unsqueeze(-1)
            offset += length

        additive = torch.zeros((batch, 1, query_count, token_count), device=queries.device, dtype=queries.dtype)
        additive.masked_fill_(~visible.unsqueeze(1), torch.finfo(queries.dtype).min)
        # Preserve the encoder's original global padding mask. Previously all
        # 373 global token slots were marked visible, including padded tokens.
        if isinstance(original_mask, torch.Tensor) and original_mask.shape[-1] == self.global_tokens:
            existing = original_mask.to(device=queries.device)
            if existing.ndim == 2:
                existing = existing[:, None, None, :]
            elif existing.ndim == 3:
                existing = existing[:, None, :, :]
            if existing.dtype == torch.bool or not torch.is_floating_point(existing):
                existing = torch.where(
                    existing > 0,
                    torch.zeros((), device=queries.device, dtype=queries.dtype),
                    torch.full((), torch.finfo(queries.dtype).min, device=queries.device, dtype=queries.dtype),
                )
            else:
                existing = existing.to(dtype=queries.dtype)
            if existing.shape[-2] in (1, query_count):
                additive[:, :, :, :self.global_tokens] += existing
        if not self.log_once:
            LOGGER.info("LTX regional attention active: regions=%d, video queries=%d, generated=%d, text tokens=%d, grid=%dx%dx%d, weights=%.2f/%.2f", len(self.regions), query_count, generated_count, token_count, frames, height, width, self.regional_weight, self.global_weight)
            self.log_once = True
        return additive


def _make_block_patch(block, state):
    def patch(args, extra):
        original = extra["original_block"]
        video_attention = block.attn2
        audio_attention = getattr(block, "audio_attn2", None)
        video_forward = video_attention.forward
        audio_forward = audio_attention.forward if audio_attention is not None else None

        def regional_video_forward(x, context=None, mask=None, **kwargs):
            routing_mask = state.attention_mask(
                x, context, kwargs.get("transformer_options", {}), args.get("attention_mask")
            )
            return video_forward(x, context=context, mask=routing_mask, **kwargs)

        def global_audio_forward(x, context=None, mask=None, **kwargs):
            return audio_forward(x, context=context[:, :state.global_tokens], mask=None, **kwargs)

        with state.lock:
            video_attention.forward = regional_video_forward
            if audio_attention is not None:
                audio_attention.forward = global_audio_forward
            try:
                clean_args = dict(args)
                # Apply prompt weights after LTX has split and projected its
                # joint audio/video text conditioning, matching the trainer.
                video_context = args["v_context"].clone()
                video_context[:, :state.global_tokens] *= state.global_weight
                offset = state.global_tokens
                for region, length in zip(state.regions, state.token_lengths or ()):
                    video_context[:, offset:offset + length] *= state.regional_weight * region.strength
                    offset += length
                clean_args["v_context"] = video_context
                clean_args["attention_mask"] = None
                return original(clean_args)
            finally:
                video_attention.forward = video_forward
                if audio_attention is not None:
                    audio_attention.forward = audio_forward

    return patch


class LTXApplyRegionalConditioning:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "video_latent": ("LATENT",),
                "regions": ("LTX_REGIONS",),
                "regional_prompt_weight": ("FLOAT", {"default": 0.85, "min": 0.0, "max": 2.0, "step": 0.05}),
                "global_prompt_weight": ("FLOAT", {"default": 0.15, "min": 0.0, "max": 2.0, "step": 0.05}),
            },
        }

    RETURN_TYPES = ("MODEL",)
    RETURN_NAMES = ("model",)
    FUNCTION = "apply"
    CATEGORY = "LTX/BBox Animator"

    def apply(self, model, video_latent, regions, regional_prompt_weight, global_prompt_weight):
        if not regions:
            raise ValueError("Add at least one LTX Regional Prompt node")
        samples = video_latent.get("samples")
        if not isinstance(samples, torch.Tensor) or samples.ndim != 5:
            raise ValueError("video_latent must be the video-only LATENT before LTXVConcatAVLatent; expected [B,C,F,H,W]")
        diffusion_model = getattr(getattr(model, "model", None), "diffusion_model", None)
        blocks = getattr(diffusion_model, "transformer_blocks", None)
        if not blocks:
            raise TypeError("Expected an LTX audio/video diffusion model with transformer_blocks")
        if not hasattr(blocks[0], "attn2"):
            raise TypeError("Transformer blocks do not expose the expected LTX video text cross-attention")
        clone = model.clone()
        state = _RoutingState(
            tuple(regions), tuple(int(value) for value in samples.shape[-3:]),
            float(regional_prompt_weight), float(global_prompt_weight), diffusion_model,
        )
        existing = clone.model_options.get("model_function_wrapper")
        if existing is not None:
            def chained(model_function, args):
                return state.wrap_model(lambda x, timestep, **kwargs: existing(model_function, {**args, "input": x, "timestep": timestep, "c": kwargs}), args)
            clone.set_model_unet_function_wrapper(chained)
        else:
            clone.set_model_unet_function_wrapper(state.wrap_model)
        for index, block in enumerate(blocks):
            clone.set_model_patch_replace(_make_block_patch(block, state), "dit", "double_block", index)
        LOGGER.info("Installed LTX regional conditioning on %d transformer blocks for %d regions; latent grid=%s", len(blocks), len(regions), state.latent_shape)
        return (clone,)


NODE_CLASS_MAPPINGS = {
    "LTXRegionalPrompt": LTXRegionalPrompt,
    "LTXRegionalPromptFromImage": LTXRegionalPromptFromImage,
    "LTXApplyRegionalConditioning": LTXApplyRegionalConditioning,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LTXRegionalPrompt": "LTX Regional Prompt (Mask)",
    "LTXRegionalPromptFromImage": "LTX Regional Prompt (Video Frames)",
    "LTXApplyRegionalConditioning": "LTX Apply Regional Conditioning",
}
