/** Transcript metadata for the existing VCTK references; no audio is downloaded here. */
export const FEMALE_VOICE_TRANSCRIPT_SOURCE_URL = "https://huggingface.co/datasets/saeedzou/vctk-16khz";

// Verified from https://datasets-server.huggingface.co/rows with dataset=
// saeedzou/vctk-16khz, config=default, split=train, length=100 and the offsets
// below. Every exact file_id match also reports gender=F and accent=American.
// The first nine references use each speaker's _003; p318 uses _023 instead.
const SIX_SPOONS = "Six spoons of fresh snow peas, five thick slabs of blue cheese, and maybe a snack for her brother Bob.";

export const FEMALE_VOICE_TRANSCRIPTS: Record<string, string> = {
  "builtin-vctk-us-female-p294": SIX_SPOONS, // p294_003, row page 26100
  "builtin-vctk-us-female-p297": SIX_SPOONS, // p297_003, row page 27200
  "builtin-vctk-us-female-p299": SIX_SPOONS, // p299_003, row page 27900
  "builtin-vctk-us-female-p300": SIX_SPOONS, // p300_003, row page 28300
  "builtin-vctk-us-female-p301": SIX_SPOONS, // p301_003, row page 28700
  "builtin-vctk-us-female-p305": SIX_SPOONS, // p305_003, row page 30400
  "builtin-vctk-us-female-p306": SIX_SPOONS, // p306_003, row page 30600
  "builtin-vctk-us-female-p308": SIX_SPOONS, // p308_003, row page 31400
  "builtin-vctk-us-female-p310": SIX_SPOONS, // p310_003, row page 31900
  // p318_023, row page 34700: this is a different reference recording.
  "builtin-vctk-us-female-p318": "If the red of the second bow falls upon the green of the first, the result is to give a bow with an abnormally wide yellow band, since red and green light when mixed form yellow.",
};
