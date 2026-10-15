# License sources

Original Voice Studio application code is covered by the root [MIT license](../LICENSE).
Third-party code, model weights and audio references retain their own licenses;
the root license does not relicense them. See [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)
for component and audio attribution.

Verified on 2026-10-16:

- [CHATTERBOX-MIT.txt](CHATTERBOX-MIT.txt): full upstream [Chatterbox license](https://raw.githubusercontent.com/resemble-ai/chatterbox/master/LICENSE), including its original `Copyright (c) 2025 Resemble AI` line.
- [TRANSFORMERSJS-CHATTERBOX-DEMO-NOTICE.md](TRANSFORMERSJS-CHATTERBOX-DEMO-NOTICE.md): records the [demo's MIT declaration](https://github.com/resemble-ai/transformersjs-chatterbox-demo#license), local reference commit, and full MIT permission/disclaimer. Upstream does not supply a separate copyright line; none is invented.
- [MLX-AUDIO-MIT.txt](MLX-AUDIO-MIT.txt): full [MLX-Audio v0.5.9 license](https://raw.githubusercontent.com/Blaizzy/mlx-audio/v0.5.9/LICENSE), including its original `Copyright (c) 2024 Prince Canuma` line.
- [FISH-AUDIO-RESEARCH-LICENSE.md](FISH-AUDIO-RESEARCH-LICENSE.md): full license from the [exact pinned MLX model revision](https://huggingface.co/mlx-community/fish-audio-s2-pro-bf16/blob/eccd57bf5c1ebc13cb2f993df867f4e49931a36a/LICENSE.md). Git blob hash: `b469a1a983b3f961e839881fc0ea5c4eb82ec4be`, matching the downloader's expected license file. The [original Fish model license](https://huggingface.co/fishaudio/s2-pro/blob/main/LICENSE.md) is also available upstream. This license is not MIT and requires separate permission for commercial use, including business internal operations.

The [VCTK license file](https://datashare.ed.ac.uk/server/api/core/bitstreams/956a1688-0b59-428c-8a2f-10837433dde3/content)
and [LibriSpeech resource page](https://www.openslr.org/12) identify the included
reference datasets as CC BY 4.0. Their full license is available from
[Creative Commons](https://creativecommons.org/licenses/by/4.0/legalcode).
Attribution and the disclaimer of warranties are retained by these links and
the dataset notices. This does not grant endorsement, publicity or privacy rights.

Other package license texts are distributed with their installed npm/Python
packages. Those packages and model weights are downloaded during setup, not
copied into this source repository.
