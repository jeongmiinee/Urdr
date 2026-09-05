"""Long-lived offline IMS-Toucan worker for URDR."""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

from ims_toucan_runner import ipa_to_tensor, language_id


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine-root", required=True)
    parser.add_argument("--language", default="eng")
    parser.add_argument("--model", required=True)
    parser.add_argument("--vocoder", required=True)
    return parser.parse_args()


def emit(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), flush=True)


class ToucanWorker:
    def __init__(self, args: argparse.Namespace) -> None:
        started = time.perf_counter()
        self.engine_root = Path(args.engine_root).resolve()
        if not self.engine_root.is_dir():
            raise FileNotFoundError(f"IMS-Toucan engine directory is missing: {self.engine_root}")
        os.chdir(self.engine_root)
        sys.path.insert(0, str(self.engine_root))

        import pyloudnorm
        import soundfile
        import torch

        from Modules.ToucanTTS.InferenceToucanTTS import ToucanTTS
        from Modules.Vocoder.HiFiGAN_Generator import HiFiGAN
        from Preprocessing.articulatory_features import generate_feature_table, get_feature_to_index_lookup
        from Utility.utils import float2pcm

        self.pyloudnorm = pyloudnorm
        self.soundfile = soundfile
        self.torch = torch
        self.float2pcm = float2pcm
        self.feature_table = generate_feature_table()
        self.feature_indexes = get_feature_to_index_lookup()
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

        model_started = time.perf_counter()
        self.checkpoint = torch.load(Path(args.model), map_location="cpu", weights_only=False)
        self.phone_to_mel = ToucanTTS(
            weights=self.checkpoint["model"], config=self.checkpoint["config"]
        )
        with torch.no_grad():
            self.phone_to_mel.store_inverse_all()
        self.phone_to_mel = self.phone_to_mel.to(self.device).eval()
        model_ms = (time.perf_counter() - model_started) * 1000.0

        vocoder_started = time.perf_counter()
        vocoder_checkpoint = torch.load(Path(args.vocoder), map_location="cpu", weights_only=False)
        self.vocoder = HiFiGAN()
        self.vocoder.load_state_dict(vocoder_checkpoint)
        self.vocoder = self.vocoder.to(self.device).eval()
        self.vocoder.remove_weight_norm()
        vocoder_ms = (time.perf_counter() - vocoder_started) * 1000.0
        self.selected_language_id = language_id(
            args.language, torch, self.engine_root, self.device
        )
        self.startup_ms = (time.perf_counter() - started) * 1000.0
        emit(
            {
                "type": "ready",
                "protocol": 1,
                "startupMs": self.startup_ms,
                "modelLoadMs": model_ms,
                "vocoderLoadMs": vocoder_ms,
                "device": str(self.device),
            }
        )

    def synthesize(self, request: dict) -> dict:
        torch = self.torch
        request_id = str(request.get("id", ""))
        phones = ipa_to_tensor(
            str(request["ipa"]),
            torch,
            self.feature_table,
            self.feature_indexes,
            self.device,
        )
        speed = min(2.0, max(0.5, float(request.get("speed", 1.0))))
        pitch = min(1.4, max(0.7, float(request.get("pitch", 1.0))))
        volume = min(1.0, max(0.0, float(request.get("volume", 0.85))))

        acoustic_started = time.perf_counter()
        with torch.inference_mode():
            mel, _, _, _ = self.phone_to_mel(
                phones,
                return_duration_pitch_energy=True,
                utterance_embedding=self.checkpoint["default_emb"].to(self.device),
                lang_id=self.selected_language_id,
                duration_scaling_factor=1.0 / speed,
                pitch_variance_scale=pitch,
                energy_variance_scale=1.0,
                pause_duration_scaling_factor=1.0,
                prosody_creativity=0.1,
            )
        acoustic_ms = (time.perf_counter() - acoustic_started) * 1000.0

        vocoder_started = time.perf_counter()
        with torch.inference_mode():
            wave = self.vocoder(mel.unsqueeze(0)).squeeze().cpu().numpy()
        vocoder_ms = (time.perf_counter() - vocoder_started) * 1000.0

        meter = self.pyloudnorm.Meter(24000)
        try:
            loudness = meter.integrated_loudness(wave)
            wave = self.pyloudnorm.normalize.loudness(
                wave, loudness, -42.0 + (volume * 20.0)
            )
        except ValueError:
            pass

        output = Path(request["output"])
        output.parent.mkdir(parents=True, exist_ok=True)
        write_started = time.perf_counter()
        self.soundfile.write(output, self.float2pcm(wave), 24000, subtype="PCM_16")
        write_ms = (time.perf_counter() - write_started) * 1000.0
        return {
            "type": "result",
            "id": request_id,
            "output": str(output),
            "acousticMs": acoustic_ms,
            "vocoderMs": vocoder_ms,
            "writeMs": write_ms,
        }


def main() -> int:
    worker = ToucanWorker(parse_args())
    for line in sys.stdin:
        try:
            request = json.loads(line)
            if request.get("type") == "shutdown":
                emit({"type": "shutdown"})
                return 0
            if request.get("type") != "synthesize":
                raise ValueError("Unknown IMS worker request")
            emit(worker.synthesize(request))
        except Exception as error:
            emit(
                {
                    "type": "error",
                    "id": request.get("id", "") if "request" in locals() else "",
                    "message": f"{type(error).__name__}: {error}",
                }
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
