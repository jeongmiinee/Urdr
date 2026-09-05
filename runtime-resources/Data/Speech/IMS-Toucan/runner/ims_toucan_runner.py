"""Minimal offline IMS-Toucan IPA inference runner used by URDR."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ipa", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--engine-root", required=True)
    parser.add_argument("--language", default="eng")
    parser.add_argument("--model", required=True)
    parser.add_argument("--vocoder", required=True)
    parser.add_argument("--speed", type=float, default=1.0)
    parser.add_argument("--pitch", type=float, default=1.0)
    parser.add_argument("--volume", type=float, default=0.85)
    return parser.parse_args()


def ipa_to_tensor(ipa: str, torch, feature_table, feature_indexes, device):
    phones = ipa.replace("ɚ", "ə").replace("ᵻ", "ɨ")
    vectors = []
    stressed = False
    previous_modifiers = {
        "ː": ("lengthened", 1),
        "ˑ": ("half-length", 1),
        "̆": ("shortened", 1),
        "̃": ("nasal", 2),
        "̧": ("palatal", 2),
        "ʷ": ("labial-velar", 2),
        "ʰ": ("aspirated", 2),
        "ˠ": ("velar", 2),
        "ˁ": ("pharyngal", 2),
        "ˀ": ("glottal", 2),
        "ʼ": ("ejective", 2),
        "̹": ("rounded", 2),
        "̞": ("open", 2),
        "̪": ("dental", 2),
        "̬": ("voiced", 2),
        "̝": ("close", 2),
        "̈": ("central", 2),
        "̜": ("unrounded", 2),
        "̥": ("unvoiced", 2),
        "˥": ("very-high-tone", 1),
        "˦": ("high-tone", 1),
        "˧": ("mid-tone", 1),
        "˨": ("low-tone", 1),
        "˩": ("very-low-tone", 1),
        "⭧": ("rising-tone", 1),
        "⭨": ("falling-tone", 1),
        "⮁": ("peaking-tone", 1),
        "⮃": ("dipping-tone", 1),
    }
    for character in phones:
        if character == "ˈ":
            stressed = True
            continue
        modifier = previous_modifiers.get(character)
        if modifier and vectors:
            feature, value = modifier
            vectors[-1][feature_indexes[feature]] = value
            continue
        vector = feature_table.get(character)
        if vector is None:
            raise ValueError(f"Unsupported IMS-Toucan IPA symbol: {character}")
        vector = vector.copy()
        if stressed:
            vector[feature_indexes["stressed"]] = 1
            stressed = False
        vectors.append(vector)
    if not vectors:
        raise ValueError("IPA input did not contain a synthesizable phoneme")
    return torch.tensor(vectors, dtype=torch.float32, device=device)


def language_id(language: str, torch, engine_root: Path, device):
    lookup_path = engine_root / "Preprocessing" / "multilinguality" / "iso_lookup.json"
    with lookup_path.open("r", encoding="utf-8") as stream:
        lookup = json.load(stream)[-1]
    if language not in lookup:
        raise ValueError(f"Unknown IMS-Toucan language id: {language}")
    return torch.tensor([lookup[language]], dtype=torch.long, device=device)


def main() -> int:
    args = parse_args()
    engine_root = Path(args.engine_root).resolve()
    if not engine_root.is_dir():
        raise FileNotFoundError(f"IMS-Toucan engine directory is missing: {engine_root}")
    os.chdir(engine_root)
    sys.path.insert(0, str(engine_root))

    import pyloudnorm
    import soundfile
    import torch

    from Modules.ToucanTTS.InferenceToucanTTS import ToucanTTS
    from Modules.Vocoder.HiFiGAN_Generator import HiFiGAN
    from Preprocessing.articulatory_features import generate_feature_table, get_feature_to_index_lookup
    from Utility.utils import float2pcm

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    checkpoint = torch.load(Path(args.model), map_location="cpu", weights_only=False)
    phone_to_mel = ToucanTTS(weights=checkpoint["model"], config=checkpoint["config"])
    with torch.no_grad():
        phone_to_mel.store_inverse_all()
    phone_to_mel = phone_to_mel.to(device).eval()

    vocoder_checkpoint = torch.load(Path(args.vocoder), map_location="cpu", weights_only=False)
    vocoder = HiFiGAN()
    vocoder.load_state_dict(vocoder_checkpoint)
    vocoder = vocoder.to(device).eval()
    vocoder.remove_weight_norm()

    phones = ipa_to_tensor(
        args.ipa,
        torch,
        generate_feature_table(),
        get_feature_to_index_lookup(),
        device,
    )
    selected_language_id = language_id(args.language, torch, engine_root, device)
    speed = min(2.0, max(0.5, args.speed))
    pitch = min(1.4, max(0.7, args.pitch))
    volume = min(1.0, max(0.0, args.volume))

    with torch.inference_mode():
        mel, _, _, _ = phone_to_mel(
            phones,
            return_duration_pitch_energy=True,
            utterance_embedding=checkpoint["default_emb"].to(device),
            lang_id=selected_language_id,
            duration_scaling_factor=1.0 / speed,
            pitch_variance_scale=pitch,
            energy_variance_scale=1.0,
            pause_duration_scaling_factor=1.0,
            prosody_creativity=0.1,
        )
        wave = vocoder(mel.unsqueeze(0)).squeeze().cpu().numpy()

    meter = pyloudnorm.Meter(24000)
    try:
        loudness = meter.integrated_loudness(wave)
        target_loudness = -42.0 + (volume * 20.0)
        wave = pyloudnorm.normalize.loudness(wave, loudness, target_loudness)
    except ValueError:
        pass

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    soundfile.write(output, float2pcm(wave), 24000, subtype="PCM_16")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
