# ComfyUI LTX BBox Animator

A custom node for LTX 2.5 which adds support for bounding box control and regional prompting.

Requires this IC-Lora: [yuvraj108c/LTX-2.5-22b-IC-LoRA-Bbox]()

<img width="1200" height="400" alt="banner-1" src="https://github.com/user-attachments/assets/8a4ac3a4-8969-41ab-bc00-15eb2fd82fd9" />


## Key Features

- **Interactive editor**: Draw, resize, and animate bounding boxes.
- **Regional prompting**: Describe each object independently.
- **Keyframe interpolation**: Automatically interpolate bbox movements between frames.
- **Multiple objects**: Control several objects within the same scene.
- **Scene templates**: Load presets or save your own reusable layouts.
- **Reference images**: Use an image as a visual guide.

## Installation

1. Clone this repository into your ComfyUI `custom_nodes` directory:

   ```bash
   cd ComfyUI/custom_nodes
   git clone https://github.com/yuvraj108c/ComfyUI-LTX-BBox-Animator
   ```

2. Download [yuvraj108c/LTX-2.5-22b-IC-LoRA-Bbox]() to `models/loras`.

3. Restart ComfyUI and refresh your browser.

## Quick Start

1. Load the [example workflow]()
2. Set width/height/fps/frame count & open the bbox animator
3. Click Add object, draw its bounding box, and enter its regional prompt
4. Change position/size across time & click play to visualize movements
5. Save and close

## Prompting Guide

### Global Prompt

It's recommended to use the following structure. The word `where` connects the environment to the scene’s subjects and action. 
- Do not include detailed appearances here; those belong in the regional prompts.
- Mention the intended object count in the global scene, such as two people, three animals, or ten object

```text
style: [visual style, lighting, camera, and color treatment]
scene: [environment and setting], where [number and general type of objects perform the overall action].
```
Example:
```text
style: High-contrast cinematic street photography with crisp afternoon sunlight,
sharp shadows, steady eye-level framing, and natural colors.

scene: A modern glass office plaza with reflective skyscraper windows and polished
concrete, where two businesspeople walk across the frame.
```
### Regional Object Prompts

- Here, describe only the object assigned to each bounding box. Talk about appearance, clothing, materials etc
- Mentioning the objects’ positions can improve placement e.g walking from the left side toward the right

**Object 1**

```text
A businessman wearing a tailored charcoal-gray three-piece suit, a white shirt,
and polished black leather shoes, walking on the left side of the frame.
```

**Object 2**

```text
A businesswoman wearing a flowing scarlet-red silk dress and matching red
high-heeled shoes, walking on the right side of the frame.
```
## Prompt Weights

These values were used during training. Use them or feel free to experiment.

```text
regional_prompt_weight: 0.85
global_prompt_weight:   0.15
```


## Templates

Click **Templates** in the editor to load a complete scene or save the current scene as a reusable preset.

Included templates:
   - Single Walking Person
   - Two-Person Crossover
   - Ten-Object Café

Templates are stored in the `templates/` directory. Bounding boxes and keyframes use normalized values, so the same template automatically adapts to different resolutions and frame counts.

Set the desired frame count before loading a template. For example, a keyframe at 0.5 becomes frame 60 in a 121-frame video or frame 120 in a 241-frame video.

Use **Reset** to clear the current scene and start over.

## Generate Templates with LLM

Copy this prompt into any LLM, describe your scene, and save the generated JSON inside templates/:

```text
You are a scene designer for an LTX bounding-box animation system.

Generate a complete JSON scene template from the user's request. If the request is vague, invent a visually coherent scenario. If the request is detailed, follow it precisely.

Return only valid JSON. Do not include Markdown fences, explanations, or comments.

JSON structure:

{
  "version": 1,
  "name": "Short descriptive template name",
  "description": "Brief summary of the scene and motion",
  "style_prompt": "Lighting, visual style, camera framing, image quality, and color palette.",
  "scene_prompt": "A description of the environment, where the subjects perform their actions.",
  "objects": [
    {
      "name": "Short object name",
      "prompt": "Detailed visual description of this specific object.",
      "strength": 1.0,
      "enabled": true,
      "start_frame": 0.0,
      "end_frame": 1.0,
      "keyframes": [
        {
          "frame": 0.0,
          "box": [0.1, 0.2, 0.3, 0.8]
        },
        {
          "frame": 1.0,
          "box": [0.6, 0.2, 0.8, 0.8]
        }
      ]
    }
  ]
}

SCENE RULES

- "style_prompt" describes only visual style: lighting, camera perspective, atmosphere, image detail, and colors.
- "scene_prompt" describes the environment and summarizes what happens using the structure: "[environment], where [subjects and actions]."
- Mention the intended number of subjects when useful, such as "where exactly two people walk across the plaza."
- Do not place detailed clothing, colors, or individual identifying features in "scene_prompt"; reserve those details for the corresponding object prompt.
- Each object prompt describes only the object assigned to that bounding box.
- Include relevant appearance details: species, clothing, materials, colors, shape, accessories, expression, or posture.
- Use natural language, not tags such as "[obj_1]" or "[red_box]."
- Keep object prompts visually distinct.
- The number of objects must match the requested scenario.
- Objects may be people, animals, vehicles, furniture, products, architecture, or other visible subjects.

BOUNDING-BOX RULES

- Every box uses [x1, y1, x2, y2].
- Coordinates are normalized relative to the canvas:
  - x = 0.0 is the left edge.
  - x = 1.0 is the right edge.
  - y = 0.0 is the top edge.
  - y = 1.0 is the bottom edge.
- Always ensure x1 < x2 and y1 < y2.
- Coordinates outside 0.0–1.0 are allowed when an object enters or exits the frame.
- Match box proportions to the subject:
  - Standing person: narrow and tall.
  - Running animal: wider and shorter.
  - Street lamp: very narrow and tall.
  - Chair: moderately narrow and medium height.
  - Table: wider than tall unless viewed from an unusual angle.
- Place objects naturally relative to the environment and one another.
- Objects on the ground should generally share a believable ground line.
- Objects farther away should usually be smaller and positioned higher.
- Avoid unnecessary overlaps unless the requested scenario specifically involves crossings or occlusion.
- Keep enough separation between small objects for clear regional conditioning.

ANIMATION RULES

- "frame", "start_frame", and "end_frame" are normalized timeline positions between 0.0 and 1.0:
  - 0.0 means the first frame.
  - 0.5 means the middle frame.
  - 1.0 means the final frame.
- The system automatically adapts these values to any video length.
- Keyframes must be sorted by "frame" in ascending order.
- Include at least two keyframes per object, even for static objects.
- Static objects use identical boxes at frame 0.0 and frame 1.0.
- Moving objects should have enough keyframes to express the requested motion clearly.
- Use linear interpolation between keyframes when planning trajectories.
- For three crossovers, use four alternating endpoint keyframes, typically around frames 0.0, 0.333333, 0.666667, and 1.0.
- Resize boxes gradually to suggest movement toward or away from the camera.
- Objects can enter or leave the scene using boxes partly or entirely outside the visible canvas.
- Use "start_frame" and "end_frame" when an object should appear only during part of the video.
- Maintain plausible motion speed and avoid abrupt teleportation unless explicitly requested.
- "strength" should normally be 1.0.
- "enabled" should normally be true.

Before returning, verify that:
- The result is valid JSON.
- All required fields are present.
- Each object has a unique name.
- Every object has a nonempty prompt.
- Every object has at least two valid, chronologically ordered keyframes.
- Every box contains exactly four numeric values.
- All normalized timeline values are between 0.0 and 1.0.
- The environment, objects, positions, and motion match the requested scenario.

USER SCENARIO:
[DESCRIBE YOUR SCENARIO HERE]

Rules:
- Add one object per visible subject.
- Keep detailed appearances in object prompts, not the scene prompt.
- Each bbox is [x1, y1, x2, y2], normalized relative to the canvas.
- Match bbox size and proportions to each object.
- Frame values range from 0.0 to 1.0 and must be in ascending order.
- Add at least two keyframes per object; use identical boxes for static objects.
- Coordinates outside 0.0-1.0 are allowed for entering or exiting the frame.
- Create smooth, believable movement and avoid unnecessary overlaps.

Scenario: [DESCRIBE YOUR SCENE HERE]
```

## Node Interface

### LTX BBox Animator

#### Inputs

- **`clip`**: LTX text encoder used to encode the global scene and each object prompt.
- **`width` / `height`**: Output control-frame resolution.
- **`total_frames`**: Number of generated video frames.
- **`frame_rate`**: Playback rate used by the interactive editor.
- **`bbox_data_json`**: Serialized editor state; managed automatically.

#### Outputs

- **`control_images`**: ComfyUI `IMAGE` batch containing white animated bbox controls on a black background.
- **`global_conditioning`**: Encoded conditioning for the shared style and scene prompt.
- **`regions`**: Independently encoded object prompts paired with animated regional masks.
- **`global_prompt`**: Combined global prompt as a plain string.

### LTX Apply Regional Conditioning

#### Inputs

- **`model`**: LTX diffusion model, including the loaded bbox IC-LoRA.
- **`video_latent`**: Video-only latent before audio/video concatenation.
- **`regions`**: Regional conditioning generated by **LTX BBox Animator**.
- **`regional_prompt_weight`**: Relative contribution of object-specific prompts.
- **`global_prompt_weight`**: Relative contribution of the shared scene prompt.

#### Output

- **`model`**: Patched model with spatially restricted regional text conditioning.

## Notes

- Bounding-box colors in the editor are visual identifiers only and do not control the generated subject.
- Object prompts are encoded independently; they are not appended to the global prompt.
- The reference image is only an editor guide and is not sent to the model.
- More active objects increase text-conditioning memory usage.
- Smaller boxes and unusual object shapes can reduce prompt adherence.

## Support

If you like my projects and wish to see updates and new features, please consider supporting me. It helps a lot!

[![ComfyUI-Depth-Anything-Tensorrt](https://img.shields.io/badge/ComfyUI--Depth--Anything--Tensorrt-blue?style=flat-square)](https://github.com/yuvraj108c/ComfyUI-Depth-Anything-Tensorrt)
[![ComfyUI-Upscaler-Tensorrt](https://img.shields.io/badge/ComfyUI--Upscaler--Tensorrt-blue?style=flat-square)](https://github.com/yuvraj108c/ComfyUI-Upscaler-Tensorrt)
[![ComfyUI-Dwpose-Tensorrt](https://img.shields.io/badge/ComfyUI--Dwpose--Tensorrt-blue?style=flat-square)](https://github.com/yuvraj108c/ComfyUI-Dwpose-Tensorrt)
[![ComfyUI-Rife-Tensorrt](https://img.shields.io/badge/ComfyUI--Rife--Tensorrt-blue?style=flat-square)](https://github.com/yuvraj108c/ComfyUI-Rife-Tensorrt)

[![ComfyUI-Whisper](https://img.shields.io/badge/ComfyUI--Whisper-gray?style=flat-square)](https://github.com/yuvraj108c/ComfyUI-Whisper)
[![ComfyUI_InvSR](https://img.shields.io/badge/ComfyUI__InvSR-gray?style=flat-square)](https://github.com/yuvraj108c/ComfyUI_InvSR)
[![ComfyUI-FLOAT](https://img.shields.io/badge/ComfyUI--FLOAT-gray?style=flat-square)](https://github.com/yuvraj108c/ComfyUI-FLOAT)
[![ComfyUI-Thera](https://img.shields.io/badge/ComfyUI--Thera-gray?style=flat-square)](https://github.com/yuvraj108c/ComfyUI-Thera)
[![ComfyUI-Video-Depth-Anything](https://img.shields.io/badge/ComfyUI--Video--Depth--Anything-gray?style=flat-square)](https://github.com/yuvraj108c/ComfyUI-Video-Depth-Anything)
[![ComfyUI-PiperTTS](https://img.shields.io/badge/ComfyUI--PiperTTS-gray?style=flat-square)](https://github.com/yuvraj108c/ComfyUI-PiperTTS)

[![buy-me-coffees](https://i.imgur.com/3MDbAtw.png)](https://www.buymeacoffee.com/yuvraj108cZ)
[![paypal-donation](https://i.imgur.com/w5jjubk.png)](https://paypal.me/yuvraj108c)

## Acknowledgements
- Gemini and ChatGPT
- LTX 
