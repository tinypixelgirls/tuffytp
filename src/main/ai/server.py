"""TuffYTP's AI helper: follows a character through a shot with SAM 2.1.

The app runs this with the AI pack's Python and talks to it over stdin and stdout, one JSON
object per line. Every request carries an "id"; the reply carries the same id plus either
"ok": true and the results, or "error". Long jobs send {"id", "progress"} lines on the way.

Commands:
  open   {frames_dir, masks_dir}         load a shot: frames named 00000.jpg, 00001.jpg, ...
  points {frame, points, labels}         clicks on one frame; labels 1 keep, 0 cut. Writes its mask.
  track  {}                              follow the mask through every frame, writing all masks
  close  {}                              forget the shot and free the GPU memory

Masks are PNGs, white where the character is, named like the frames.

With --fake it skips the model and cuts by colour instead. That's for the app's tests.
"""

import argparse
import contextlib
import json
import os
import sys
import traceback


def send(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def save_mask(mask, path):
    from PIL import Image
    import numpy as np

    Image.fromarray((mask.astype(np.uint8) * 255)).save(path)
    return int(mask.sum())


def frame_names(frames_dir):
    names = [name for name in os.listdir(frames_dir) if name.lower().endswith((".jpg", ".jpeg"))]
    return sorted(names, key=lambda name: int(os.path.splitext(name)[0]))


class Sam2Backend:
    name = "sam2"

    def __init__(self, checkpoint, config):
        import torch
        from sam2.build_sam import build_sam2_video_predictor

        self.torch = torch
        if torch.cuda.is_available():
            self.device = "cuda"
            self.gpu = torch.cuda.get_device_name(0)
        elif getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            self.device = "mps"
            self.gpu = "Apple GPU"
        else:
            self.device = "cpu"
            self.gpu = None
        self.predictor = build_sam2_video_predictor(config, checkpoint, device=self.device)
        self.state = None
        self.prompted = set()

    def precision(self):
        # bfloat16 needs an Ampere card or newer. Older ones (a 2070 is Turing) run in float32.
        torch = self.torch
        if self.device == "cuda" and torch.cuda.get_device_capability(0)[0] >= 8:
            return torch.autocast("cuda", dtype=torch.bfloat16)
        return contextlib.nullcontext()

    def open(self, frames_dir):
        self.close()
        with self.torch.inference_mode(), self.precision():
            self.state = self.predictor.init_state(video_path=frames_dir, offload_video_to_cpu=True)
        self.prompted = set()
        return self.state["num_frames"]

    def points(self, frame, points, labels):
        import numpy as np

        with self.torch.inference_mode(), self.precision():
            if not points:
                if hasattr(self.predictor, "clear_all_prompts_in_frame"):
                    self.predictor.clear_all_prompts_in_frame(self.state, frame, obj_id=1)
                self.prompted.discard(frame)
                return np.zeros((self.state["video_height"], self.state["video_width"]), dtype=bool)
            _, _, logits = self.predictor.add_new_points_or_box(
                inference_state=self.state,
                frame_idx=frame,
                obj_id=1,
                points=np.array(points, dtype=np.float32),
                labels=np.array(labels, dtype=np.int32),
            )
            self.prompted.add(frame)
            return (logits[0] > 0.0).cpu().numpy()[0]

    def track(self):
        if not self.prompted:
            raise ValueError("Click on the character first.")
        first = min(self.prompted)
        with self.torch.inference_mode(), self.precision():
            # Forward from the first clicked frame, then back from it to the start of the shot.
            yield from self._propagate(reverse=False)
            if first > 0:
                yield from self._propagate(reverse=True, start=first)

    def _propagate(self, reverse, start=None):
        for frame, _, logits in self.predictor.propagate_in_video(self.state, start_frame_idx=start, reverse=reverse):
            yield frame, (logits[0] > 0.0).cpu().numpy()[0]

    def close(self):
        if self.state is not None:
            self.predictor.reset_state(self.state)
            self.state = None
            if self.device == "cuda":
                self.torch.cuda.empty_cache()


class FakeBackend:
    """Keeps pixels close in colour to what was clicked. Only for tests: no model needed."""

    name = "fake"
    device = "cpu"
    gpu = None
    tolerance = 60

    def __init__(self):
        self.frames_dir = None
        self.names = []
        self.keep = []
        self.cut = []

    def open(self, frames_dir):
        self.frames_dir = frames_dir
        self.names = frame_names(frames_dir)
        self.keep, self.cut = [], []
        return len(self.names)

    def _load(self, frame):
        from PIL import Image
        import numpy as np

        return np.asarray(Image.open(os.path.join(self.frames_dir, self.names[frame])).convert("RGB")).astype(np.int32)

    def _mask(self, pixels):
        import numpy as np

        def nearest(colours):
            if not colours:
                return np.full(pixels.shape[:2], 1e9)
            return np.min([np.sqrt(((pixels - colour) ** 2).sum(axis=2)) for colour in colours], axis=0)

        keep = nearest(self.keep)
        return (keep < self.tolerance) & (keep <= nearest(self.cut))

    def points(self, frame, points, labels):
        pixels = self._load(frame)
        self.keep = [pixels[int(y), int(x)] for (x, y), label in zip(points, labels) if label == 1]
        self.cut = [pixels[int(y), int(x)] for (x, y), label in zip(points, labels) if label == 0]
        return self._mask(pixels)

    def track(self):
        if not self.keep:
            raise ValueError("Click on the character first.")
        for frame in range(len(self.names)):
            yield frame, self._mask(self._load(frame))

    def close(self):
        self.frames_dir = None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint")
    parser.add_argument("--config", default="configs/sam2.1/sam2.1_hiera_s.yaml")
    parser.add_argument("--fake", action="store_true")
    args = parser.parse_args()

    try:
        backend = FakeBackend() if args.fake else Sam2Backend(args.checkpoint, args.config)
    except Exception as error:  # Report why the model didn't load, then stop.
        send({"ready": False, "error": f"{type(error).__name__}: {error}", "trace": traceback.format_exc()})
        return
    send({"ready": True, "backend": backend.name, "device": backend.device, "gpu": backend.gpu})

    masks_dir = None
    frames = 0
    for line in sys.stdin:
        if not line.strip():
            continue
        request = json.loads(line)
        reply = {"id": request.get("id")}
        try:
            command = request["cmd"]
            if command == "open":
                masks_dir = request["masks_dir"]
                os.makedirs(masks_dir, exist_ok=True)
                frames = backend.open(request["frames_dir"])
                reply["frames"] = frames
            elif command == "points":
                frame = int(request["frame"])
                mask = backend.points(frame, request["points"], request["labels"])
                reply["area"] = save_mask(mask, os.path.join(masks_dir, f"{frame:05d}.png"))
            elif command == "track":
                done = set()
                for frame, mask in backend.track():
                    save_mask(mask, os.path.join(masks_dir, f"{frame:05d}.png"))
                    done.add(frame)
                    send({"id": request.get("id"), "progress": len(done) / max(1, frames)})
                reply["tracked"] = len(done)
            elif command == "close":
                backend.close()
            else:
                raise ValueError(f"Unknown command: {command}")
            reply["ok"] = True
        except Exception as error:
            reply["error"] = f"{type(error).__name__}: {error}"
            reply["trace"] = traceback.format_exc()
        send(reply)


if __name__ == "__main__":
    main()
