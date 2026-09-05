URDR offline IPA speech resources

Engine 2.4 uses IMS-Toucan as its only speech synthesis backend. IPA input is sent
directly to the ToucanTTS articulatory frontend with input_phonemes enabled. URDR no
longer transliterates IPA into Korean or English text and no longer falls back to the
Windows speech service.

The packaged runtime consists of Python 3.10, the required Python wheels, the
IMS-Toucan inference source, ToucanTTS.pt, and Vocoder.pt. All paths are verified
against manifest.json before synthesis starts. Generated WAV files are cached under
the user's local URDR data directory.

IMS-Toucan source: https://github.com/DigitalPhonetics/IMS-Toucan
IMS-Toucan source revision: 3cc2094d9c7123336eda7e299ac0bc90319ca9ff
IMS-Toucan license: Apache-2.0
Pretrained model source: https://huggingface.co/Flux9665/ToucanTTS
ToucanTTS.pt SHA-256: b36d5d79669ef2b36b1edbf6196132ba95c9e6b03c799d679191e259fe561a59
Vocoder.pt SHA-256: 3f4fa1ea04b2f723cdf4b7fed3ccc73b07fd8dd84723f1e8bc7dee80094ffdbf
