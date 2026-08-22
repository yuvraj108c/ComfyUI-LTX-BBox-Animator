import { app } from "../../../scripts/app.js";

const EDITOR_COLORS = ["#71e2ff", "#ff7896", "#a8ef73", "#ffcd67", "#bc9cff", "#ff93dc", "#6ee7c1", "#ff9b6b"];
const NODE_NAME = "LTXRegionalBBoxAnimator";
const MAX_HISTORY = 80;

app.registerExtension({
    name: "ltx.regional.bbox.animator",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;
        const previous = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            previous?.apply(this, arguments);
            const button = this.addWidget("button", "Open BBox Animator", null, () => openEditor(this));
            button.serialize_needed = false;
            const json = this.widgets?.find((widget) => widget.name === "bbox_data_json");
            if (json) {
                json.type = "hidden";
                json.computeSize = () => [0, -4];
                if (json.element) json.element.style.display = "none";
            }
            this.setSize?.([Math.max(this.size[0], 330), this.computeSize?.()[1] ?? this.size[1]]);
        };
    },
});

function widgetValue(node, name, fallback) {
    const index = node.findInputSlot?.(name) ?? -1;
    if (index >= 0 && node.isInputConnected?.(index)) {
        let source = node.getInputNode?.(index);
        while (source && (source.type === "Reroute" || source.comfyClass === "Reroute")) source = source.getInputNode?.(0);
        const widget = source?.widgets?.find((item) => item.name === "value") ?? source?.widgets?.[0];
        if (widget?.value != null) return widget.value;
    }
    return node.widgets?.find((item) => item.name === name)?.value ?? fallback;
}

function uid() {
    return globalThis.crypto?.randomUUID?.() ?? `track-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function clamp(value, lower, upper) {
    return Math.max(lower, Math.min(upper, value));
}

function loadProject(widget, frameCount) {
    let data = {};
    try {
        data = JSON.parse(widget?.element?.value || widget?.value || "{}");
    } catch {
        data = {};
    }
    const objects = Array.isArray(data.objects)
        ? data.objects
        : Object.entries(data.keyframes || {}).map(([id, keyframes], index) => ({
            id,
            name: `Object ${index + 1}`,
            prompt: data.layer_prompts?.[id] || "",
            keyframes,
            strength: 1,
            enabled: true,
            start_frame: 0,
            end_frame: frameCount - 1,
        }));
    return {
        version: 2,
        style_prompt: data.style_prompt || "",
        scene_prompt: data.scene_prompt || "",
        objects: objects.map((object, index) => ({
            id: String(object.id ?? uid()),
            name: object.name || `Object ${index + 1}`,
            prompt: object.prompt || "",
            strength: Number.isFinite(Number(object.strength)) ? Number(object.strength) : 1,
            enabled: object.enabled !== false,
            start_frame: clamp(Number(object.start_frame ?? 0), 0, frameCount - 1),
            end_frame: clamp(Number(object.end_frame ?? frameCount - 1), 0, frameCount - 1),
            color: object.color || EDITOR_COLORS[index % EDITOR_COLORS.length],
            keyframes: (object.keyframes || []).map((keyframe) => ({
                frame: clamp(Number(keyframe.frame) || 0, 0, frameCount - 1),
                box: keyframe.box.map(Number),
            })).sort((a, b) => a.frame - b.frame),
        })),
        bg_image_base64: data.bg_image_base64 || "",
        bg_opacity: Number.isFinite(Number(data.bg_opacity)) ? Number(data.bg_opacity) : 0.45,
    };
}

function interpolatedBox(object, frame) {
    if (!object || frame < object.start_frame || frame > object.end_frame || !object.keyframes.length) return null;
    const keys = object.keyframes;
    if (frame <= keys[0].frame) return [...keys[0].box];
    if (frame >= keys.at(-1).frame) return [...keys.at(-1).box];
    for (let index = 0; index < keys.length - 1; index++) {
        const left = keys[index];
        const right = keys[index + 1];
        if (frame >= left.frame && frame <= right.frame) {
            const ratio = (frame - left.frame) / Math.max(1, right.frame - left.frame);
            return left.box.map((value, axis) => value + (right.box[axis] - value) * ratio);
        }
    }
    return null;
}

function openEditor(node) {
    const width = Number(widgetValue(node, "width", 768));
    const height = Number(widgetValue(node, "height", 448));
    const frameCount = Number(widgetValue(node, "total_frames", 121));
    const frameRate = Number(widgetValue(node, "frame_rate", 24));
    const workspacePaddingX = Math.max(96, Math.round(width * 0.22));
    const workspacePaddingY = Math.max(72, Math.round(height * 0.25));
    const workspaceWidth = width + workspacePaddingX * 2;
    const workspaceHeight = height + workspacePaddingY * 2;
    const jsonWidget = node.widgets?.find((item) => item.name === "bbox_data_json");
    let project = loadProject(jsonWidget, frameCount);
    let selectedId = project.objects[0]?.id ?? null;
    let currentFrame = 0;
    let drawingNew = false;
    let drag = null;
    let playback = null;
    let background = null;
    let zoom = 1;
    let panX = 0;
    let panY = 0;
    let history = [];
    let historyIndex = -1;

    const modal = document.createElement("div");
    modal.className = "ltxrb-overlay";
    modal.innerHTML = `
        <style>
            .ltxrb-overlay{position:fixed;inset:0;z-index:10001;background:rgba(7,9,14,.86);display:grid;place-items:center;font:13px Inter,system-ui,sans-serif;color:#edf1fa}
            .ltxrb-dialog{width:96vw;height:94vh;min-width:min(760px,96vw);min-height:min(540px,94vh);background:#10131b;border:1px solid #303747;border-radius:15px;box-shadow:0 32px 110px #000a;display:grid;grid-template-rows:minmax(54px,7%) minmax(0,1fr) minmax(100px,13%);overflow:hidden}
            .ltxrb-header{display:flex;align-items:center;justify-content:space-between;padding:0 1.4%;border-bottom:1px solid #262c39;background:#141822}
            .ltxrb-title{font-weight:700;font-size:15px;letter-spacing:.1px}.ltxrb-subtitle{color:#8993a7;font-size:11px;margin-left:10px}
            .ltxrb-body{display:grid;grid-template-columns:18% minmax(0,1fr) 25%;min-height:0;min-width:0}
            .ltxrb-left,.ltxrb-right{padding:clamp(10px,1.2vw,20px);background:#141822;min-width:0}.ltxrb-left{border-right:1px solid #262c39;display:flex;flex-direction:column;overflow:hidden}.ltxrb-left-main{min-height:0;overflow:auto;flex:1}.ltxrb-right{border-left:1px solid #262c39;overflow:auto}.ltxrb-reference-panel{flex:none;margin-top:clamp(10px,1.5vh,18px);padding:clamp(10px,.95vw,15px);border:1px solid #354257;border-radius:10px;background:linear-gradient(180deg,#1b2230 0%,#161b25 100%)}.ltxrb-reference-panel .ltxrb-section{color:#b9c9e1;margin:0 0 6px}.ltxrb-reference-hint{font-size:11px;line-height:1.45;color:#94a0b3;margin:0 0 10px}.ltxrb-reference-panel [data-action="background"]{width:100%}.ltxrb-reference-options{margin-top:10px}.ltxrb-reference-options .ltxrb-field{margin:0 0 9px}.ltxrb-reference-options [data-action="remove-background"]{width:100%}
            .ltxrb-section{font-size:10px;letter-spacing:1.2px;color:#8993a7;text-transform:uppercase;font-weight:700;margin:4px 0 10px}
            .ltxrb-btn{height:32px;padding:0 11px;color:#e7ebf5;background:#232938;border:1px solid #333c4e;border-radius:7px;cursor:pointer;font:inherit}.ltxrb-btn:hover{background:#30384a}.ltxrb-btn:disabled{opacity:.4;cursor:not-allowed}
            .ltxrb-primary{background:#536df4;border-color:#627cff;color:#fff}.ltxrb-primary:hover{background:#637cff}.ltxrb-danger:hover{background:#622d36;border-color:#984654}
            .ltxrb-add{width:100%;margin-bottom:11px}.ltxrb-object-list{display:flex;flex-direction:column;gap:7px}
            .ltxrb-card{display:grid;grid-template-columns:14px minmax(0,1fr) 22px;gap:8px;align-items:center;padding:10px 8px;background:#1a1f2a;border:1px solid #2b3343;border-radius:8px;cursor:pointer}.ltxrb-card.selected{border-color:var(--track);background:#202739}.ltxrb-card.disabled{opacity:.45}
            .ltxrb-dot{width:9px;height:9px;border-radius:50%;background:var(--track)}.ltxrb-card-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600}.ltxrb-card-meta{color:#929bae;font-size:10px;margin-top:3px}.ltxrb-eye{padding:2px;background:none;border:0;color:#9ba5b7;cursor:pointer;font-size:15px}
            .ltxrb-stage{position:relative;overflow:hidden;display:grid;place-items:center;background:#0b0d12;background-image:linear-gradient(45deg,#12151d 25%,transparent 25%),linear-gradient(-45deg,#12151d 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#12151d 75%),linear-gradient(-45deg,transparent 75%,#12151d 75%);background-size:24px 24px;background-position:0 0,0 12px,12px -12px,-12px 0}
            .ltxrb-canvas{position:absolute;left:50%;top:50%;background:transparent;touch-action:none}.ltxrb-stage.panning,.ltxrb-stage.panning .ltxrb-canvas{cursor:grabbing!important}.ltxrb-stage-note{position:absolute;top:12px;left:12px;padding:6px 9px;border-radius:6px;background:#111827de;color:#bbc3d2;font-size:11px;pointer-events:none}
            .ltxrb-field{display:flex;flex-direction:column;gap:6px;margin-bottom:clamp(9px,1.2vh,15px)}.ltxrb-field label{color:#aeb7c8;font-size:11px;font-weight:600}.ltxrb-input,.ltxrb-textarea{width:100%;box-sizing:border-box;background:#0f121a;border:1px solid #303849;color:#edf1fa;border-radius:6px;padding:clamp(7px,.65vw,11px);font:inherit;outline:none}.ltxrb-input:focus,.ltxrb-textarea:focus{border-color:#6e82ff}.ltxrb-textarea{resize:vertical;min-height:clamp(62px,9vh,105px)}.ltxrb-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:clamp(8px,.8vw,13px)}.ltxrb-divider{height:1px;background:#2a3140;margin:15px 0}
            .ltxrb-prompt-panel{padding:clamp(11px,1.1vw,18px);border:1px solid;border-radius:10px;margin-bottom:clamp(11px,1.5vh,18px)}.ltxrb-prompt-panel .ltxrb-section{margin:0 0 5px}.ltxrb-panel-hint{font-size:11px;line-height:1.5;margin:0 0 clamp(9px,1.1vh,15px)}.ltxrb-global-panel{background:linear-gradient(180deg,#18243a 0%,#141a27 100%);border-color:#34517a}.ltxrb-global-panel .ltxrb-section{color:#86b8ff}.ltxrb-global-panel .ltxrb-panel-hint{color:#9ab0cf}.ltxrb-global-panel .ltxrb-input,.ltxrb-global-panel .ltxrb-textarea{border-color:#334862;background:#101827}.ltxrb-region-panel{--section-accent:#71e2ff;background:linear-gradient(180deg,#1b2228 0%,#151a20 100%);border-color:color-mix(in srgb,var(--section-accent) 45%,#29313b)}.ltxrb-region-panel .ltxrb-section{color:var(--section-accent)}.ltxrb-region-panel .ltxrb-panel-hint{color:#aeb9bc}.ltxrb-region-panel [data-field="prompt"]{border-color:color-mix(in srgb,var(--section-accent) 43%,#29313b);background:#10161a;min-height:clamp(85px,13vh,145px)}.ltxrb-region-panel .ltxrb-actions{padding-bottom:2px}
            .ltxrb-global-panel{padding:clamp(9px,.85vw,14px)}.ltxrb-global-panel .ltxrb-field{gap:4px;margin-bottom:clamp(6px,.8vh,10px)}.ltxrb-global-panel .ltxrb-field:last-child{margin-bottom:0}.ltxrb-global-panel .ltxrb-textarea{min-height:clamp(45px,6.2vh,73px)}.ltxrb-global-panel .ltxrb-panel-hint{margin-bottom:clamp(6px,.75vh,10px)}
            .ltxrb-empty{padding:25px 6px;color:#919bad;text-align:center;line-height:1.6}.ltxrb-actions{display:flex;gap:7px;flex-wrap:wrap}.ltxrb-cost{font-size:10px;color:#91a0b5;line-height:1.5;margin-top:12px}.ltxrb-warning{color:#ffcb74}
            .ltxrb-timeline{padding:1.1vh 1.3vw;border-top:1px solid #262c39;background:#141822;display:grid;grid-template-rows:minmax(32px,42%) minmax(26px,38%);gap:8%}.ltxrb-timeline-controls{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);align-items:center;gap:clamp(5px,.6vw,10px)}.ltxrb-key-actions,.ltxrb-playback-actions,.ltxrb-zoom-actions{display:flex;align-items:center;gap:clamp(5px,.6vw,10px)}.ltxrb-playback-actions{justify-content:center}.ltxrb-zoom-actions{justify-content:flex-end}.ltxrb-frame{font-variant-numeric:tabular-nums;color:#b8c1d2;min-width:86px}.ltxrb-track-wrap{position:relative;padding:5px 0}.ltxrb-slider{width:100%;accent-color:#7185ff;cursor:pointer}.ltxrb-markers{position:absolute;left:7px;right:7px;top:1px;height:21px;pointer-events:none}.ltxrb-marker{position:absolute;top:1px;width:8px;height:8px;background:var(--track);transform:translateX(-50%) rotate(45deg);border:1px solid #141822}.ltxrb-kbd{color:#8792a5;font-size:10px;white-space:nowrap}
            @media(max-width:1100px){.ltxrb-body{grid-template-columns:19% minmax(0,1fr) 28%}.ltxrb-dialog{width:98vw;height:96vh}.ltxrb-subtitle,.ltxrb-kbd{display:none}.ltxrb-section{letter-spacing:.7px}.ltxrb-prompt-panel,.ltxrb-reference-panel{padding:9px}.ltxrb-panel-hint,.ltxrb-reference-hint{font-size:10px}}
            @media(max-width:850px){.ltxrb-body{grid-template-columns:20% minmax(0,1fr) 30%}.ltxrb-left,.ltxrb-right{padding:8px}.ltxrb-btn{padding:0 7px}.ltxrb-stage-note{font-size:9px}}
        </style>
        <div class="ltxrb-dialog">
            <header class="ltxrb-header"><div><span class="ltxrb-title">LTX BBox Animator</span></div><div class="ltxrb-actions"><button class="ltxrb-btn" data-action="cancel">Cancel</button><button class="ltxrb-btn ltxrb-primary" data-action="save">Save & Close</button></div></header>
            <main class="ltxrb-body">
                <aside class="ltxrb-left"><div class="ltxrb-left-main"><div class="ltxrb-section">Objects</div><button class="ltxrb-btn ltxrb-primary ltxrb-add" data-action="add">＋ Add object</button><div class="ltxrb-object-list"></div><div class="ltxrb-cost"></div></div><section class="ltxrb-reference-panel"><div class="ltxrb-section">Reference image</div><p class="ltxrb-reference-hint">Optional canvas guide for positioning objects.</p><button class="ltxrb-btn" data-action="background">Load image</button><div class="ltxrb-reference-options" hidden><div class="ltxrb-field"><label>Reference opacity</label><input class="ltxrb-input" data-field="background-opacity" type="range" min="0" max="1" step="0.05"></div><button class="ltxrb-btn ltxrb-danger" data-action="remove-background">Remove image</button></div><input data-field="background-file" type="file" accept="image/*" hidden></section></aside>
                <section class="ltxrb-stage"><canvas class="ltxrb-canvas"></canvas><div class="ltxrb-stage-note"></div></section>
                <aside class="ltxrb-right"><section class="ltxrb-prompt-panel ltxrb-global-panel"><div class="ltxrb-section">Global scene · entire frame</div><p class="ltxrb-panel-hint">Shared environment, lighting, and overall scene.</p><div class="ltxrb-field"><label>Style</label><textarea class="ltxrb-textarea" data-field="style" placeholder="Cinematic lighting, natural colors, steady camera..."></textarea></div><div class="ltxrb-field"><label>Scene</label><textarea class="ltxrb-textarea" data-field="scene" placeholder="A city plaza where two people walk across the frame..."></textarea></div></section><section class="ltxrb-prompt-panel ltxrb-region-panel"><div class="ltxrb-section">Selected object · masked region</div><p class="ltxrb-panel-hint">Only applies inside this object's animated bbox.</p><div class="ltxrb-object-fields"><div class="ltxrb-field"><label>Object name</label><input class="ltxrb-input" data-field="name" placeholder="Object 1"></div><div class="ltxrb-field"><label>Regional object prompt</label><textarea class="ltxrb-textarea" data-field="prompt" placeholder="Describe only the object inside this bounding box..."></textarea></div><div class="ltxrb-grid"><div class="ltxrb-field"><label>Strength</label><input class="ltxrb-input" data-field="strength" type="number" min="0" max="5" step="0.05"></div><div class="ltxrb-field"><label>Enabled</label><button class="ltxrb-btn" data-action="enabled">Enabled</button></div><div class="ltxrb-field"><label>Start frame</label><input class="ltxrb-input" data-field="start" type="number" min="0"></div><div class="ltxrb-field"><label>End frame</label><input class="ltxrb-input" data-field="end" type="number" min="0"></div></div><div class="ltxrb-actions"><button class="ltxrb-btn" data-action="duplicate">Duplicate</button><button class="ltxrb-btn ltxrb-danger" data-action="delete">Delete</button></div></div><div class="ltxrb-empty ltxrb-object-empty">Add an object, then draw its bounding box on the canvas.</div></section></aside>
            </main>
            <footer class="ltxrb-timeline"><div class="ltxrb-timeline-controls"><div class="ltxrb-key-actions"><button class="ltxrb-btn" data-action="previous">◀ Key</button><button class="ltxrb-btn" data-action="next">Key ▶</button><button class="ltxrb-btn ltxrb-danger" data-action="delete-key">Delete key</button></div><div class="ltxrb-playback-actions"><button class="ltxrb-btn" data-action="play">▶</button><span class="ltxrb-frame"></span></div><div class="ltxrb-zoom-actions"><span class="ltxrb-kbd">Drag to pan · Scroll to zoom</span><button class="ltxrb-btn" data-action="zoom-out">−</button><button class="ltxrb-btn" data-action="zoom-reset">Fit</button><button class="ltxrb-btn" data-action="zoom-in">＋</button></div></div><div class="ltxrb-track-wrap"><input class="ltxrb-slider" type="range" min="0"><div class="ltxrb-markers"></div></div></footer>
        </div>`;
    document.body.appendChild(modal);

    const q = (selector) => modal.querySelector(selector);
    const canvas = q(".ltxrb-canvas");
    const context = canvas.getContext("2d");
    const slider = q(".ltxrb-slider");
    slider.max = frameCount - 1;
    canvas.width = workspaceWidth;
    canvas.height = workspaceHeight;

    function selected() {
        return project.objects.find((object) => object.id === selectedId) ?? null;
    }

    function checkpoint() {
        const snapshot = JSON.stringify(project);
        if (history[historyIndex] === snapshot) return;
        history = history.slice(0, historyIndex + 1);
        history.push(snapshot);
        if (history.length > MAX_HISTORY) history.shift();
        historyIndex = history.length - 1;
    }

    function restoreHistory(direction) {
        const next = historyIndex + direction;
        if (next < 0 || next >= history.length) return;
        historyIndex = next;
        project = JSON.parse(history[next]);
        if (!project.objects.some((object) => object.id === selectedId)) selectedId = project.objects[0]?.id ?? null;
        renderAll();
    }

    function fitCanvas() {
        const stage = q(".ltxrb-stage");
        const fit = Math.min(
            (stage.clientWidth - Math.max(36, stage.clientWidth * 0.10)) / width,
            (stage.clientHeight - Math.max(46, stage.clientHeight * 0.12)) / height,
        );
        const scale = Math.max(0.08, fit * zoom);
        canvas.style.width = `${Math.round(workspaceWidth * scale)}px`;
        canvas.style.height = `${Math.round(workspaceHeight * scale)}px`;
        canvas.style.transform = `translate(-50%, -50%) translate(${panX}px, ${panY}px)`;
        draw();
    }

    function canvasPosition(event) {
        const rect = canvas.getBoundingClientRect();
        return {
            x: (event.clientX - rect.left) * workspaceWidth / rect.width - workspacePaddingX,
            y: (event.clientY - rect.top) * workspaceHeight / rect.height - workspacePaddingY,
        };
    }

    function normalizeBox(box) {
        return [
            Math.min(box[0], box[2]),
            Math.min(box[1], box[3]),
            Math.max(box[0], box[2]),
            Math.max(box[1], box[3]),
        ].map((value) => Math.round(value));
    }

    function setKeyframe(object, frame, box) {
        const normalized = normalizeBox(box);
        const existing = object.keyframes.find((keyframe) => keyframe.frame === frame);
        if (existing) existing.box = normalized;
        else object.keyframes.push({ frame, box: normalized });
        object.keyframes.sort((a, b) => a.frame - b.frame);
    }

    function handles(box) {
        const [x1, y1, x2, y2] = box;
        return [
            ["nw", x1, y1], ["n", (x1 + x2) / 2, y1], ["ne", x2, y1],
            ["e", x2, (y1 + y2) / 2], ["se", x2, y2], ["s", (x1 + x2) / 2, y2],
            ["sw", x1, y2], ["w", x1, (y1 + y2) / 2],
        ];
    }

    function hitHandle(position, box) {
        const radius = Math.max(8, width / Math.max(1, canvas.clientWidth) * 8);
        return handles(box).find(([, x, y]) => Math.abs(position.x - x) <= radius && Math.abs(position.y - y) <= radius)?.[0] ?? null;
    }

    function hitObject(position) {
        const ordered = [...project.objects].reverse();
        const current = selected();
        if (current) ordered.sort((a, b) => (b.id === current.id ? 1 : 0) - (a.id === current.id ? 1 : 0));
        return ordered.find((object) => {
            if (!object.enabled) return false;
            const box = interpolatedBox(object, currentFrame);
            return box && position.x >= box[0] && position.x <= box[2] && position.y >= box[1] && position.y <= box[3];
        }) ?? null;
    }

    function draw() {
        context.clearRect(0, 0, workspaceWidth, workspaceHeight);
        context.save();
        context.translate(workspacePaddingX, workspacePaddingY);
        context.fillStyle = "#08090b";
        context.fillRect(0, 0, width, height);
        if (background) {
            const ratio = Math.min(width / background.width, height / background.height);
            const imageWidth = background.width * ratio;
            const imageHeight = background.height * ratio;
            context.save();
            context.beginPath();
            context.rect(0, 0, width, height);
            context.clip();
            context.globalAlpha = project.bg_opacity;
            context.drawImage(background, (width - imageWidth) / 2, (height - imageHeight) / 2, imageWidth, imageHeight);
            context.restore();
        }

        context.strokeStyle = "#687184";
        context.lineWidth = 1;
        context.setLineDash([7, 5]);
        context.strokeRect(-0.5, -0.5, width + 1, height + 1);
        context.setLineDash([]);
        context.fillStyle = "#99a5ba";
        context.font = "11px Inter,system-ui,sans-serif";
        context.fillText("VISIBLE VIDEO FRAME", 0, -10);

        const ordered = [...project.objects].sort((a, b) => Number(a.id === selectedId) - Number(b.id === selectedId));
        for (const object of ordered) {
            if (!object.enabled) continue;
            const box = interpolatedBox(object, currentFrame);
            if (!box) continue;
            const active = object.id === selectedId;
            const [x1, y1, x2, y2] = box;
            context.globalAlpha = active ? 1 : 0.28;
            context.strokeStyle = object.color;
            context.lineWidth = active ? 2.4 : 1.5;
            context.setLineDash(active ? [] : [6, 4]);
            context.strokeRect(x1, y1, x2 - x1, y2 - y1);
            context.setLineDash([]);

            const label = object.name || "Object";
            context.font = `${Math.max(11, Math.round(width / 76))}px Inter,system-ui,sans-serif`;
            const labelWidth = Math.min(x2 - x1, context.measureText(label).width + 14);
            const labelHeight = 22;
            context.fillStyle = object.color;
            context.fillRect(x1, Math.max(0, y1 - labelHeight), Math.max(labelWidth, 22), labelHeight);
            context.fillStyle = "#101319";
            context.fillText(label, x1 + 7, Math.max(15, y1 - 7));

            if (active) {
                for (const [, x, y] of handles(box)) {
                    context.fillStyle = "#ffffff";
                    context.fillRect(x - 4, y - 4, 8, 8);
                    context.strokeStyle = object.color;
                    context.strokeRect(x - 4, y - 4, 8, 8);
                }
            }
            context.globalAlpha = 1;
        }
        context.restore();
        q(".ltxrb-stage-note").textContent = drawingNew
            ? "Drag anywhere, including outside the visible frame"
            : `${width} × ${height} · dashed border = visible frame · ${project.objects.filter((object) => object.enabled).length} active objects`;
    }

    function renderObjects() {
        const list = q(".ltxrb-object-list");
        list.replaceChildren();
        for (const object of project.objects) {
            const card = document.createElement("div");
            card.className = `ltxrb-card${object.id === selectedId ? " selected" : ""}${object.enabled ? "" : " disabled"}`;
            card.style.setProperty("--track", object.color);
            const dot = document.createElement("span");
            dot.className = "ltxrb-dot";
            const description = document.createElement("div");
            const name = document.createElement("div");
            name.className = "ltxrb-card-name";
            name.textContent = object.name || "Unnamed object";
            const meta = document.createElement("div");
            meta.className = "ltxrb-card-meta";
            meta.textContent = `${object.keyframes.length} keyframe${object.keyframes.length === 1 ? "" : "s"} · ${object.strength.toFixed(2)}`;
            description.append(name, meta);
            const eye = document.createElement("button");
            eye.className = "ltxrb-eye";
            eye.textContent = object.enabled ? "◉" : "○";
            eye.title = object.enabled ? "Disable object" : "Enable object";
            eye.addEventListener("click", (event) => {
                event.stopPropagation();
                object.enabled = !object.enabled;
                checkpoint();
                renderAll();
            });
            card.append(dot, description, eye);
            card.addEventListener("click", () => {
                selectedId = object.id;
                drawingNew = !object.keyframes.length;
                renderAll();
            });
            list.appendChild(card);
        }
        const active = project.objects.filter((object) => object.enabled).length;
        const cost = q(".ltxrb-cost");
        cost.className = `ltxrb-cost${active > 5 ? " ltxrb-warning" : ""}`;
        cost.textContent = active
            ? `${active} active region${active === 1 ? "" : "s"} · ${((active + 1) * 1024).toLocaleString()} attention tokens${active > 5 ? " · increased VRAM usage" : ""}`
            : "Add an object to generate regional conditioning.";
    }

    function renderFields() {
        q('[data-field="style"]').value = project.style_prompt;
        q('[data-field="scene"]').value = project.scene_prompt;
        q('[data-field="background-opacity"]').value = project.bg_opacity;
        q(".ltxrb-reference-options").hidden = !background;
        q('[data-action="background"]').textContent = background ? "Replace image" : "Load image";
        const object = selected();
        q(".ltxrb-object-fields").style.display = object ? "block" : "none";
        q(".ltxrb-object-empty").style.display = object ? "none" : "block";
        q(".ltxrb-region-panel").style.setProperty("--section-accent", object?.color ?? "#71e2ff");
        if (!object) return;
        q('[data-field="name"]').value = object.name;
        q('[data-field="prompt"]').value = object.prompt;
        q('[data-field="strength"]').value = object.strength;
        q('[data-field="start"]').value = object.start_frame;
        q('[data-field="end"]').value = object.end_frame;
        q('[data-field="start"]').max = frameCount - 1;
        q('[data-field="end"]').max = frameCount - 1;
        q('[data-action="enabled"]').textContent = object.enabled ? "Enabled" : "Disabled";
    }

    function renderTimeline() {
        slider.value = currentFrame;
        q(".ltxrb-frame").textContent = `${String(currentFrame).padStart(3, "0")} / ${String(frameCount - 1).padStart(3, "0")}`;
        const markers = q(".ltxrb-markers");
        markers.replaceChildren();
        const object = selected();
        for (const keyframe of object?.keyframes ?? []) {
            const marker = document.createElement("span");
            marker.className = "ltxrb-marker";
            marker.style.left = `${frameCount <= 1 ? 0 : keyframe.frame / (frameCount - 1) * 100}%`;
            marker.style.setProperty("--track", object.color);
            markers.appendChild(marker);
        }
    }

    function renderAll() {
        renderObjects();
        renderFields();
        renderTimeline();
        draw();
    }

    function addObject() {
        const object = {
            id: uid(),
            name: `Object ${project.objects.length + 1}`,
            prompt: "",
            strength: 1,
            enabled: true,
            start_frame: 0,
            end_frame: frameCount - 1,
            color: EDITOR_COLORS[project.objects.length % EDITOR_COLORS.length],
            keyframes: [],
        };
        project.objects.push(object);
        selectedId = object.id;
        drawingNew = true;
        checkpoint();
        renderAll();
    }

    function jumpKey(direction) {
        const keys = selected()?.keyframes ?? [];
        const candidate = direction < 0
            ? [...keys].reverse().find((keyframe) => keyframe.frame < currentFrame)
            : keys.find((keyframe) => keyframe.frame > currentFrame);
        if (candidate) {
            currentFrame = candidate.frame;
            renderTimeline();
            draw();
        }
    }

    function togglePlayback() {
        if (playback) {
            clearInterval(playback);
            playback = null;
            q('[data-action="play"]').textContent = "▶";
            return;
        }
        q('[data-action="play"]').textContent = "❚❚";
        playback = setInterval(() => {
            currentFrame = (currentFrame + 1) % frameCount;
            renderTimeline();
            draw();
        }, 1000 / frameRate);
    }

    function cleanup() {
        if (playback) clearInterval(playback);
        resizeObserver.disconnect();
        document.removeEventListener("keydown", onKeyDown, true);
        modal.remove();
    }

    function save() {
        const enabled = project.objects.filter((object) => object.enabled);
        if (!enabled.length) return alert("Add and enable at least one object.");
        if (!project.style_prompt.trim()) return alert("Enter a global style prompt.");
        if (!project.scene_prompt.trim()) return alert("Enter a global scene prompt.");
        for (const object of enabled) {
            if (!object.prompt.trim()) {
                selectedId = object.id;
                renderAll();
                q('[data-field="prompt"]').focus();
                return alert(`${object.name} needs a regional prompt.`);
            }
            if (!object.keyframes.length) {
                selectedId = object.id;
                drawingNew = true;
                renderAll();
                return alert(`${object.name} needs at least one bounding-box keyframe.`);
            }
            if (object.end_frame < object.start_frame) return alert(`${object.name} has an invalid frame range.`);
        }
        const serialized = JSON.stringify(project);
        if (jsonWidget) {
            jsonWidget.value = serialized;
            if (jsonWidget.element) jsonWidget.element.value = serialized;
            jsonWidget.callback?.(serialized);
        }
        node.graph?.change?.();
        app.graph?.setDirtyCanvas?.(true, true);
        cleanup();
    }

    const stage = q(".ltxrb-stage");

    function beginPan(event, target) {
        drag = {
            mode: "pan",
            originClientX: event.clientX,
            originClientY: event.clientY,
            startX: panX,
            startY: panY,
            target,
        };
        target.setPointerCapture(event.pointerId);
        stage.classList.add("panning");
        event.preventDefault();
    }

    function updatePan(event) {
        panX = drag.startX + event.clientX - drag.originClientX;
        panY = drag.startY + event.clientY - drag.originClientY;
        canvas.style.transform = `translate(-50%, -50%) translate(${panX}px, ${panY}px)`;
    }

    function finishPan() {
        drag = null;
        stage.classList.remove("panning");
    }

    stage.addEventListener("pointerdown", (event) => {
        if (event.target !== stage || ![0, 1, 2].includes(event.button)) return;
        beginPan(event, stage);
    });

    stage.addEventListener("pointermove", (event) => {
        if (drag?.mode !== "pan" || drag.target !== stage) return;
        updatePan(event);
    });

    stage.addEventListener("pointerup", () => {
        if (drag?.mode === "pan" && drag.target === stage) finishPan();
    });

    stage.addEventListener("contextmenu", (event) => event.preventDefault());

    stage.addEventListener("wheel", (event) => {
        event.preventDefault();
        const rect = stage.getBoundingClientRect();
        const pointerX = event.clientX - rect.left - rect.width / 2;
        const pointerY = event.clientY - rect.top - rect.height / 2;
        const previousZoom = zoom;
        zoom = clamp(zoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12), 0.3, 5);
        const ratio = zoom / previousZoom;
        panX = pointerX - (pointerX - panX) * ratio;
        panY = pointerY - (pointerY - panY) * ratio;
        fitCanvas();
    }, { passive: false });

    canvas.addEventListener("pointerdown", (event) => {
        if ([1, 2].includes(event.button) || event.shiftKey) {
            beginPan(event, canvas);
            return;
        }
        if (event.button !== 0) return;
        const position = canvasPosition(event);
        const object = selected();
        const currentBox = interpolatedBox(object, currentFrame);
        if (drawingNew || (object && !currentBox)) {
            if (!object) return;
            drag = { mode: "draw", object, origin: position };
        } else {
            const handle = currentBox && hitHandle(position, currentBox);
            if (handle) {
                drag = { mode: "resize", handle, object, origin: position, box: [...currentBox] };
            } else {
                const hit = hitObject(position);
                if (!hit) {
                    beginPan(event, canvas);
                    return;
                }
                selectedId = hit.id;
                const box = interpolatedBox(hit, currentFrame);
                drag = { mode: "move", object: hit, origin: position, box: [...box] };
                renderObjects();
                renderFields();
                renderTimeline();
            }
        }
        canvas.setPointerCapture(event.pointerId);
    });

    canvas.addEventListener("pointermove", (event) => {
        if (drag?.mode === "pan") {
            updatePan(event);
            return;
        }
        const position = canvasPosition(event);
        if (!drag) {
            const box = interpolatedBox(selected(), currentFrame);
            const handle = box && hitHandle(position, box);
            canvas.style.cursor = drawingNew ? "crosshair" : handle ? `${handle}-resize` : hitObject(position) ? "move" : "grab";
            return;
        }
        const dx = position.x - drag.origin.x;
        const dy = position.y - drag.origin.y;
        let box;
        if (drag.mode === "draw") {
            box = [drag.origin.x, drag.origin.y, position.x, position.y];
        } else if (drag.mode === "move") {
            const original = drag.box;
            box = [original[0] + dx, original[1] + dy, original[2] + dx, original[3] + dy];
        } else {
            box = [...drag.box];
            if (drag.handle.includes("w")) box[0] += dx;
            if (drag.handle.includes("e")) box[2] += dx;
            if (drag.handle.includes("n")) box[1] += dy;
            if (drag.handle.includes("s")) box[3] += dy;
        }
        setKeyframe(drag.object, currentFrame, box);
        draw();
        renderTimeline();
    });

    canvas.addEventListener("pointerup", () => {
        if (!drag) return;
        if (drag.mode === "pan") {
            finishPan();
            return;
        }
        const keyframe = drag.object.keyframes.find((item) => item.frame === currentFrame);
        if (keyframe && (keyframe.box[2] - keyframe.box[0] < 5 || keyframe.box[3] - keyframe.box[1] < 5)) {
            drag.object.keyframes = drag.object.keyframes.filter((item) => item !== keyframe);
        } else {
            drawingNew = false;
        }
        drag = null;
        checkpoint();
        renderAll();
    });

    canvas.addEventListener("dblclick", (event) => {
        const object = hitObject(canvasPosition(event));
        if (!object) return;
        selectedId = object.id;
        renderAll();
        q('[data-field="prompt"]').focus();
    });

    slider.addEventListener("input", () => {
        currentFrame = Number(slider.value);
        renderTimeline();
        draw();
    });

    const bindText = (selector, setter, refreshCards = false) => {
        const field = q(selector);
        field.addEventListener("input", () => {
            setter(field.value);
            if (refreshCards) renderObjects();
            draw();
        });
        field.addEventListener("change", checkpoint);
    };
    bindText('[data-field="style"]', (value) => { project.style_prompt = value; });
    bindText('[data-field="scene"]', (value) => { project.scene_prompt = value; });
    bindText('[data-field="name"]', (value) => { if (selected()) selected().name = value; }, true);
    bindText('[data-field="prompt"]', (value) => { if (selected()) selected().prompt = value; });
    bindText('[data-field="strength"]', (value) => { if (selected()) selected().strength = clamp(Number(value) || 0, 0, 5); }, true);
    bindText('[data-field="start"]', (value) => { if (selected()) selected().start_frame = clamp(Number(value) || 0, 0, frameCount - 1); });
    bindText('[data-field="end"]', (value) => { if (selected()) selected().end_frame = clamp(Number(value) || 0, 0, frameCount - 1); });
    bindText('[data-field="background-opacity"]', (value) => { project.bg_opacity = clamp(Number(value), 0, 1); });

    modal.addEventListener("click", (event) => {
        const action = event.target.closest("[data-action]")?.dataset.action;
        if (!action) return;
        const object = selected();
        if (action === "add") addObject();
        else if (action === "save") save();
        else if (action === "cancel") cleanup();
        else if (action === "play") togglePlayback();
        else if (action === "previous") jumpKey(-1);
        else if (action === "next") jumpKey(1);
        else if (action === "zoom-in") { const next = clamp(zoom * 1.2, 0.3, 5); panX *= next / zoom; panY *= next / zoom; zoom = next; fitCanvas(); }
        else if (action === "zoom-out") { const next = clamp(zoom / 1.2, 0.3, 5); panX *= next / zoom; panY *= next / zoom; zoom = next; fitCanvas(); }
        else if (action === "zoom-reset") { zoom = 1; panX = 0; panY = 0; fitCanvas(); }
        else if (action === "background") q('[data-field="background-file"]').click();
        else if (action === "remove-background") { background = null; project.bg_image_base64 = ""; checkpoint(); renderFields(); draw(); }
        else if (action === "enabled" && object) { object.enabled = !object.enabled; checkpoint(); renderAll(); }
        else if (action === "delete-key" && object) {
            object.keyframes = object.keyframes.filter((keyframe) => keyframe.frame !== currentFrame);
            drawingNew = !object.keyframes.length;
            checkpoint();
            renderAll();
        } else if (action === "delete" && object && confirm(`Delete ${object.name} and all its keyframes?`)) {
            project.objects = project.objects.filter((item) => item.id !== object.id);
            selectedId = project.objects[0]?.id ?? null;
            drawingNew = false;
            checkpoint();
            renderAll();
        } else if (action === "duplicate" && object) {
            const clone = structuredClone(object);
            clone.id = uid();
            clone.name = `${object.name} copy`;
            clone.color = EDITOR_COLORS[project.objects.length % EDITOR_COLORS.length];
            clone.keyframes = clone.keyframes.map((keyframe) => ({
                frame: keyframe.frame,
                box: normalizeBox([keyframe.box[0] + 20, keyframe.box[1] + 20, keyframe.box[2] + 20, keyframe.box[3] + 20]),
            }));
            project.objects.push(clone);
            selectedId = clone.id;
            checkpoint();
            renderAll();
        }
    });

    q('[data-field="background-file"]').addEventListener("change", (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            project.bg_image_base64 = String(reader.result);
            loadBackground();
            checkpoint();
        };
        reader.readAsDataURL(file);
        event.target.value = "";
    });

    function loadBackground() {
        if (!project.bg_image_base64) return;
        const image = new Image();
        image.onload = () => { background = image; renderFields(); draw(); };
        image.src = project.bg_image_base64;
    }

    function onKeyDown(event) {
        if (!document.body.contains(modal)) return;
        const input = event.target.closest?.("input,textarea");
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
            event.preventDefault();
            restoreHistory(event.shiftKey ? 1 : -1);
            return;
        }
        if (input) return;
        if (event.code === "Space") { event.preventDefault(); togglePlayback(); }
        else if (event.key === "ArrowLeft") { event.preventDefault(); currentFrame = clamp(currentFrame - (event.shiftKey ? 10 : 1), 0, frameCount - 1); renderTimeline(); draw(); }
        else if (event.key === "ArrowRight") { event.preventDefault(); currentFrame = clamp(currentFrame + (event.shiftKey ? 10 : 1), 0, frameCount - 1); renderTimeline(); draw(); }
        else if ((event.key === "Delete" || event.key === "Backspace") && selected()) q('[data-action="delete-key"]').click();
        else if (event.key === "Escape") { if (drawingNew) { drawingNew = false; draw(); } else cleanup(); }
    }

    document.addEventListener("keydown", onKeyDown, true);
    const resizeObserver = new ResizeObserver(fitCanvas);
    resizeObserver.observe(q(".ltxrb-stage"));
    checkpoint();
    loadBackground();
    renderAll();
    requestAnimationFrame(fitCanvas);
}
