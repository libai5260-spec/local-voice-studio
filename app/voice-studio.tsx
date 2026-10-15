"use client";

import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  SAMPLE_RATE,
  joinSpeech,
  downloadBlob,
  encodeMp3,
  encodeWavAsync,
  playAudio,
  prepareVoiceReference,
} from "./lib/audio";
import { ActiveRecorder, audioFileToFloat32, createRecorder } from "./lib/recorder";
import {
  Generation,
  SavedVoice,
  deleteGeneration,
  deleteVoice,
  listHistory,
  listVoices,
  saveGeneration,
  saveVoice,
} from "./lib/storage";
import { boundaryPause } from "./lib/text";
import { generateLongSpeech } from "./lib/long-speech";
import { ttsClient, type GenerationProgress } from "./lib/tts-client";
import { prepareScript, insertScriptCue, buildAuditionPlan } from "./lib/script";
import { SAMPLING_PROFILES, type SamplingProfile } from "./lib/generation-settings";
import { inspectReference } from "./lib/reference-quality";
import { fishClient, type FishHealth } from "./lib/fish-client";
import { FEMALE_VOICE_TRANSCRIPTS } from "./lib/female-voices";

const DELIVERY_PRESETS = [
  { id: "natural", label: "自然", expression: 0.5 },
  { id: "restrained", label: "克制", expression: 0.3 },
  { id: "expressive", label: "鲜明", expression: 0.72 },
];

const FISH_STYLES = [
  { label: "自然对话", value: "" },
  { label: "温柔轻声", value: "[soft]" },
  { label: "活力讲述", value: "[excited]" },
  { label: "平静叙述", value: "[calm]" },
] as const;
const DRAFT_KEY = "voice-studio-draft-v1";

const PACE_PRESETS = [
  { id: "relaxed", label: "舒缓" },
  { id: "natural", label: "自然" },
  { id: "brisk", label: "明快" },
] as const;

type PaceId = (typeof PACE_PRESETS)[number]["id"];

const BUILT_IN_VOICES = [
  { id: "builtin-natural-warm-2094", name: "Natural · Warm", file: "/voice-samples/Natural-Warm-2094.flac" },
  { id: "builtin-natural-expressive-3575", name: "Natural · Expressive", file: "/voice-samples/Natural-Expressive-3575.flac" },
  { id: "builtin-natural-clear-2961", name: "Natural · Clear", file: "/voice-samples/Natural-Clear-2961.flac" },
  { id: "builtin-natural-bright-8463", name: "Natural · Bright", file: "/voice-samples/Natural-Bright-8463.flac" },
  { id: "builtin-natural-calm-1995", name: "Natural · Calm", file: "/voice-samples/Natural-Calm-1995.flac" },
  { id: "builtin-natural-story-1284", name: "Natural · Story", file: "/voice-samples/Natural-Story-1284.flac" },
  { id: "builtin-natural-friendly-5142", name: "Natural · Friendly", file: "/voice-samples/Natural-Friendly-5142.flac" },
  { id: "builtin-vctk-us-female-p294", name: "US Female 01 · San Francisco", file: "/voice-samples/US-Female-01-p294.wav" },
  { id: "builtin-vctk-us-female-p297", name: "US Female 02 · New York", file: "/voice-samples/US-Female-02-p297.wav" },
  { id: "builtin-vctk-us-female-p299", name: "US Female 03 · California", file: "/voice-samples/US-Female-03-p299.wav" },
  { id: "builtin-vctk-us-female-p300", name: "US Female 04 · California", file: "/voice-samples/US-Female-04-p300.wav" },
  { id: "builtin-vctk-us-female-p301", name: "US Female 05 · North Carolina", file: "/voice-samples/US-Female-05-p301.wav" },
  { id: "builtin-vctk-us-female-p305", name: "US Female 06 · Philadelphia", file: "/voice-samples/US-Female-06-p305.wav" },
  { id: "builtin-vctk-us-female-p306", name: "US Female 07 · New York", file: "/voice-samples/US-Female-07-p306.wav" },
  { id: "builtin-vctk-us-female-p308", name: "US Female 08 · Alabama", file: "/voice-samples/US-Female-08-p308.wav" },
  { id: "builtin-vctk-us-female-p310", name: "US Female 09 · Tennessee", file: "/voice-samples/US-Female-09-p310.wav" },
  { id: "builtin-vctk-us-female-p318", name: "US Female 10 · Napa", file: "/voice-samples/US-Female-10-p318.wav" },
] as const;

export default function VoiceStudio() {
  const [voices, setVoices] = useState<SavedVoice[]>([]);
  const [history, setHistory] = useState<Generation[]>([]);
  const [selectedVoiceId, setSelectedVoiceId] = useState("");
  const [pendingAudio, setPendingAudio] = useState<Float32Array | null>(null);
  const [pendingSource, setPendingSource] = useState<"uploaded" | "recorded">("uploaded");
  const [voiceName, setVoiceName] = useState("");
  const [consent, setConsent] = useState(false);
  const [learningVoice, setLearningVoice] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [script, setScript] = useState(
    "Welcome to my private voice studio. This speech is generated locally on my Mac.",
  );
  const [delivery, setDelivery] = useState("natural");
  const [expression, setExpression] = useState(0.5);
  const [pace, setPace] = useState<PaceId>("natural");
  const [engine, setEngine] = useState<"fish" | "chatterbox">("fish");
  const [fishHealth, setFishHealth] = useState<FishHealth>({ status: "loading" });
  const [instruction, setInstruction] = useState("");
  const [samplingProfile, setSamplingProfile] = useState<SamplingProfile>("balanced");
  const [voiceSearch, setVoiceSearch] = useState("");
  const [voiceFilter, setVoiceFilter] = useState<"female" | "mine">("female");
  const [referenceText, setReferenceText] = useState("");
  const [draftReady, setDraftReady] = useState(false);
  const [draftSaved, setDraftSaved] = useState(false);
  const [generationKind, setGenerationKind] = useState<"full" | "audition">("full");
  const [modelState, setModelState] = useState<"idle" | "loading" | "ready">("idle");
  const [modelDevice, setModelDevice] = useState<"webgpu" | "wasm" | null>(null);
  const [modelProgress, setModelProgress] = useState(0);
  const [modelFile, setModelFile] = useState("");
  const [generating, setGenerating] = useState(false);
  const [chunkProgress, setChunkProgress] = useState({ current: 0, total: 0 });
  const [generationDetail, setGenerationDetail] = useState<GenerationProgress | null>(null);
  const [generationSeconds, setGenerationSeconds] = useState(0);
  const [cancelling, setCancelling] = useState(false);
  const [latest, setLatest] = useState<Generation | null>(null);
  const [exportingId, setExportingId] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<{ id: string; name: string } | null>(null);
  const [resultPlaying, setResultPlaying] = useState(false);
  const [cloneExpanded, setCloneExpanded] = useState(false);

  const recorderRef = useRef<ActiveRecorder | null>(null);
  const previewControllerRef = useRef<AbortController | null>(null);
  const recordingTimerRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const scriptRef = useRef<HTMLTextAreaElement | null>(null);
  const resultPlayerRef = useRef<HTMLAudioElement | null>(null);
  const encodedVoicesRef = useRef(new Set<string>());
  const modelLoadPromiseRef = useRef<Promise<"webgpu" | "wasm"> | null>(null);
  const modelEpochRef = useRef(0);
  const selectedEngineRef = useRef(engine);
  selectedEngineRef.current = engine;
  const cancelRequestedRef = useRef(false);
  const generationBusyRef = useRef(false);
  const latestUrl = useAudioUrl(latest?.audio ?? null, latest?.sampleRate ?? SAMPLE_RATE);

  const selectedVoice = useMemo(
    () => voices.find((voice) => voice.id === selectedVoiceId) ?? null,
    [selectedVoiceId, voices],
  );
  const preparedScript = useMemo(() => prepareScript(script, engine), [script, engine]);
  const speechPlan = preparedScript.chunks;
  const referenceReport = useMemo(() => pendingAudio ? inspectReference(pendingAudio) : null, [pendingAudio]);
  const filteredVoices = useMemo(() => voices.filter((voice) =>
    (voiceFilter === "female" ? voice.id.startsWith("builtin-vctk-us-female-") : voice.source !== "built-in") &&
    voice.name.toLowerCase().includes(voiceSearch.toLowerCase().trim()))
    .sort((a, b) => voiceFilter === "female" ? a.name.localeCompare(b.name) : b.createdAt - a.createdAt), [voices, voiceFilter, voiceSearch]);
  const selectedReferenceText = selectedVoice ? selectedVoice.referenceText || FEMALE_VOICE_TRANSCRIPTS[selectedVoice.id] || "" : "";

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
      if (saved && typeof saved === "object") {
        if (typeof saved.script === "string") setScript(saved.script.slice(0, 30000));
        if (typeof saved.selectedVoiceId === "string") setSelectedVoiceId(saved.selectedVoiceId);
        if (saved.engine === "chatterbox") setEngine("chatterbox");
        if (["balanced", "steady", "expressive"].includes(saved.samplingProfile)) setSamplingProfile(saved.samplingProfile);
        if (["natural", "relaxed", "brisk"].includes(saved.pace)) setPace(saved.pace);
        if (typeof saved.expression === "number" && Number.isFinite(saved.expression)) setExpression(Math.max(0, Math.min(1.5, saved.expression)));
        if (typeof saved.instruction === "string") setInstruction(saved.instruction.slice(0, 300));
      }
    } catch { /* A blocked/corrupt draft must not prevent voice generation. */ }
    setDraftReady(true);
  }, []);

  useEffect(() => {
    if (!draftReady) return;
    setDraftSaved(false);
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify({ script, selectedVoiceId, engine, samplingProfile, expression, pace, instruction }));
        setDraftSaved(true);
      } catch { setDraftSaved(false); }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [draftReady, script, selectedVoiceId, engine, samplingProfile, expression, pace, instruction]);

  useEffect(() => {
    if (engine !== "fish") return;
    modelEpochRef.current++;
    modelLoadPromiseRef.current = null;
    ttsClient.reset();
    setModelState("idle");
    encodedVoicesRef.current.clear();
    let active = true;
    let timer: number;
    const check = async () => {
      const health = await fishClient.health();
      if (!active) return;
      setFishHealth(health);
      timer = window.setTimeout(check, 5000);
    };
    void check();
    return () => { active = false; window.clearTimeout(timer); };
  }, [engine]);

  useEffect(() => {
    let active = true;

    void Promise.all([listVoices(), listHistory()])
      .then(async ([storedVoices, storedHistory]) => {
        const availableVoices = await restoreBuiltInVoices(storedVoices);
        if (!active) return;
        setVoices(availableVoices);
        setHistory(storedHistory);
        setLatest(storedHistory[0] ?? null);
        setSelectedVoiceId((current) => availableVoices.some((voice) => voice.id === current && voice.id.startsWith("builtin-vctk-us-female-")) ? current : availableVoices.find((voice) => voice.id === "builtin-vctk-us-female-p299")?.id || availableVoices.find((voice) => voice.id.startsWith("builtin-vctk-us-female-"))?.id || "");
      })
      .catch(() => {
        if (active) setError("无法读取本地记录，请检查浏览器的存储权限。");
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    return ttsClient.onProgress((progress) => {
      if (typeof progress.progress === "number") {
        setModelProgress((current) => Math.max(
          current,
          Math.max(1, Math.min(100, Math.round(progress.progress ?? 0))),
        ));
      }
      const filename = progress.file ?? progress.name ?? "";
      if (filename) setModelFile(filename.split("/").pop() ?? filename);
    });
  }, []);

  useEffect(() => ttsClient.onGenerationProgress(setGenerationDetail), []);

  useEffect(() => {
    if (!generating) return;
    const started = performance.now();
    const timer = window.setInterval(() => setGenerationSeconds(Math.floor((performance.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [generating]);

  useEffect(() => {
    return () => {
      if (recordingTimerRef.current) window.clearInterval(recordingTimerRef.current);
      recorderRef.current?.cancel();
      previewControllerRef.current?.abort();
      previewControllerRef.current = null;
    };
  }, []);

  const clearMessages = () => {
    setNotice("");
    setError("");
  };

  const previewVoice = async (id: string, name: string, audio: Float32Array, sampleRate = SAMPLE_RATE) => {
    // The ref locks immediately, including rapid clicks before React renders.
    if (previewControllerRef.current || generationBusyRef.current || (resultPlayerRef.current && !resultPlayerRef.current.paused)) return;
    const controller = new AbortController();
    previewControllerRef.current = controller;
    setPreview({ id, name });
    try {
      await playAudio(audio, controller.signal, sampleRate);
    } catch {
      if (!controller.signal.aborted) setError("试听播放失败，请重试。");
    } finally {
      if (previewControllerRef.current === controller) {
        previewControllerRef.current = null;
        setPreview(null);
      }
    }
  };

  const startRecording = async () => {
    clearMessages();
    try {
      const recorder = await createRecorder();
      recorderRef.current = recorder;
      recorder.start();
      setPendingAudio(null);
      setRecordSeconds(0);
      setRecording(true);
      const startedAt = Date.now();
      recordingTimerRef.current = window.setInterval(() => {
        setRecordSeconds((Date.now() - startedAt) / 1000);
      }, 100);
    } catch {
      setError("无法使用麦克风。请在浏览器地址栏允许麦克风权限。");
    }
  };

  const stopRecording = async () => {
    if (!recorderRef.current) return;
    clearMessages();
    setRecording(false);
    if (recordingTimerRef.current) window.clearInterval(recordingTimerRef.current);
    recordingTimerRef.current = null;
    try {
      const audio = await recorderRef.current.stop();
      recorderRef.current = null;
      if (audio.length > SAMPLE_RATE * 30) {
        setError("录音超过 30 秒，请重新录制 5–10 秒。为避免与原文不一致，不会自动截断录音。");
        return;
      }
      const trimmed = audio;
      setPendingAudio(trimmed);
      setPendingSource("recorded");
      if (trimmed.length < SAMPLE_RATE * 3) {
        setNotice("录音已保留，但建议录制 5–10 秒以获得更高的相似度。");
      } else {
        setNotice("声音样本已就绪，请为它命名并保存。");
      }
    } catch {
      setError("录音处理失败，请重试。");
    }
  };

  const handleAudioFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    clearMessages();
    try {
      const audio = await audioFileToFloat32(file);
      if (audio.length > SAMPLE_RATE * 30) return setError("请上传不超过 30 秒的完整录音，并填写对应原文。不会自动裁剪，避免音文不一致。");
      setPendingAudio(audio);
      setReferenceText("");
      setPendingSource("uploaded");
      setVoiceName(file.name.replace(/\.[^.]+$/, ""));
      setNotice("音频已载入，请确认名称后开始学习并保存。");
    } catch {
      setError("无法读取该音频，请使用 WAV、MP3、M4A 或 WebM 文件。");
    }
  };

  const handleSaveVoice = async () => {
    if (generationBusyRef.current || learningVoice) return;
    clearMessages();
    if (!pendingAudio) return setError("请先录制或上传一段声音。");
    if (!voiceName.trim()) return setError("请输入音色名称。");
    if (!consent) return setError("请确认这是你本人或已获授权的声音。");
    if (!inspectReference(pendingAudio).usable) return setError("声音样本无效或接近静音，请重新录制。");
    if (engine === "fish" && pendingAudio.length < SAMPLE_RATE * 2) return setError("Fish 模型至少需要 2 秒参考录音，建议录制 5–10 秒。");
    if (engine === "fish" && !referenceText.trim()) return setError("请填写录音中实际说出的英文原文，帮助 Fish 准确学习女声。");

    const storedAudio = copyBuffer(pendingAudio);
    const voice: SavedVoice = {
      id: crypto.randomUUID(),
      name: voiceName.trim(),
      createdAt: Date.now(),
      duration: pendingAudio.length / SAMPLE_RATE,
      audio: storedAudio,
      source: pendingSource,
      referenceText: referenceText.trim() || undefined,
    };

    setLearningVoice(true);
    try {
      await saveVoice(voice);
      setVoices((current) => [voice, ...current]);
      setSelectedVoiceId(voice.id);
      setVoiceFilter("mine");
      setNotice(`已保存“${voice.name}”，正在学习音色特征…`);

      try {
        if (engine === "fish") {
          setNotice(`已保存“${voice.name}”及录音原文，首次生成时会读取声音特征。`);
        } else {
        await ensureModel();
        await ttsClient.encodeSpeaker(voice.id, prepareVoiceReference(new Float32Array(voice.audio)));
        encodedVoicesRef.current.add(voice.id);
        const learnedVoice = { ...voice, learnedAt: Date.now() };
        await saveVoice(learnedVoice);
        setVoices((current) => current.map((item) => item.id === voice.id ? learnedVoice : item));
        setNotice(`已学习并保存音色“${voice.name}”，现在可以直接使用。`);
        }
      } catch {
        setNotice(`已保存音色“${voice.name}”；首次生成时会自动继续学习。`);
      }

      setPendingAudio(null);
      setVoiceName("");
      setReferenceText("");
      setConsent(false);
    } catch {
      setError("无法保存该音色，请检查浏览器存储空间。");
    } finally {
      setLearningVoice(false);
    }
  };

  const handleDeleteVoice = async (voice: SavedVoice) => {
    if (!window.confirm(`删除音色“${voice.name}”？该操作无法撤销。`)) return;
    await deleteVoice(voice.id);
    void ttsClient.releaseSpeaker(voice.id).catch(() => {});
    encodedVoicesRef.current.delete(voice.id);
    const remaining = voices.filter((item) => item.id !== voice.id);
    setVoices(remaining);
    if (selectedVoiceId === voice.id) setSelectedVoiceId(remaining.find((item) => item.id.startsWith("builtin-vctk-us-female-"))?.id ?? "");
  };

  const applyPreset = (id: string) => {
    const preset = DELIVERY_PRESETS.find((item) => item.id === id);
    if (!preset) return;
    setDelivery(id);
    setExpression(preset.expression);
  };

  const ensureModel = useCallback(async () => {
    const epoch = modelEpochRef.current;
    const checkActive = () => {
      if (selectedEngineRef.current !== "chatterbox" || modelEpochRef.current !== epoch) throw new DOMException("模型选择已改变。", "AbortError");
    };
    checkActive();
    if (ttsClient.isLoaded) return modelDevice ?? "webgpu";
    if (modelLoadPromiseRef.current) return modelLoadPromiseRef.current;

    const loadTask = (async () => {
      setModelState("loading");
      setModelProgress(1);
      setModelFile("正在读取本地模型…");
      const capability = await ttsClient.checkWebGpu();
      checkActive();
      let result;
      if (capability.available) {
        try {
          result = await ttsClient.load("webgpu");
        } catch (cause) {
          checkActive();
          console.warn("[Voice Studio] Apple GPU model load failed; using compatibility mode.", cause);
          ttsClient.reset();
          encodedVoicesRef.current.clear();
          setModelProgress(1);
          setModelFile("正在切换兼容模式…");
          result = await ttsClient.load("wasm");
        }
      } else {
        result = await ttsClient.load("wasm");
      }
      checkActive();
      setModelDevice(result.device);
      setModelState("ready");
      setModelProgress(100);
      setModelFile("");
      return result.device;
    })();

    modelLoadPromiseRef.current = loadTask;
    try {
      return await loadTask;
    } catch (cause) {
      if (modelEpochRef.current === epoch) setModelState("idle");
      throw cause;
    } finally {
      if (modelLoadPromiseRef.current === loadTask) modelLoadPromiseRef.current = null;
    }
  }, [modelDevice]);

  useEffect(() => {
    if (engine !== "chatterbox" || !draftReady) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void ensureModel().catch((cause) => {
        if (!active) return;
        setError(cause instanceof Error
          ? `模型预载失败：${cause.message}`
          : "模型预载失败，请刷新后重试。");
      });
    }, 200);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [ensureModel, engine, draftReady]);

  const handleGenerate = async (kind: "full" | "audition" = "full") => {
    if (generationBusyRef.current || learningVoice) return;
    clearMessages();
    if (!selectedVoice) return setError("请先录制并保存一个音色。");
    if (!preparedScript.spokenText.trim()) return setError("请输入需要朗读的英文内容，不能只有语气标签。");
    if (engine === "fish" && !selectedReferenceText) return setError("该音色缺少录音原文。请先使用精选美国女声，或重新上传并填写原文。");
    if (previewControllerRef.current) return setError("请等待当前音色试听结束后再生成。");

    generationBusyRef.current = true;
    setGenerationKind(kind);
    setGenerating(true);
    setGenerationSeconds(0);
    setGenerationDetail(null);
    setCancelling(false);
    cancelRequestedRef.current = false;
    try {
      if (engine === "fish") {
        const health = await fishClient.health();
        setFishHealth(health);
        if (health.status !== "ready") throw new Error(health.error || "Fish 模型尚未就绪，请等待模型载入完成。");
      } else {
      await ensureModel();
      if (cancelRequestedRef.current) throw new DOMException("已停止生成。", "AbortError");
      if (!encodedVoicesRef.current.has(selectedVoice.id)) {
        setNotice("正在学习该音色…");
        await ttsClient.encodeSpeaker(selectedVoice.id, prepareVoiceReference(new Float32Array(selectedVoice.audio)));
        encodedVoicesRef.current.add(selectedVoice.id);
        if (!selectedVoice.learnedAt) {
          const learnedVoice = { ...selectedVoice, learnedAt: Date.now() };
          await saveVoice(learnedVoice);
          setVoices((current) => current.map((item) => item.id === selectedVoice.id ? learnedVoice : item));
        }
      }
      }

      if (!speechPlan.length) throw new Error("没有可生成的文本。");
      const plan = kind === "audition" ? buildAuditionPlan(speechPlan) : speechPlan;
      const sampleRate = engine === "fish" ? 44_100 : SAMPLE_RATE;
      const parts = await generateLongSpeech(plan, {
        generate: (text) => engine === "fish"
          ? fishClient.generate(text, new Float32Array(selectedVoice.audio), selectedReferenceText, samplingProfile, instruction)
          : ttsClient.generate(text, selectedVoice.id, expression, samplingProfile),
        isCancelled: () => cancelRequestedRef.current,
        onChunk: (completed, total, text, retrying) => {
          setChunkProgress({ current: completed, total });
          setGenerationDetail(null);
          setNotice(retrying ? "当前片段需要重新生成，正在进行有限重试…" : text ? "正在生成：" + shorten(text, 90) : "正在整理完整音频…");
        },
      });

      setNotice("正在衔接段落并保存完整音频…");
      const processed = await joinSpeech(
        parts.map((part) => part.waveform),
        parts.map((part) => part.pauseAfter ?? boundaryPause(part.boundary, pace)),
        () => cancelRequestedRef.current,
        sampleRate,
      );
      parts.length = 0;
      if (cancelRequestedRef.current) throw new DOMException("已停止生成。", "AbortError");
      // Preserve speech timing and pitch; only excess edge silence is removed.
      const generation: Generation = {
        id: crypto.randomUUID(),
        text: kind === "audition" ? plan.map((part) => part.text).join(" ") : script.trim(),
        sourceText: script.trim(),
        voiceId: selectedVoice.id,
        samplingProfile,
        kind,
        engine,
        sampleRate,
        instruction,
        voiceName: selectedVoice.name,
        createdAt: Date.now(),
        duration: processed.length / sampleRate,
        expression,
        pace,
        speed: 1,
        pitch: 0,
        audio: processed.buffer as ArrayBuffer,
      };
      setLatest(generation);
      try {
        await saveGeneration(generation);
        setHistory((current) => [generation, ...current].slice(0, 24));
        setNotice(kind === "audition" ? "试读完成，已保留这个版本。试听满意后可生成全文，或调整后再试一版。" : "生成完成。完整音频已保存，可以连续播放或下载。");
      } catch {
        setError("语音已生成，但本地存储失败。请先下载最新结果，避免刷新后丢失。");
      }
    } catch (cause) {
      if (cancelRequestedRef.current || (cause instanceof Error && cause.name === "AbortError")) {
        setNotice("已停止生成，未保存不完整的音频。");
        return;
      }
      setError(cause instanceof Error
        ? `生成失败：${cause.message}`
        : "生成失败，请重试。");
    } finally {
      generationBusyRef.current = false;
      setGenerating(false);
      setCancelling(false);
      setGenerationDetail(null);
      setChunkProgress({ current: 0, total: 0 });
    }
  };

  const exportGeneration = async (generation: Generation, format: "wav" | "mp3") => {
    setExportingId(`${generation.id}-${format}`);
    clearMessages();
    try {
      const audio = new Float32Array(generation.audio);
      const sampleRate = generation.sampleRate ?? SAMPLE_RATE;
      const blob = format === "wav" ? await encodeWavAsync(audio, undefined, sampleRate) : await encodeMp3(audio, sampleRate);
      const safeName = generation.voiceName.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-|-$/g, "") || "voice";
      const date = new Date(generation.createdAt).toISOString().slice(0, 10);
      downloadBlob(blob, `${safeName}-${date}.${format}`);
      setNotice(`${format.toUpperCase()} 文件已下载。`);
    } catch {
      setError(`无法导出 ${format.toUpperCase()} 文件。`);
    } finally {
      setExportingId("");
    }
  };

  const removeGeneration = async (generation: Generation) => {
    if (!window.confirm("删除这条生成记录？")) return;
    await deleteGeneration(generation.id);
    const remaining = history.filter((item) => item.id !== generation.id);
    setHistory(remaining);
    if (latest?.id === generation.id) setLatest(remaining[0] ?? null);
  };

  const insertCue = (cue: string) => {
    const field = scriptRef.current;
    const inserted = insertScriptCue(script, cue, field?.selectionStart ?? script.length, field?.selectionEnd ?? script.length);
    setScript(inserted.text);
    window.requestAnimationFrame(() => { field?.focus(); field?.setSelectionRange(inserted.cursor, inserted.cursor); });
  };

  const reuseGeneration = (generation: Generation) => {
    if (generating) return;
    setScript(generation.sourceText ?? generation.text);
    setExpression(generation.expression);
    setDelivery("custom");
    setPace(generation.pace ?? "natural");
    setSamplingProfile(generation.samplingProfile ?? "balanced");
    setEngine(generation.engine ?? "chatterbox");
    setInstruction(generation.instruction ?? "");
    const voice = voices.find((item) => generation.voiceId ? item.id === generation.voiceId : item.name === generation.voiceName);
    if (voice) { setSelectedVoiceId(voice.id); setVoiceFilter(voice.source === "built-in" ? "female" : "mine"); }
    setNotice(voice ? "已恢复这版文本、音色和参数，可修改后再生成。" : "已恢复文本和参数；原音色已不存在，请重新选择。");
    scriptRef.current?.focus();
  };

  const resetDelivery = () => {
    applyPreset("natural");
    setPace("natural");
    setSamplingProfile("balanced");
    setInstruction("");
  };

  const engineReady = engine === "fish" ? fishHealth.status === "ready" || fishHealth.status === "generating" : modelState === "ready";
  const fishDownloading = fishHealth.status === "missing" && fishHealth.download_active;
  const fishDownloadPercent = Math.min(100, Math.floor((fishHealth.download_bytes ?? 0) / Math.max(1, fishHealth.download_total_bytes ?? 1) * 100));
  const modelTitle = engine === "fish" ? (fishHealth.status === "ready" ? "Fish 本地模型已就绪" : fishHealth.status === "generating" ? "Fish 正在生成" : fishHealth.status === "loading" ? "Fish 模型载入中" : fishDownloading ? `Fish 模型下载中 · ${fishDownloadPercent}%` : "Fish 本地服务待准备") : modelState === "ready"
    ? "本地模型已就绪"
    : modelState === "loading" ? "正在准备本地模型" : "本地隐私模式";
  const modelSubtitle = engine === "fish" ? "Apple Silicon · 原生 44.1 kHz · 不上传云端" : modelState === "ready"
    ? (modelDevice === "webgpu" ? "Apple GPU 混合加速" : "兼容模式")
    : modelState === "loading" ? `${modelProgress}% · 首次载入后无需下载` : "音频不会上传云端";

  return (
    <main className="studio-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /><i /><i /></span>
          <div>
            <p className="brand-name">Voice Studio</p>
            <p className="brand-note">PRIVATE AUDIO WORKSPACE</p>
          </div>
        </div>
        <nav className="studio-nav" aria-label="工作室导航"><a className="active" href="#workspace">声音创作</a><a href="#voice-library">女声音色</a><a href="#history-title">生成历史</a></nav>
        <div className={`privacy-badge ${engineReady ? "is-ready" : ""}`} aria-live="polite">
          <span className="status-dot" aria-hidden="true" />
          <span><strong>{modelTitle}</strong><small>{modelSubtitle}</small></span>
        </div>
      </header>

      <section className="hero" aria-labelledby="page-title">
        <div className="hero-copy">
          <p className="eyebrow">YOUR WORDS. HER VOICE.</p>
          <h1 id="page-title">让文字拥有<em>自然的女声。</em></h1>
          <p>选一款女声，写一段故事。让每一句话，都有自己的表达。</p>
        </div>
        <div className="hero-proof" aria-label="产品特点">
          <div><strong>Local only</strong><span>声音与文字留在这台 Mac</span></div>
          <div><strong>{engine === "fish" ? "44.1" : "24"} kHz</strong><span>模型原生输出</span></div>
          <div><strong>10</strong><span>精选美国女声</span></div>
        </div>
      </section>

      <nav className="workflow-strip" aria-label="生成步骤">
        <div className={selectedVoice ? "is-complete" : "is-current"}>
          <span>01</span><p><strong>选择音色</strong><small>{selectedVoice?.name ?? "录制或上传声音"}</small></p>
        </div>
        <i aria-hidden="true" />
        <div className={script.trim() ? "is-complete" : "is-current"}>
          <span>02</span><p><strong>输入英文</strong><small>{script.trim() ? `${script.length} 个字符` : "输入要朗读的内容"}</small></p>
        </div>
        <i aria-hidden="true" />
        <div className={selectedVoice && script.trim() ? "is-current" : ""}>
          <span>03</span><p><strong>生成与下载</strong><small>长文自动分段 · 连续播放</small></p>
        </div>
      </nav>

      {(notice || error) && (
        <div className={`notice ${error ? "notice-error" : "notice-success"}`} role="status">
          <span>{error ? "!" : "✓"}</span>
          <p>{error || notice}</p>
          <button type="button" onClick={clearMessages} aria-label="关闭提示">×</button>
        </div>
      )}

      <section className="workspace-grid" id="workspace" aria-label="声音生成工作区">
        <article className="panel voice-panel">
          <PanelHeading number="1" title="找到你的声音" note="10 款美国女声 · 本地音色库" />
          <input ref={fileInputRef} className="sr-only" type="file" accept="audio/*,.wav,.mp3,.m4a,.webm" onChange={handleAudioFile} />
          <details className="clone-drawer" open={cloneExpanded || !!pendingAudio || recording} onToggle={(event) => setCloneExpanded(event.currentTarget.open)}>
          <summary><span aria-hidden="true">＋</span><span>添加我的音色<small>录音或上传，保存为专属声音</small></span><span className="drawer-arrow" aria-hidden="true">⌄</span></summary>
          <div className="clone-content">

          {!pendingAudio ? (
            <>
              <button
                className={`record-button ${recording ? "is-recording" : ""}`}
                type="button"
                onClick={recording ? stopRecording : startRecording}
                disabled={!recording && (generating || learningVoice || preview !== null || resultPlaying)}
              >
                <span className="record-icon" aria-hidden="true" />
                <strong>{recording ? "停止录音" : "开始录音"}</strong>
                <small>{recording ? formatDuration(recordSeconds) : "安静环境 · 距麦克风 15–25 cm"}</small>
                {recording && <span className="recording-bars" aria-hidden="true"><i /><i /><i /><i /><i /></span>}
              </button>
              <div className="divider"><span>或</span></div>
              <button className="secondary-button" type="button" disabled={generating || learningVoice || recording} onClick={() => fileInputRef.current?.click()}>
                <span aria-hidden="true">↑</span> 上传现有语音文件
              </button>
            </>
          ) : (
            <div className="voice-save-card">
              <div className="sample-ready">
                <button type="button" onClick={() => previewVoice("pending-sample", "声音样本", pendingAudio)} disabled={preview !== null || resultPlaying || generating} aria-label={preview?.id === "pending-sample" ? "正在试听声音样本" : "试听声音样本"}>{preview?.id === "pending-sample" ? "♫" : "▶"}</button>
                <div><strong>声音样本已就绪</strong><small>{formatDuration(pendingAudio.length / SAMPLE_RATE)}</small></div>
                <button className="plain-action" type="button" onClick={() => setPendingAudio(null)} disabled={learningVoice || preview?.id === "pending-sample"}>重新选择</button>
              </div>
              {referenceReport && <div className={`reference-report ${referenceReport.warnings.length ? "has-warning" : ""}`} role="status">
                <strong>{referenceReport.warnings.length ? "录音检查建议" : "录音音量与时长检查通过"}</strong>
                <p>{referenceReport.warnings.join(" ") || "请再确认只有一位说话者，没有音乐或明显背景噪声。"}</p>
              </div>}
              <label className="field-label" htmlFor="voice-name">音色名称</label>
              <input
                id="voice-name"
                className="text-input"
                value={voiceName}
                onChange={(event) => setVoiceName(event.target.value)}
                placeholder="例如：我的声音"
                maxLength={40}
                disabled={learningVoice}
              />
              <label className="field-label transcript-label" htmlFor="reference-text">录音英文原文 {engine === "fish" ? "· 必填" : "· 选填"}</label>
              <textarea id="reference-text" className="reference-transcript" value={referenceText} onChange={(event) => setReferenceText(event.target.value)} placeholder="填写这段录音实际说出的英文，不能填要生成的新文本。" maxLength={3000} disabled={learningVoice} />
              <label className="consent-check">
                <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} disabled={learningVoice} />
                <span>这是我本人录制或已明确获得授权的声音，我同意在本机学习并保存</span>
              </label>
              <button className="save-voice-button" type="button" onClick={handleSaveVoice} disabled={learningVoice || generating || !referenceReport?.usable}>
                {learningVoice ? "正在保存…" : "保存音色与原文"}
              </button>
              <p className="learning-note">音频与音色记录只保存在当前 Mac 的浏览器中，不会上传到云端。</p>
            </div>
          )}
          </div>
          </details>

          <div className="voice-library" id="voice-library">
            <div className="library-heading">
              <div><p className="micro-label">VOICE COLLECTION</p><p className="empty-note">试听参考录音，试读实际生成效果</p></div>
              <button type="button" className="icon-button" disabled={generating || learningVoice || recording} onClick={() => { setCloneExpanded(true); fileInputRef.current?.click(); }} aria-label="添加音色">+</button>
            </div>
            <input className="voice-search" type="search" aria-label="搜索女声音色" placeholder="搜索名称或地区…" value={voiceSearch} onChange={(event) => setVoiceSearch(event.target.value)} />
            <div className="voice-filters" aria-label="音色分类">
              <button type="button" aria-pressed={voiceFilter === "female"} onClick={() => setVoiceFilter("female")}>美国女声 · 10</button>
              <button type="button" aria-pressed={voiceFilter === "mine"} onClick={() => setVoiceFilter("mine")}>我的音色</button>
            </div>
            <p className="preview-status" role="status">{preview ? `正在试听 ${preview.name}，播放结束后可试听下一条。` : resultPlaying ? "正在播放生成结果，请等待播放结束。" : "每次只能试听一条音色，请等待播放完毕。"}</p>
            <div className="voice-list">
              {filteredVoices.map((voice) => (
                <div className={`voice-row ${selectedVoiceId === voice.id ? "selected" : ""}`} key={voice.id}>
                  <button className="voice-select" type="button" onClick={() => setSelectedVoiceId(voice.id)} disabled={generating} aria-pressed={selectedVoiceId === voice.id}>
                    <VoiceAvatar voice={voice} />
                    <span>
                      <strong>{voiceDisplayName(voice)}</strong>
                      <small>{selectedVoiceId === voice.id ? "已选中 · " : ""}{formatDuration(voice.duration)} · {voice.source === "built-in" ? "美国女声" : "我的声音"}</small>
                    </span>
                    <i aria-hidden="true" />
                  </button>
                  <button className={`row-action ${preview?.id === voice.id ? "is-previewing" : ""}`} type="button" onClick={() => previewVoice(voice.id, voice.name, new Float32Array(voice.audio))} disabled={preview !== null || resultPlaying || generating} aria-label={`${preview?.id === voice.id ? "正在试听" : "试听"} ${voice.name}`}>{preview?.id === voice.id ? "♫" : "▶"}</button>
                  {voice.source !== "built-in" && (
                    <button className="row-action delete" type="button" onClick={() => handleDeleteVoice(voice)} disabled={generating || learningVoice || preview?.id === voice.id} aria-label={`删除 ${voice.name}`}>×</button>
                  )}
                </div>
              ))}
              {!filteredVoices.length && <p className="empty-note">{voiceSearch ? "没有匹配的音色，试试其他关键词。" : "尚无自建音色，请上传或录制女声。"}</p>}
            </div>
          </div>
        </article>

        <article className="panel script-panel">
          <PanelHeading number="2" title="你的文字，她的声音" note="写下想说的话，留一点空间给情绪。" />
          <div className="editor-context"><span>EN <b>English</b></span><span><i /> 私密草稿</span></div>
          <div className="script-toolbar" aria-label="自然语气标签">
            <span>声音导演</span>
            <button type="button" onClick={() => insertCue("[pause]")}>短停顿</button>
            <button type="button" onClick={() => insertCue("[long pause]")}>长停顿</button>
            <button type="button" onClick={() => insertCue(engine === "fish" ? "[laughing]" : "[laughter]")}>轻笑</button>
            <button type="button" onClick={() => insertCue(engine === "fish" ? "[sighing]" : "[sigh]")}>叹气</button>
            {engine === "fish" && <button type="button" onClick={() => insertCue("[emphasis]")}>强调</button>}
            <button className="clear-script" type="button" onClick={() => setScript("")} disabled={!script}>清空</button>
          </div>
          <label className="sr-only" htmlFor="script">英文文本</label>
          <textarea
            ref={scriptRef}
            id="script"
            value={script}
            onChange={(event) => setScript(event.target.value)}
            placeholder="Type or paste English text here…"
            spellCheck="true"
            maxLength={30000}
          />
          <div className="text-meta">
            <span>{draftSaved ? "✓ 草稿已保存到本机" : "English · 本地草稿"}</span>
            <span>{script.length.toLocaleString()} / 30,000 · {speechPlan.length} 段</span>
          </div>
          <p className="editor-note">短停顿 0.35 秒 · 长停顿 0.75 秒。语气表现由模型决定；不会拉伸音频或改变音高。</p>
          {preparedScript.warnings.length > 0 && <p className="script-warning" role="status">{preparedScript.warnings.join(" ")}</p>}
          <div className="script-bottom-note"><span className="mini-wave" aria-hidden="true"><i /><i /><i /><i /><i /></span><p><strong>先听见，再决定。</strong><br />先试读一小段，每个版本都会为你保留。</p><span className="native-format">{engine === "fish" ? "44.1" : "24"}<small>kHz · 原生音频</small></span></div>
        </article>

        <article className="panel controls-panel">
          <PanelHeading number="3" title="赋予一点情绪" note="原生表达，不使用机械变速或变调。" />
          <label className="field-label" htmlFor="voice-engine">本地生成引擎</label>
          <select id="voice-engine" className="engine-select" value={engine} disabled={generating || learningVoice} onChange={(event) => { setEngine(event.target.value as "fish" | "chatterbox"); setError(""); }}>
            <option value="fish">Fish S2 Pro · 品质优先 · 44.1 kHz</option>
            <option value="chatterbox">Chatterbox · 原有备用 · 24 kHz</option>
          </select>

          <div className="current-voice-summary">
            {selectedVoice ? <VoiceAvatar voice={selectedVoice} /> : <span className="voice-avatar">?</span>}
            <p><small>当前音色</small><strong>{selectedVoice ? voiceDisplayName(selectedVoice) : "尚未选择"}</strong></p>
            <span className={selectedVoice ? "ready-dot" : "ready-dot is-idle"}>{selectedVoice ? "已选择" : "待选择"}</span>
          </div>

          <div className="settings-label"><span>{engine === "fish" ? "表达方向" : "语气强弱（非情绪指令）"}</span><button type="button" onClick={resetDelivery} disabled={generating}>恢复自然</button></div>

          {engine === "fish" ? <>
            <div className="preset-grid fish-presets">
              {FISH_STYLES.map((style) => <button type="button" key={style.label} className={instruction === style.value ? "active" : ""} aria-pressed={instruction === style.value} disabled={generating} onClick={() => setInstruction(style.value)}>{style.label}</button>)}
            </div>
            <label className="field-label" htmlFor="voice-direction">英文声音指令 · 可选</label>
            <input id="voice-direction" className="text-input direction-input" value={instruction} maxLength={300} disabled={generating} onChange={(event) => setInstruction(event.target.value)} placeholder="例如：[soft] [calm]" />
          </> : <>
          <div className="preset-grid" aria-label="表达风格">
            {DELIVERY_PRESETS.map((preset) => (
              <button
                key={preset.id}
                className={delivery === preset.id ? "active" : ""}
                type="button"
                aria-pressed={delivery === preset.id}
                disabled={generating}
                onClick={() => applyPreset(preset.id)}
              >{preset.label}</button>
            ))}
          </div>

          <RangeControl label="表达变化" value={expression} min={0} max={1.5} step={0.05} output={expression.toFixed(2)} disabled={generating} onChange={(value) => { setDelivery("custom"); setExpression(value); }} />
          </>}

          <details className="advanced-controls">
          <summary>高级设置<span>生成稳定性</span></summary>
          <div className="advanced-content">
          <div className="sampling-grid" aria-label="生成稳定性">
            {SAMPLING_PROFILES.map((profile) => <button type="button" key={profile.id} aria-pressed={samplingProfile === profile.id} disabled={generating} onClick={() => setSamplingProfile(profile.id)}>{profile.label}</button>)}
          </div>
          <p className="settings-help">{SAMPLING_PROFILES.find((profile) => profile.id === samplingProfile)?.description}</p>
          </div>
          </details>

          <div className="settings-label pace-heading"><span>自然节奏 · 调整停顿</span></div>
          <div className="pace-grid" aria-label="自然节奏">
            {PACE_PRESETS.map((preset) => (
              <button
                key={preset.id}
                className={pace === preset.id ? "active" : ""}
                type="button"
                aria-pressed={pace === preset.id}
                disabled={generating}
                onClick={() => setPace(preset.id)}
              >
                <strong>{preset.label}</strong>
                <small>{preset.id === "relaxed" ? "更多自然停顿" : preset.id === "brisk" ? "更少句间停顿" : "推荐"}</small>
              </button>
            ))}
          </div>
          <div className="quality-lock" role="note">
            <span aria-hidden="true">✓</span>
            <p><strong>真人质感保护</strong><small>节奏只改变自然停顿；长文自动衔接，保留人声的原始语速与音调。</small></p>
          </div>

          {engine === "fish" && fishHealth.status !== "ready" && fishHealth.status !== "generating" && <div className="fish-status" role="status">
            <strong>{fishHealth.status === "loading" ? "正在载入 Fish 本地模型…" : fishHealth.status === "missing" && !!fishHealth.download_total_bytes ? "正在准备高品质本地模型" : "Fish 服务尚未就绪"}</strong>
            <p>{fishHealth.error || "首次加载需要时间，模型准备好后即可试读。"}</p>
            {fishHealth.status === "missing" && !!fishHealth.download_total_bytes && <>
              <progress aria-label="Fish 模型文件准备进度" value={fishHealth.download_bytes ?? 0} max={fishHealth.download_total_bytes} />
              <small>已缓存 {((fishHealth.download_bytes ?? 0) / 1e9).toFixed(2)} / {(fishHealth.download_total_bytes / 1e9).toFixed(2)} GB · 下载完成后还需载入</small>
            </>}
            <button type="button" onClick={() => { void fishClient.load().then(() => fishClient.health()).then(setFishHealth).catch((cause) => setError(cause instanceof Error ? cause.message : "请先启动本地 Fish 服务。")); }}>重新检查 / 载入</button>
          </div>}
          {engine === "chatterbox" && modelState === "loading" && (
            <div className="model-progress" aria-live="polite">
                  <div><strong>正在载入本地模型</strong><span>{modelProgress}%</span></div>
              <progress max="100" value={modelProgress} />
              <small>{modelFile || "正在准备…"}</small>
            </div>
          )}

          {generating ? (
            <>
            <div className="generation-progress" role="status" aria-live="polite">
              <div><strong>{generationKind === "audition" ? "试读 · " : "全文 · "}{chunkProgress.total ? `已完成 ${chunkProgress.current} / ${chunkProgress.total} 段` : "正在准备音色"}</strong><span>已用 {formatDuration(generationSeconds)}</span></div>
              <progress aria-label="已完成段落" max={chunkProgress.total || 1} value={chunkProgress.current} />
              <small>{cancelling ? "正在停止，当前运算结束后生效…" : generationDetail?.phase === "decoding" ? "正在合成当前段落的声音…" : generationDetail ? `当前段落正在生成 · 已处理 ${formatDuration(generationDetail.elapsedMs / 1000)}` : chunkProgress.current === chunkProgress.total && chunkProgress.total ? "正在整理与保存完整音频…" : "长文需要一些时间，完成后可连续播放。"}</small>
            </div>
            <button className="generate-button cancel-button" type="button" disabled={cancelling} onClick={() => { cancelRequestedRef.current = true; setCancelling(true); ttsClient.cancelGeneration(); fishClient.cancel(); }}>
              <span aria-hidden="true">■</span>
              {cancelling ? "正在停止…" : "停止生成"}
            </button>
            </>
          ) : (
            <div className="generation-actions">
            <button className="audition-button" type="button" onClick={() => handleGenerate("audition")} disabled={!selectedVoice || !preparedScript.spokenText || learningVoice || preview !== null || (engine === "fish" && fishHealth.status !== "ready")}>先试读一段 <span>实际生成，不是参考录音</span></button>
            <button className="generate-button" type="button" onClick={() => handleGenerate("full")} disabled={!selectedVoice || !preparedScript.spokenText || learningVoice || preview !== null || (engine === "fish" && fishHealth.status !== "ready")}>
              <span className="generate-icon" aria-hidden="true">▶</span>
              <span><strong>生成完整语音</strong><small>{selectedVoice ? `使用 ${selectedVoice.name}` : "请先选择音色"}</small></span>
            </button>
            </div>
          )}
          <p className="model-note">{engine === "fish" ? "Built with Fish Audio · S2 Pro 本地 MLX 版 · 个人非商业使用" : "Chatterbox 完整模型 · 原生 24 kHz 输出 · 本地备用"}</p>
        </article>
      </section>

      {latest && latestUrl && (
        <section className="result-card" aria-label="最新生成结果">
          <div className="result-copy">
            <p className="eyebrow">{latest.kind === "audition" ? "试读版本" : "完整结果"} · {latest.voiceName}</p>
            <h2>{shorten(latest.text, 76)}</h2>
            <p>{formatDuration(latest.duration)} · {latest.engine === "fish" ? "Fish S2 Pro" : "Chatterbox"} · {(latest.sampleRate ?? SAMPLE_RATE) / 1000} kHz · {paceLabel(latest.pace)}节奏</p>
          </div>
          {/* The complete transcript is displayed immediately above this generated audio. */}
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <audio ref={resultPlayerRef} controls src={latestUrl} preload="metadata" onPlay={() => { if (previewControllerRef.current) { resultPlayerRef.current?.pause(); return; } setResultPlaying(true); }} onPause={() => setResultPlaying(false)} onEnded={() => setResultPlaying(false)} onError={() => setResultPlaying(false)} onEmptied={() => setResultPlaying(false)} />
          <div className="download-actions">
            <button type="button" onClick={() => exportGeneration(latest, "wav")} disabled={!!exportingId}>{exportingId === `${latest.id}-wav` ? "处理中…" : "下载 WAV"}</button>
            <button type="button" onClick={() => exportGeneration(latest, "mp3")} disabled={!!exportingId}>{exportingId === `${latest.id}-mp3` ? "处理中…" : "下载 MP3"}</button>
          </div>
        </section>
      )}

      <section className="history-section" aria-labelledby="history-title">
        <div className="history-heading">
          <div><p className="eyebrow">Local history</p><h2 id="history-title">生成历史</h2></div>
          <p>最多保留 24 条，所有音频只存在这台 Mac 的浏览器中。</p>
        </div>
        {history.length ? (
          <div className="history-list">
            {history.map((generation) => (
              <article className="history-row" key={generation.id}>
                <button className="history-play" type="button" disabled={preview !== null || resultPlaying || generating} onClick={() => previewVoice(generation.id, "生成版本", new Float32Array(generation.audio), generation.sampleRate ?? SAMPLE_RATE)} aria-label={preview?.id === generation.id ? "正在播放生成版本" : "播放生成版本"}>▶</button>
                <div className="history-text"><strong><span className="take-label">{generation.kind === "audition" ? "试读" : "全文"}</span>{shorten(generation.text, 88)}</strong><small>{generation.voiceName} · {formatDate(generation.createdAt)} · {formatDuration(generation.duration)} · {generation.engine === "fish" ? "Fish S2 Pro" : "Chatterbox"}</small></div>
                <div className="history-actions">
                  <button type="button" onClick={() => reuseGeneration(generation)} disabled={generating}>复用参数</button>
                  <button type="button" onClick={() => exportGeneration(generation, "wav")} disabled={!!exportingId}>WAV</button>
                  <button type="button" onClick={() => exportGeneration(generation, "mp3")} disabled={!!exportingId}>MP3</button>
                  <button type="button" className="delete" onClick={() => removeGeneration(generation)} aria-label="删除">×</button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-history"><span aria-hidden="true">~</span><p>生成后，音频会自动出现在这里。</p></div>
        )}
      </section>

      <footer className="studio-footer">
        <p>仅克隆你本人或已获授权的声音。请勿将生成音频用于欺骗、冒充或侵权。</p>
        <p>Built with Fish Audio · 本地 S2 Pro / Chatterbox · 不连接 Fish 云端服务</p>
      </footer>
    </main>
  );
}

function PanelHeading({ number, title, note }: { number: string; title: string; note: string }) {
  return (
    <div className="panel-heading">
      <span className="step-number">{number}</span>
      <div><h2>{title}</h2><p>{note}</p></div>
    </div>
  );
}

function voiceDisplayName(voice: SavedVoice) {
  return voice.id.startsWith("builtin-vctk-us-female-") ? voice.name.replace(/^US Female (\d+) · /, "$1 · ") : voice.name;
}

function VoiceAvatar({ voice }: { voice: SavedVoice }) {
  const number = voice.id.startsWith("builtin-vctk-us-female-") ? voice.name.match(/US Female (\d+)/)?.[1] : null;
  return <span className={`voice-avatar avatar-tone-${number ? Number(number) % 5 : 0}`} aria-hidden="true">{number ?? voice.name.slice(0, 1).toUpperCase()}</span>;
}

function RangeControl({
  label,
  value,
  min,
  max,
  step,
  output,
  disabled = false,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  output: string;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <div className="control-preview">
      <label>{label}<output>{output}</output></label>
      <input type="range" aria-label={label} min={min} max={max} step={step} value={value} disabled={disabled} onChange={(event) => onChange(Number(event.target.value))} />
    </div>
  );
}

function useAudioUrl(audio: ArrayBuffer | null, sampleRate = SAMPLE_RATE) {
  const [result, setResult] = useState<{ audio: ArrayBuffer; url: string } | null>(null);
  useEffect(() => {
    if (!audio) return;
    let active = true;
    let nextUrl = "";
    void encodeWavAsync(new Float32Array(audio), () => !active, sampleRate).then((blob) => {
      if (!active) return;
      nextUrl = URL.createObjectURL(blob);
      setResult({ audio, url: nextUrl });
    }).catch((error) => {
      if (active) console.error("Audio preview encoding failed", error);
    });
    return () => { active = false; if (nextUrl) URL.revokeObjectURL(nextUrl); };
  }, [audio, sampleRate]);
  return audio === result?.audio ? result.url : "";
}

function copyBuffer(audio: Float32Array) {
  return audio.slice().buffer as ArrayBuffer;
}

async function restoreBuiltInVoices(storedVoices: SavedVoice[]) {
  const storedIds = new Set(storedVoices.map((voice) => voice.id));
  const missingVoices = BUILT_IN_VOICES.filter((voice) => !storedIds.has(voice.id));
  if (!missingVoices.length) return storedVoices;

  const restoredVoices = await Promise.all(missingVoices.map(async (sample, index) => {
    const response = await fetch(sample.file);
    if (!response.ok) throw new Error(`Could not load ${sample.name}.`);
    const blob = await response.blob();
    const file = new File([blob], sample.file.split("/").pop() ?? `${sample.id}.mp3`, {
      type: blob.type || (sample.file.endsWith(".flac")
        ? "audio/flac"
        : sample.file.endsWith(".wav") ? "audio/wav" : "audio/mpeg"),
    });
    const audio = (await audioFileToFloat32(file)).slice(0, SAMPLE_RATE * 30);
    const voice: SavedVoice = {
      id: sample.id,
      name: sample.name,
      createdAt: 1_735_689_600_000 + index,
      duration: audio.length / SAMPLE_RATE,
      audio: copyBuffer(audio),
      source: "built-in",
    };
    await saveVoice(voice);
    return voice;
  }));

  return [...storedVoices, ...restoredVoices].sort((a, b) => b.createdAt - a.createdAt);
}

function formatDuration(seconds: number) {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const remainder = Math.floor(safe % 60);
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

function paceLabel(pace?: Generation["pace"]) {
  if (pace === "relaxed") return "舒缓";
  if (pace === "brisk") return "明快";
  return "自然";
}

function formatDate(timestamp: number) {
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(timestamp);
}

function shorten(text: string, length: number) {
  return text.length > length ? `${text.slice(0, length).trim()}…` : text;
}
