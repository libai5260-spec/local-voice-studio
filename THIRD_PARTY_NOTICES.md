# Third-party notices

## Scope of the source-code license

Original Voice Studio application code is licensed under the root
[MIT license](LICENSE). This does not replace or override any license on
third-party code, bundled audio, downloaded model weights, or generated outputs.
Full retained license texts and verified upstream sources are listed in
[licenses/README.md](licenses/README.md).

Voice Studio uses the following open-source projects:

- [Resemble AI Chatterbox](https://github.com/resemble-ai/chatterbox), MIT License. Its full upstream license is retained in [licenses/CHATTERBOX-MIT.txt](licenses/CHATTERBOX-MIT.txt).
- [Transformers.js Chatterbox browser demo](https://github.com/resemble-ai/transformersjs-chatterbox-demo), declared MIT in its README. The worker inference adapter, audio resampling approach, and long-text chunking approach are adapted from this reference implementation. See the [retained attribution and MIT text](licenses/TRANSFORMERSJS-CHATTERBOX-DEMO-NOTICE.md); the standalone upstream checkout is not redistributed.
- [Hugging Face Transformers.js](https://github.com/huggingface/transformers.js), Apache-2.0 License.
- [@breezystack/lamejs](https://github.com/breezystack/lamejs), LGPL-3.0 License, used for MP3 export.
- React, Vite, vinext, Tailwind CSS, and related dependencies under their respective licenses.

## Built-in human voice references

Seven built-in English reference clips are excerpts from the `test-clean` subset of
[LibriSpeech](https://www.openslr.org/12), distributed under the
[Creative Commons Attribution 4.0 International license](https://creativecommons.org/licenses/by/4.0/).
LibriSpeech is derived from LibriVox audiobook recordings and was prepared by
Vassil Panayotov, Guoguo Chen, Daniel Povey, and Sanjeev Khudanpur.

The included excerpts retain their LibriSpeech utterance and reader attribution:

- `Natural · Warm`: reader 2094, amycsj, utterance `2094-142345-0001`.
- `Natural · Expressive`: reader 3575, supergirl, utterance `3575-170457-0003`.
- `Natural · Clear`: reader 2961, Leni, utterance `2961-960-0007`.
- `Natural · Bright`: reader 8463, Michele Fry, utterance `8463-287645-0003`.
- `Natural · Calm`: reader 1995, AJai Hilton, utterance `1995-1826-0000`.
- `Natural · Story`: reader 1284, Daniel Anaya, utterance `1284-1180-0001`.
- `Natural · Friendly`: reader 5142, Mary Ballard-Johansson, utterance `5142-33396-0031`.

The clips are unaltered, clean mono speech excerpts selected as voice-conditioning
references. The friendly labels describe their intended presentation in this app
and are not the readers' own descriptions.

### VCTK American female reference collection

Ten additional references are excerpts from the
[CSTR VCTK Corpus v0.92](https://datashare.ed.ac.uk/handle/10283/3443), created by
Christophe Veaux, Junichi Yamagishi, and Kirsten MacDonald at the University of
Edinburgh and distributed under the
[Creative Commons Attribution 4.0 International license](https://creativecommons.org/licenses/by/4.0/).
The 16 kHz files were retrieved from the
[`saeedzou/vctk-16khz`](https://huggingface.co/datasets/saeedzou/vctk-16khz)
repackaging, whose annotations are taken from the original VCTK release.
They are renamed for display in this application; the repackaging's 16 kHz
sample rate is a change from the original 48 kHz corpus. The
[official dataset license text](https://datashare.ed.ac.uk/server/api/core/bitstreams/956a1688-0b59-428c-8a2f-10837433dde3/content)
retains the CC BY 4.0 conditions and disclaimer of warranties.

The included speaker and utterance identifiers are:

- `US Female 01 · San Francisco`: speaker `p294`, utterance `p294_003`.
- `US Female 02 · New York`: speaker `p297`, utterance `p297_003`.
- `US Female 03 · California`: speaker `p299`, utterance `p299_003`.
- `US Female 04 · California`: speaker `p300`, utterance `p300_003`.
- `US Female 05 · North Carolina`: speaker `p301`, utterance `p301_003`.
- `US Female 06 · Philadelphia`: speaker `p305`, utterance `p305_003`.
- `US Female 07 · New York`: speaker `p306`, utterance `p306_003`.
- `US Female 08 · Alabama`: speaker `p308`, utterance `p308_003`.
- `US Female 09 · Tennessee`: speaker `p310`, utterance `p310_003`.
- `US Female 10 · Napa`: speaker `p318`, utterance `p318_023`.

All ten speakers are marked female with an American accent in the VCTK metadata.
Regional labels are reproduced from those annotations; the project does not try
to identify the people behind the anonymous speaker IDs.
Dataset attribution does not imply endorsement by the speakers or dataset
creators and does not grant publicity, privacy, or other personality rights.
Legacy MP3 references without verified redistribution terms are not included
in the public source release.

The Chatterbox fallback remains browser-only. Local stub packages replace
Transformers.js's unused Node inference and server-side image-processing
dependencies; browser inference uses the `onnxruntime-web` implementation.

## Fish S2 Pro local engine

Built with Fish Audio. The additional loopback-only Python service uses
[MLX-Audio](https://github.com/Blaizzy/mlx-audio) (MIT) and the
[MLX-community S2 Pro BF16 conversion](https://huggingface.co/mlx-community/fish-audio-s2-pro-bf16).
The full MLX-Audio v0.5.9 license is retained in
[licenses/MLX-AUDIO-MIT.txt](licenses/MLX-AUDIO-MIT.txt).
The weights retain the [Fish Audio Research License](https://huggingface.co/fishaudio/s2-pro/blob/main/LICENSE.md).
Personal non-commercial and research use is allowed under that license;
commercial use, including business internal operations, requires a separate
Fish Audio license. The full model license is retained in
[licenses/FISH-AUDIO-RESEARCH-LICENSE.md](licenses/FISH-AUDIO-RESEARCH-LICENSE.md)
and with downloaded weights; attribution is in
[backend/FISH-NOTICE.txt](backend/FISH-NOTICE.txt).
No Fish Audio hosted voices or cloud account data are copied into this project.
Model weights, Python/Node runtimes, download caches, personal recordings and
generated history are not included in the source release.

Dependency license texts are included in the installed packages under `node_modules` after first setup. Source links above are retained so users can inspect and replace the corresponding libraries.
