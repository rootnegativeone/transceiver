import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { QRCodeSVG } from "qrcode.react";
import { ensurePyodide } from "./lib/pyodide";
import "./App.css";

type PyodideStatus = "idle" | "loading" | "ready" | "error";
type Role = "none" | "sender" | "receiver";
type PlaybackState = "idle" | "playing" | "finished";

declare global {
  interface Window {
    __TIGHTBEAM_BUILD?: string;
  }
}

type BroadcastMetadata = {
  block_size: number;
  k: number;
  orig_len: number;
  integrity_check: boolean;
  session_id: string;
};

type BroadcastFrameMeta = {
  sequence: number;
  type: "meta";
  content: BroadcastMetadata;
  qr_value: string;
};

type SyncPayload = {
  sequence: number;
  ordinal: number;
  total: number;
  block_size: number;
  k: number;
  orig_len: number;
  integrity_check: boolean;
  session_id: string;
  confirmation_required: number;
};

type BroadcastFrameSync = {
  sequence: number;
  type: "sync";
  ordinal: number;
  total: number;
  content: SyncPayload;
  qr_value: string;
};

type BroadcastFrameSymbol = {
  sequence: number;
  type: "symbol";
  symbol_id: number;
  slot: number;
  indices: number[];
  degree: number;
  payload_hex: string;
  systematic: boolean;
  qr_value: string;
};

type BroadcastFrame =
  | BroadcastFrameMeta
  | BroadcastFrameSymbol
  | BroadcastFrameSync
  | {
      sequence: number;
      type: "symbol_pair";
      symbols: BroadcastFrameSymbol[];
    };

type SyncConfig = {
  preamble_count: number;
  interval: number;
  confirmation_required: number;
};

type BroadcastPackage = {
  seed: number;
  payload_text: string;
  metadata: BroadcastMetadata;
  frames: BroadcastFrame[];
  total_frames: number;
  systematic_count: number;
  redundant_count: number;
  sync: SyncConfig;
  payload_is_base64?: boolean;
};

type PayloadSource = "sample" | "upload" | "paste";

type MetricsSummary = {
  total_symbols: number;
  degree_hist: Record<string, number>;
  average_degree: number;
  decode_attempts: number;
  decode_success_rate: number;
  average_decode_duration: number;
  average_symbols_used: number;
  rejected_symbols: Record<string, number>;
};

type ReceiverStatus = {
  redundant: boolean;
  newly_added: boolean;
  symbols_observed: number;
  unique_symbols: number;
  coverage: number;
  decode_complete: boolean;
  recovered_text: string | null;
  metrics: MetricsSummary;
};

type CallPythonJson = (fnName: string, ...args: unknown[]) => Promise<any>;

type SenderViewProps = {
  callPythonJson: CallPythonJson;
  onBack: () => void;
};

type ReceiverViewProps = {
  callPythonJson: CallPythonJson;
  onBack: () => void;
};

type LockState = "idle" | "acquiring" | "locked";

type BarcodeDetection = {
  rawValue: string;
};

type BarcodeDetectorLike = {
  detect: (source: CanvasImageSource) => Promise<BarcodeDetection[]>;
};

type BarcodeDetectorCtor = new (options?: {
  formats?: string[];
}) => BarcodeDetectorLike;

type ZXingReader = {
  decodeFromVideoDevice: (
    deviceId: string | undefined,
    videoElement: HTMLVideoElement,
    callback: (result: { getText(): string } | null, err: unknown) => void,
  ) => Promise<void>;
  reset: () => void;
};

type ZXingNotFound = new (...args: any[]) => Error;

type FallbackStats = {
  detections: number;
  lastValue: string | null;
  luminance: number | null;
  lastDetectionAt: number | null;
  detectionIntervalMs: number | null;
};

type VideoDiagnostics = {
  width: number;
  height: number;
  aspect: number | null;
};

type ManualDecodeState = {
  status: "idle" | "pending" | "success" | "error";
  message: string | null;
};

const createFallbackStats = (): FallbackStats => ({
  detections: 0,
  lastValue: null,
  luminance: null,
  lastDetectionAt: null,
  detectionIntervalMs: null,
});

const createVideoDiagnostics = (): VideoDiagnostics => ({
  width: 0,
  height: 0,
  aspect: null,
});

const createManualDecodeState = (): ManualDecodeState => ({
  status: "idle",
  message: null,
});

const formatPercent = (value: number) => `${(value * 100).toFixed(1)}%`;

const formatBytes = (size: number) => {
  if (size < 1024) {
    return `${size} B`;
  }
  const units = ["KB", "MB", "GB"];
  let unitIndex = -1;
  let value = size;
  do {
    value /= 1024;
    unitIndex += 1;
  } while (value >= 1024 && unitIndex < units.length - 1);
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
};

const SESSION_STEPS = [
  "Idle",
  "Session Initiated",
  "Optical Transmission Active",
  "Reconstruction In Progress",
  "Verification Complete",
];

const QR_VERSION = 8;
const QR_MARGIN_MODULES = 4;
const QR_MODULE_TARGET = 7;
const QR_MODULES = 17 + 4 * QR_VERSION;
const QR_BASE_SIZE = (QR_MODULES + 2 * QR_MARGIN_MODULES) * QR_MODULE_TARGET;

const formatSessionId = (metadata: BroadcastMetadata | null) => {
  if (!metadata) {
    return "—";
  }
  if (metadata.session_id) {
    return metadata.session_id;
  }
  const seed =
    (metadata.block_size * 2654435761) ^
    (metadata.k * 1597334677) ^
    (metadata.orig_len * 3812015801) ^
    (metadata.integrity_check ? 0x9e3779b9 : 0);
  const hash = (seed >>> 0).toString(16).toUpperCase().padStart(8, "0");
  return `TB-${hash.slice(0, 8)}`;
};

const encodeTextToBase64 = (text: string) => {
  if (typeof TextEncoder === "undefined") {
    throw new Error("TextEncoder is unavailable");
  }
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
};

const measureUtf8Bytes = (text: string) => {
  if (typeof TextEncoder === "undefined") {
    throw new Error("TextEncoder is unavailable");
  }
  return new TextEncoder().encode(text).length;
};

const isDestroyable = (
  value: unknown,
): value is {
  destroy: () => void;
} => {
  return Boolean(
    value &&
      typeof value === "object" &&
      "destroy" in (value as Record<string, unknown>) &&
      typeof (value as { destroy?: unknown }).destroy === "function",
  );
};

const formatPasteLabel = (text: string) => {
  if (!text) {
    return "Pasted signed payload";
  }
  return `Pasted signed payload (${text.length.toLocaleString()} chars)`;
};

const MAX_PAYLOAD_BYTES = 512 * 1024;
const PAYLOAD_PREVIEW_LIMIT = 4096;

const describeGuidance = (
  status: ReceiverStatus | null,
  metadata: BroadcastMetadata | null,
  lockState: LockState,
  lockProgress: number,
  lockTarget: number | null,
) => {
  if (lockState !== "locked") {
    if (lockProgress <= 0) {
      return "Hold steady on the sync frames until the lock engages.";
    }
    if (lockTarget) {
      return `Locking in… ${lockProgress}/${lockTarget} sync frames captured.`;
    }
    return "Sync burst detected — keep both QRs centred to finish locking.";
  }
  if (!metadata) {
    return "Start with the metadata frame — hover over the first QR at the constrained node.";
  }
  if (!status) {
    return "Align the constrained node display inside the guide and hold steady.";
  }
  if (status.decode_complete) {
    return "Transport session complete. Reconstruction verified — integrity confirmed.";
  }
  if (status.coverage < 0.3) {
    return "Move a little closer and keep the screen centered.";
  }
  if (status.coverage < 0.65) {
    return "Great capture — hold position while the next bursts arrive.";
  }
  return "Almost there. Keep both QRs in view for the final frames.";
};

const SenderView = ({ callPythonJson, onBack }: SenderViewProps) => {
  const [isPreparing, setIsPreparing] = useState(false);
  const [broadcast, setBroadcast] = useState<BroadcastPackage | null>(null);
  const [playbackState, setPlaybackState] = useState<PlaybackState>("idle");
  const [currentFrameIndex, setCurrentFrameIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const playbackTimer = useRef<number | null>(null);
  const [autoLoop, setAutoLoop] = useState(true);
  const [qrSize, setQrSize] = useState(() =>
    typeof window !== "undefined"
      ? Math.min(window.innerWidth * 0.75, QR_BASE_SIZE)
      : QR_BASE_SIZE,
  );
  const [sizeMultiplier, setSizeMultiplier] = useState(1);
  const [useBrandPalette, setUseBrandPalette] = useState(false);
  const [payloadSource, setPayloadSource] = useState<PayloadSource>("sample");
  const [uploadFileName, setUploadFileName] = useState<string | null>(null);
  const [uploadFileSize, setUploadFileSize] = useState<number | null>(null);
  const [uploadBase64, setUploadBase64] = useState<string | null>(null);
  const [isProcessingUpload, setIsProcessingUpload] = useState(false);
  const [payloadInputError, setPayloadInputError] = useState<string | null>(
    null,
  );
  const [payloadLabel, setPayloadLabel] = useState<string>(
    "Sample signed payload",
  );
  const [pastedPayload, setPastedPayload] = useState<string>("");
  const [pastedByteLength, setPastedByteLength] = useState(0);
  const [testFrameIndex, setTestFrameIndex] = useState<number | null>(null);
  const [testCopyState, setTestCopyState] = useState<
    "idle" | "copied" | "error"
  >("idle");

  const frames = broadcast?.frames ?? [];
  const currentFrame = frames[currentFrameIndex];
  const displayFrameIndex =
    testFrameIndex !== null ? testFrameIndex : currentFrameIndex;
  const displayFrame = frames[displayFrameIndex];
  const totalFrames = broadcast?.total_frames ?? 0;
  const isTestMode = testFrameIndex !== null;
  const displaySize = Math.round(qrSize * sizeMultiplier);
  const displaySymbols = useMemo(() => {
    if (!displayFrame) {
      return [];
    }
    if (displayFrame.type === "symbol_pair") {
      return displayFrame.symbols;
    }
    if (displayFrame.type === "symbol") {
      return [displayFrame];
    }
    return [];
  }, [displayFrame]);
  const displayQrValues = useMemo(() => {
    if (!displayFrame) {
      return [];
    }
    if (displaySymbols.length) {
      return displaySymbols.map((symbol) => symbol.qr_value);
    }
    if ("qr_value" in displayFrame) {
      return [displayFrame.qr_value];
    }
    return [];
  }, [displayFrame, displayQrValues]);
  const qrColors = useMemo(
    () =>
      useBrandPalette
        ? { bg: "#07130d", fg: "#d5ffe7" }
        : { bg: "#ffffff", fg: "#000000" },
    [useBrandPalette],
  );
  const payloadPreview = useMemo(() => {
    if (!broadcast) {
      return "";
    }
    const text = broadcast.payload_text ?? "";
    const truncated =
      text.length > PAYLOAD_PREVIEW_LIMIT
        ? `${text.slice(0, PAYLOAD_PREVIEW_LIMIT)}…`
        : text;
    if (broadcast.payload_is_base64) {
      return `Base64 preview (first ${PAYLOAD_PREVIEW_LIMIT.toLocaleString()} chars)\n${truncated}`;
    }
    return truncated;
  }, [broadcast]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const updateSize = () => {
      setQrSize(Math.min(window.innerWidth * 0.75, QR_BASE_SIZE));
    };
    updateSize();
    window.addEventListener("resize", updateSize);
    return () => {
      window.removeEventListener("resize", updateSize);
    };
  }, []);

  const handleToggleLoop = useCallback(() => {
    setAutoLoop((prev) => !prev);
  }, []);

  const handleSizeChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const next = Number.parseFloat(event.target.value);
      if (!Number.isNaN(next)) {
        setSizeMultiplier(next);
      }
    },
    [],
  );

  const handleToggleBrandPalette = useCallback(() => {
    setUseBrandPalette((prev) => !prev);
  }, []);

  const handlePayloadSourceChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const value = event.target.value;
      const next: PayloadSource =
        value === "upload" ? "upload" : value === "paste" ? "paste" : "sample";
      setPayloadSource(next);
      setPayloadInputError(null);
      if (next === "sample") {
        setPayloadLabel("Sample signed payload");
        return;
      }
      if (next === "upload") {
        setPayloadLabel(uploadFileName ?? "Uploaded payload");
        return;
      }
      setPayloadLabel(formatPasteLabel(pastedPayload));
    },
    [pastedPayload, uploadFileName],
  );

  const handleUploadChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0] ?? null;
      setPayloadInputError(null);
      setUploadBase64(null);
      setUploadFileName(file ? file.name : null);
      setUploadFileSize(file ? file.size : null);
      setIsProcessingUpload(false);

      if (!file) {
        if (payloadSource === "upload") {
          setPayloadLabel("Uploaded payload");
        }
        return;
      }

      if (file.size > MAX_PAYLOAD_BYTES) {
        setPayloadInputError(
          `Payload too large for the demo (limit ${formatBytes(MAX_PAYLOAD_BYTES)}).`,
        );
        return;
      }
      setIsProcessingUpload(true);
      setPayloadLabel(file.name);

      const reader = new FileReader();
      reader.onload = () => {
        setIsProcessingUpload(false);
        const result = reader.result;
        if (typeof result !== "string") {
          setPayloadInputError("Unable to read file contents.");
          return;
        }
        const base64 = result.split(",", 2)[1];
        if (!base64) {
          setPayloadInputError("File reader returned no data.");
          return;
        }
        setUploadBase64(base64);
      };
      reader.onerror = () => {
        setIsProcessingUpload(false);
        setPayloadInputError("Unable to read selected file.");
      };
      reader.readAsDataURL(file);
    },
    [payloadSource],
  );

  const handlePasteChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const value = event.target.value;
      setPastedPayload(value);
      setPayloadInputError(null);
      let byteLength = 0;
      if (value) {
        try {
          byteLength = measureUtf8Bytes(value);
        } catch (err) {
          console.warn("Unable to measure pasted payload size", err);
          byteLength = value.length;
        }
      }
      setPastedByteLength(byteLength);
      if (payloadSource === "paste") {
        setPayloadLabel(formatPasteLabel(value));
      }
      if (byteLength > MAX_PAYLOAD_BYTES) {
        setPayloadInputError(
          `Payload too large for the demo (limit ${formatBytes(MAX_PAYLOAD_BYTES)}).`,
        );
      }
    },
    [payloadSource],
  );

  const stopPlaybackTimer = useCallback(() => {
    if (playbackTimer.current !== null) {
      window.clearInterval(playbackTimer.current);
      playbackTimer.current = null;
    }
  }, []);

  const testOptions = useMemo(() => {
    if (!broadcast) {
      return [];
    }
    const options: { index: number; label: string }[] = [];
    let firstMeta: number | null = null;
    let firstSync: number | null = null;
    let firstSystematic: number | null = null;
    let firstRedundant: number | null = null;

    broadcast.frames.forEach((frame, idx) => {
      if (frame.type === "meta" && firstMeta === null) {
        firstMeta = idx;
      } else if (frame.type === "sync" && firstSync === null) {
        firstSync = idx;
      } else if (frame.type === "symbol") {
        if (frame.systematic && firstSystematic === null) {
          firstSystematic = idx;
        }
        if (!frame.systematic && firstRedundant === null) {
          firstRedundant = idx;
        }
      } else if (frame.type === "symbol_pair") {
        const hasSystematic = frame.symbols.some((symbol) => symbol.systematic);
        const hasRedundant = frame.symbols.some((symbol) => !symbol.systematic);
        if (hasSystematic && firstSystematic === null) {
          firstSystematic = idx;
        }
        if (hasRedundant && firstRedundant === null) {
          firstRedundant = idx;
        }
      }
    });

    const pushOption = (index: number | null, label: string) => {
      if (index !== null) {
        options.push({ index, label });
      }
    };

    pushOption(firstMeta, "Metadata frame");
    pushOption(firstSync, "Sync frame");
    pushOption(firstSystematic, "Systematic symbol");
    pushOption(firstRedundant, "Redundant symbol");

    return options;
  }, [broadcast]);

  useEffect(() => {
    setTestFrameIndex(null);
    setTestCopyState("idle");
  }, [broadcast]);

  const handleTestFrameChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const value = event.target.value;
      if (value === "none") {
        setTestFrameIndex(null);
        setTestCopyState("idle");
        return;
      }
      const nextIndex = Number.parseInt(value, 10);
      if (Number.isNaN(nextIndex)) {
        return;
      }
      stopPlaybackTimer();
      setPlaybackState("idle");
      setTestFrameIndex(nextIndex);
      setCurrentFrameIndex(nextIndex);
    },
    [stopPlaybackTimer],
  );

  const handleCopyTestFrame = useCallback(async () => {
    if (!displayFrame) {
      return;
    }
    const copyValue = displayQrValues[0];
    if (!copyValue) {
      return;
    }
    try {
      await navigator.clipboard.writeText(copyValue);
      setTestCopyState("copied");
      window.setTimeout(() => setTestCopyState("idle"), 1600);
    } catch (err) {
      console.warn("Unable to copy frame QR value", err);
      setTestCopyState("error");
      window.setTimeout(() => setTestCopyState("idle"), 2000);
    }
  }, [displayFrame]);

  const handlePrepare = useCallback(async () => {
    setIsPreparing(true);
    setError(null);
    setPayloadInputError(null);
    try {
      let result: any;
      if (payloadSource === "upload") {
        if (isProcessingUpload) {
          setPayloadInputError("Still processing selected file…");
          return;
        }
        if (!uploadBase64) {
          setPayloadInputError(
            "Choose a payload file before preparing the burst.",
          );
          return;
        }
        result = await callPythonJson(
          "prepare_broadcast_from_base64",
          uploadBase64,
        );
      } else if (payloadSource === "paste") {
        if (pastedPayload.trim().length === 0) {
          setPayloadInputError(
            "Paste signed payload data before preparing the burst.",
          );
          return;
        }
        if (pastedByteLength > MAX_PAYLOAD_BYTES) {
          setPayloadInputError(
            `Payload too large for the demo (limit ${formatBytes(MAX_PAYLOAD_BYTES)}).`,
          );
          return;
        }
        let encoded = "";
        try {
          encoded = encodeTextToBase64(pastedPayload);
        } catch (err) {
          console.error(err);
          setPayloadInputError("Unable to encode pasted payload.");
          return;
        }
        result = await callPythonJson("prepare_broadcast_from_base64", encoded);
      } else {
        result = await callPythonJson("prepare_broadcast");
      }

      if (result && typeof result === "object" && "error" in result) {
        const message = (result as { error: string }).error;
        if (payloadSource === "sample") {
          setError(message);
        } else {
          setPayloadInputError(message);
        }
        return;
      }

      setBroadcast(result as BroadcastPackage);
      setPlaybackState("idle");
      setCurrentFrameIndex(0);
      setPayloadLabel(
        payloadSource === "sample"
          ? "Sample signed payload"
          : payloadSource === "upload"
            ? (uploadFileName ?? "Uploaded payload")
            : formatPasteLabel(pastedPayload),
      );
    } catch (err) {
      console.error(err);
      setError("Unable to initiate the transport session. Retry in a moment.");
    } finally {
      setIsPreparing(false);
    }
  }, [
    callPythonJson,
    payloadSource,
    isProcessingUpload,
    uploadBase64,
    uploadFileName,
    pastedPayload,
    pastedByteLength,
  ]);

  const handleStartBurst = useCallback(() => {
    if (!broadcast) {
      return;
    }
    stopPlaybackTimer();
    setTestFrameIndex(null);
    setTestCopyState("idle");
    setCurrentFrameIndex(0);
    setPlaybackState("playing");
  }, [broadcast, stopPlaybackTimer]);

  const handlePause = useCallback(() => {
    stopPlaybackTimer();
    setPlaybackState("idle");
  }, [stopPlaybackTimer]);

  useEffect(() => {
    if (!broadcast || playbackState !== "playing") {
      return;
    }
    stopPlaybackTimer();
    const framesCount = broadcast.frames.length;
    let idx = 0;
    setCurrentFrameIndex(0);

    const timer = window.setInterval(() => {
      idx += 1;
      if (idx >= framesCount) {
        if (autoLoop) {
          idx = 0;
          setCurrentFrameIndex(0);
          return;
        }
        stopPlaybackTimer();
        setPlaybackState("finished");
        return;
      }
      setCurrentFrameIndex(idx);
    }, 650);

    playbackTimer.current = timer;

    return () => {
      window.clearInterval(timer);
      playbackTimer.current = null;
    };
  }, [broadcast, playbackState, stopPlaybackTimer, autoLoop]);

  useEffect(() => () => stopPlaybackTimer(), [stopPlaybackTimer]);

  const frameLabel = useMemo(() => {
    if (!displayFrame) {
      return isTestMode ? "Select a test frame" : "Ready";
    }
    if (displayFrame.type === "sync") {
      return "Sync Frame";
    }
    if (displayFrame.type === "meta") {
      return "Metadata";
    }
    if (displayFrame.type === "symbol_pair") {
      const hasSystematic = displayFrame.symbols.some(
        (symbol) => symbol.systematic,
      );
      const hasRedundant = displayFrame.symbols.some(
        (symbol) => !symbol.systematic,
      );
      if (hasSystematic && !hasRedundant) {
        return "Systematic Pair";
      }
      if (!hasSystematic && hasRedundant) {
        return "Redundant Pair";
      }
      return "Symbol Pair";
    }
    return displayFrame.systematic ? "Systematic Frame" : "Redundant Frame";
  }, [displayFrame, isTestMode]);
  const senderSessionStep = useMemo(() => {
    if (!broadcast) {
      return 0;
    }
    if (playbackState === "playing") {
      return 2;
    }
    if (playbackState === "finished") {
      return 3;
    }
    return 1;
  }, [broadcast, playbackState]);
  const senderSessionId = useMemo(
    () => formatSessionId(broadcast?.metadata ?? null),
    [broadcast],
  );
  const senderPayloadSize = broadcast
    ? formatBytes(broadcast.metadata.orig_len)
    : "—";
  const senderIntegrityStatus = broadcast
    ? "Signed Payload · Reconstruction Verification Pending"
    : "Signed Payload · Awaiting Session";

  return (
    <section className="panel">
      <div className="panel-header">
        <h2>Constrained Node Console</h2>
        <div className="panel-actions">
          <button className="link" onClick={onBack}>
            Switch Role
          </button>
        </div>
      </div>
      <div className="panel-body">
        <div className="session-summary">
          <div className="session-summary-header">Transport Session</div>
          <div className="session-summary-grid">
            <div>
              <span className="summary-label">Session ID</span>
              <span className="summary-value">{senderSessionId}</span>
            </div>
            <div>
              <span className="summary-label">Payload Size</span>
              <span className="summary-value">{senderPayloadSize}</span>
            </div>
            <div className="summary-wide">
              <span className="summary-label">Integrity Status</span>
              <span className="summary-value">{senderIntegrityStatus}</span>
            </div>
          </div>
          <div className="session-state">
            <div className="session-state-label">Transport Session State</div>
            <ol className="session-state-steps">
              {SESSION_STEPS.map((step, index) => (
                <li
                  key={step}
                  className={[
                    index === senderSessionStep ? "is-active" : "",
                    index < senderSessionStep ? "is-complete" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  {step}
                </li>
              ))}
            </ol>
          </div>
        </div>
        <div className="sender-grid">
          <div className="qr-stage">
            {displayFrame ? (
              <div
                className={
                  displayQrValues.length > 1 ? "qr-stack" : "qr-single"
                }
              >
                {displayQrValues.map((value, idx) => (
                  <div className="qr-tile" key={`${displayFrameIndex}-${idx}`}>
                    <QRCodeSVG
                      value={value}
                      size={displaySize}
                      bgColor={qrColors.bg}
                      fgColor={qrColors.fg}
                      includeMargin
                      marginSize={QR_MARGIN_MODULES}
                      level="M"
                      version={QR_VERSION}
                    />
                    {displayQrValues.length > 1 && (
                      <div className="qr-slot-label">
                        {idx === 0 ? "Slot A" : "Slot B"}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="placeholder">
                {isTestMode ? "Choose a test frame" : "Initiate session"}
              </div>
            )}
            <div className="frame-meta">
              <div>
                {displayFrame
                  ? `Frame ${displayFrameIndex + 1} of ${totalFrames}`
                  : isTestMode
                    ? "Test frame not selected"
                    : "Idle"}
              </div>
              <div>
                {frameLabel}
                {isTestMode && displayFrame ? " · Test mode" : ""}
              </div>
              {displayFrame?.type === "sync" && (
                <div>
                  Sync {displayFrame.ordinal}/{displayFrame.total}
                </div>
              )}
              {displayFrame?.type === "symbol" && (
                <div>
                  d{displayFrame.degree} · {displayFrame.indices.join(", ")}
                </div>
              )}
              {displayFrame?.type === "symbol_pair" && (
                <div>
                  {displayFrame.symbols
                    .map((symbol) => `d${symbol.degree}`)
                    .join(" · ")}
                </div>
              )}
              {displayFrame?.type === "meta" && broadcast && (
                <div>
                  Block {broadcast.metadata.block_size} · k=
                  {broadcast.metadata.k}
                </div>
              )}
            </div>
          </div>

          <div className="sender-controls">
            <div className="control-strip">
              <button
                className="action"
                onClick={handlePrepare}
                disabled={
                  isPreparing ||
                  (payloadSource === "upload" &&
                    (isProcessingUpload || !uploadBase64)) ||
                  (payloadSource === "paste" &&
                    (pastedPayload.trim().length === 0 ||
                      pastedByteLength > MAX_PAYLOAD_BYTES))
                }
              >
                {isPreparing ? "Preparing…" : "Initiate Transport Session"}
              </button>
              <button
                className="action secondary"
                onClick={
                  playbackState === "playing" ? handlePause : handleStartBurst
                }
                disabled={!broadcast}
              >
                {playbackState === "playing"
                  ? "Pause"
                  : playbackState === "finished"
                    ? "Replay"
                    : "Begin Optical Transmission"}
              </button>
            </div>

            <div className="payload-source">
              <h3>Signed Payload Source</h3>
              <div className="payload-options">
                <label className="radio-option">
                  <input
                    type="radio"
                    value="sample"
                    checked={payloadSource === "sample"}
                    onChange={handlePayloadSourceChange}
                  />
                  <span>Sample signed payload</span>
                </label>
                <label className="radio-option">
                  <input
                    type="radio"
                    value="upload"
                    checked={payloadSource === "upload"}
                    onChange={handlePayloadSourceChange}
                  />
                  <span>Upload payload</span>
                </label>
                <label className="radio-option">
                  <input
                    type="radio"
                    value="paste"
                    checked={payloadSource === "paste"}
                    onChange={handlePayloadSourceChange}
                  />
                  <span>Paste payload</span>
                </label>
              </div>
              {payloadSource === "upload" && (
                <div className="file-picker">
                  <input
                    type="file"
                    onChange={handleUploadChange}
                    aria-label="Choose payload file"
                  />
                  <div className="file-summary">
                    {uploadFileName ? (
                      <>
                        <span>{uploadFileName}</span>
                        {uploadFileSize !== null && (
                          <span className="file-size">
                            {formatBytes(uploadFileSize)}
                          </span>
                        )}
                      </>
                    ) : (
                      <span>Select a payload file to transmit</span>
                    )}
                    {isProcessingUpload && (
                      <span className="file-status">Loading…</span>
                    )}
                  </div>
                  <div className="payload-limit">
                    Demo limit {formatBytes(MAX_PAYLOAD_BYTES)} per burst.
                  </div>
                  {payloadInputError && (
                    <div className="error-text">{payloadInputError}</div>
                  )}
                </div>
              )}
              {payloadSource === "paste" && (
                <div className="paste-input">
                  <textarea
                    value={pastedPayload}
                    onChange={handlePasteChange}
                    placeholder="Paste signed payload JSON here…"
                    rows={8}
                  />
                  <div className="paste-meta">
                    <span>{pastedPayload.length.toLocaleString()} chars</span>
                    <span>
                      {formatBytes(pastedByteLength)} /{" "}
                      {formatBytes(MAX_PAYLOAD_BYTES)}
                    </span>
                  </div>
                  {payloadInputError && (
                    <div className="error-text">{payloadInputError}</div>
                  )}
                  <div className="paste-hint">
                    Encoded as UTF-8 prior to transport · limit{" "}
                    {formatBytes(MAX_PAYLOAD_BYTES)}.
                  </div>
                </div>
              )}
            </div>

            {broadcast && (
              <>
                <div className="stats">
                  <h3>Session Metrics</h3>
                  <ul>
                    <li>
                      Signed payload source: {payloadLabel}
                      {payloadSource === "upload" && uploadFileSize !== null
                        ? ` (${formatBytes(uploadFileSize)})`
                        : ""}
                    </li>
                    <li>
                      Frames: {broadcast.total_frames} (
                      {broadcast.systematic_count} systematic +{" "}
                      {broadcast.redundant_count} redundant)
                    </li>
                    <li>Block size: {broadcast.metadata.block_size} bytes</li>
                    <li>Source blocks (k): {broadcast.metadata.k}</li>
                    <li>Payload length: {broadcast.metadata.orig_len} bytes</li>
                    <li>
                      Preview mode:{" "}
                      {broadcast.payload_is_base64
                        ? "Binary (base64 preview)"
                        : "UTF-8 text"}
                    </li>
                    <li>
                      Sync preamble: {broadcast.sync.preamble_count} frames ·
                      reinserts every {broadcast.sync.interval} frames
                    </li>
                  </ul>
                  <label className="loop-toggle">
                    <input
                      type="checkbox"
                      checked={autoLoop}
                      onChange={handleToggleLoop}
                    />
                    Auto loop bursts
                  </label>
                  <label className="size-control">
                    <span>QR size boost</span>
                    <input
                      type="range"
                      min="1"
                      max="1.4"
                      step="0.05"
                      value={sizeMultiplier}
                      onChange={handleSizeChange}
                    />
                    <span>{Math.round(sizeMultiplier * 100)}%</span>
                  </label>
                  <label className="brand-toggle">
                    <input
                      type="checkbox"
                      checked={useBrandPalette}
                      onChange={handleToggleBrandPalette}
                    />
                    Use accent palette
                  </label>
                  <details>
                    <summary>Payload preview</summary>
                    <pre>{payloadPreview || "(payload empty)"}</pre>
                  </details>
                </div>

                <div className="test-mode">
                  <h3>Single-frame Test</h3>
                  <p>
                    Pin one frame so the receiver can test manual snapshots
                    without worrying about burst cadence.
                  </p>
                  <div className="test-controls">
                    <label>
                      <span>Display frame</span>
                      <select
                        value={
                          testFrameIndex !== null
                            ? String(testFrameIndex)
                            : "none"
                        }
                        onChange={handleTestFrameChange}
                      >
                        <option value="none">Live playback</option>
                        {testOptions.map(({ index, label }) => (
                          <option key={index} value={String(index)}>
                            {label} · #{index + 1}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      className="link"
                      onClick={handleCopyTestFrame}
                      disabled={!displayFrame}
                    >
                      {testCopyState === "copied"
                        ? "Copied!"
                        : testCopyState === "error"
                          ? "Copy failed"
                          : "Copy QR text"}
                    </button>
                  </div>
                  {isTestMode && displayFrame && (
                    <div className="test-frame-preview">
                      <div className="test-frame-label">
                        Pinned value (frame #{displayFrameIndex + 1})
                      </div>
                      {displayQrValues.map((value, idx) => (
                        <pre key={`${displayFrameIndex}-${idx}`}>{value}</pre>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}

            {error && <div className="error-text">{error}</div>}
          </div>
        </div>
      </div>
    </section>
  );
};

const ReceiverView = ({ callPythonJson, onBack }: ReceiverViewProps) => {
  const [metadata, setMetadata] = useState<BroadcastMetadata | null>(null);
  const [status, setStatus] = useState<ReceiverStatus | null>(null);
  const [guidance, setGuidance] = useState<string>(
    "Ask the constrained node to initiate the transport session, then scan the first QR.",
  );
  const [cameraState, setCameraState] = useState<
    "idle" | "starting" | "running" | "error"
  >("idle");
  const [activeCamera, setActiveCamera] = useState<"environment" | "user">(
    "environment",
  );
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [cameraErrorDetails, setCameraErrorDetails] = useState<string | null>(
    null,
  );
  const [scannerSupported, setScannerSupported] = useState<boolean | null>(
    null,
  );
  const [lastFrame, setLastFrame] = useState<string | null>(null);
  const [recoveredPayload, setRecoveredPayload] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
    "idle",
  );
  const [lockState, setLockState] = useState<LockState>("idle");
  const [lockProgress, setLockProgress] = useState(0);
  const [lockTarget, setLockTarget] = useState<number | null>(null);
  const [stoppedAfterCompletion, setStoppedAfterCompletion] = useState(false);
  const [captureMode, setCaptureMode] = useState<"native" | "fallback">(
    "native",
  );
  const [fallbackStats, setFallbackStats] = useState<FallbackStats>(() =>
    createFallbackStats(),
  );
  const [videoDiagnostics, setVideoDiagnostics] = useState<VideoDiagnostics>(
    () => createVideoDiagnostics(),
  );
  const [manualDecodeStatus, setManualDecodeStatus] =
    useState<ManualDecodeState>(createManualDecodeState);
  const [, forceDiagnosticUpdate] = useState(0);
  const lastValueRef = useRef<string | null>(null);
  const animationRef = useRef<number | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const sampleCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const manualCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const detectorRef = useRef<BarcodeDetectorLike | null>(null);
  const fallbackReaderRef = useRef<ZXingReader | null>(null);
  const fallbackNotFoundRef = useRef<ZXingNotFound | null>(null);
  const fallbackDecodeCancelRef = useRef<(() => void) | null>(null);
  const lockStateRef = useRef<LockState>("idle");
  const lockProgressRef = useRef(0);
  const metadataRef = useRef<BroadcastMetadata | null>(null);
  const sessionInitializedRef = useRef(false);
  const pendingMetadataRef = useRef<BroadcastMetadata | null>(null);
  const syncSequencesRef = useRef<Set<number>>(new Set());
  const lastSymbolTimestampRef = useRef<number | null>(null);
  const updateVideoDiagnostics = useCallback(() => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) {
      return;
    }
    const aspect =
      video.videoHeight > 0
        ? Math.round((video.videoWidth / video.videoHeight) * 1000) / 1000
        : null;
    setVideoDiagnostics({
      width: video.videoWidth,
      height: video.videoHeight,
      aspect,
    });
  }, []);
  const computeLuminance = useCallback(() => {
    const video = videoRef.current;
    const canvas = sampleCanvasRef.current;
    if (!video || !canvas || !video.videoWidth || !video.videoHeight) {
      return null;
    }

    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      return null;
    }

    const sampleWidth = 64;
    const sampleHeight = Math.max(
      1,
      Math.round((video.videoHeight / video.videoWidth) * sampleWidth),
    );

    canvas.width = sampleWidth;
    canvas.height = sampleHeight;
    ctx.drawImage(video, 0, 0, sampleWidth, sampleHeight);

    const { data } = ctx.getImageData(0, 0, sampleWidth, sampleHeight);
    const pixels = data.length / 4;
    if (!pixels) {
      return null;
    }

    let sum = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      sum += 0.299 * r + 0.587 * g + 0.114 * b;
    }

    return sum / pixels;
  }, []);

  const ensureFallbackReader = useCallback(async () => {
    try {
      if (!fallbackReaderRef.current) {
        const module = await import("@zxing/browser");
        fallbackReaderRef.current = new module.BrowserQRCodeReader();
        fallbackNotFoundRef.current = module.NotFoundException;
      }
      return true;
    } catch (err) {
      console.error("ZXing fallback unavailable", err);
      return false;
    }
  }, []);

  useEffect(() => {
    const Detector = (
      window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }
    ).BarcodeDetector;
    if (Detector) {
      detectorRef.current = new Detector({ formats: ["qr_code"] });
      setScannerSupported(true);
    } else {
      detectorRef.current = null;
      ensureFallbackReader().then((ready) => setScannerSupported(ready));
    }
  }, [ensureFallbackReader]);

  useEffect(() => {
    lockStateRef.current = lockState;
  }, [lockState]);

  useEffect(() => {
    lockProgressRef.current = lockProgress;
  }, [lockProgress]);

  useEffect(() => {
    metadataRef.current = metadata;
  }, [metadata]);

  useEffect(() => {
    setGuidance(
      describeGuidance(status, metadata, lockState, lockProgress, lockTarget),
    );
  }, [status, metadata, lockState, lockProgress, lockTarget]);

  useEffect(() => {
    if (cameraState !== "running") {
      return;
    }
    const handleResize = () => updateVideoDiagnostics();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [cameraState, updateVideoDiagnostics]);

  useEffect(() => {
    if (cameraState !== "running") {
      return;
    }
    const timer = window.setInterval(() => {
      forceDiagnosticUpdate((prev) => (prev + 1) % Number.MAX_SAFE_INTEGER);
      updateVideoDiagnostics();
    }, 750);
    return () => window.clearInterval(timer);
  }, [cameraState, forceDiagnosticUpdate, updateVideoDiagnostics]);

  const stopCamera = useCallback(
    (options: { preservePayload?: boolean } = {}) => {
      const { preservePayload = false } = options;
      if (animationRef.current !== null) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
      if (fallbackDecodeCancelRef.current) {
        try {
          fallbackDecodeCancelRef.current();
        } catch (err) {
          console.warn("Fallback reader cancel failed", err);
        }
        fallbackDecodeCancelRef.current = null;
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
      syncSequencesRef.current.clear();
      pendingMetadataRef.current = null;
      setLockState("idle");
      setLockProgress(0);
      lockProgressRef.current = 0;
      setLockTarget(null);
      lastSymbolTimestampRef.current = null;
      if (!preservePayload) {
        setRecoveredPayload(null);
        setCopyState("idle");
      }
      setStoppedAfterCompletion(false);
      setCaptureMode("native");
      setFallbackStats(createFallbackStats());
      setVideoDiagnostics(createVideoDiagnostics());
      setManualDecodeStatus(createManualDecodeState());
      sessionInitializedRef.current = false;
      metadataRef.current = null;
      setMetadata(null);
      setStatus(null);
      setCameraErrorDetails(null);
      setCameraState("idle");
    },
    [],
  );

  useEffect(() => () => stopCamera(), [stopCamera]);

  useEffect(() => {
    if (status?.decode_complete && status.recovered_text) {
      setRecoveredPayload(status.recovered_text);
      setCopyState("idle");
    }
  }, [status]);

  const requestResync = useCallback(() => {
    if (lockStateRef.current !== "locked") {
      return;
    }
    syncSequencesRef.current.clear();
    setLockState("acquiring");
    setLockProgress(0);
    lockProgressRef.current = 0;
    setLockTarget(null);
    lastSymbolTimestampRef.current = null;
    pendingMetadataRef.current = null;
  }, []);

  const handleMetadata = useCallback(
    async (meta: BroadcastMetadata) => {
      const current = metadataRef.current;
      const metadataChanged =
        !current ||
        current.block_size !== meta.block_size ||
        current.k !== meta.k ||
        current.orig_len !== meta.orig_len ||
        current.integrity_check !== meta.integrity_check ||
        current.session_id !== meta.session_id;

      if (!metadataChanged && sessionInitializedRef.current) {
        setMetadata(meta);
        metadataRef.current = meta;
        lastSymbolTimestampRef.current = Date.now();
        return;
      }

      const result = await callPythonJson(
        "reset_receiver",
        meta.block_size,
        meta.k,
        meta.orig_len,
        meta.integrity_check,
      );
      if (result.error) {
        throw new Error(result.error);
      }

      sessionInitializedRef.current = true;
      setMetadata(meta);
      metadataRef.current = meta;
      setStatus(null);
      lastSymbolTimestampRef.current = Date.now();
    },
    [callPythonJson],
  );

  const handleSync = useCallback(
    async (payload: SyncPayload) => {
      const required = payload.confirmation_required;
      setLockTarget((current) => current ?? required);

      if (lockStateRef.current === "idle") {
        setLockState("acquiring");
      }

      if (!syncSequencesRef.current.has(payload.sequence)) {
        syncSequencesRef.current.add(payload.sequence);
        setLockProgress((prev) => {
          const next = Math.min(prev + 1, required);
          lockProgressRef.current = next;
          return next;
        });
      }

      pendingMetadataRef.current = {
        block_size: payload.block_size,
        k: payload.k,
        orig_len: payload.orig_len,
        integrity_check: payload.integrity_check,
        session_id: payload.session_id,
      };

      if (
        syncSequencesRef.current.size >= required &&
        lockStateRef.current !== "locked"
      ) {
        setLockState("locked");
        setLockProgress(required);
        lockProgressRef.current = required;
        const meta = pendingMetadataRef.current;
        pendingMetadataRef.current = null;
        if (meta) {
          await handleMetadata(meta);
        }
      }
    },
    [handleMetadata],
  );

  useEffect(() => {
    if (cameraState !== "running") {
      return;
    }
    const timer = window.setInterval(() => {
      const lastSymbol = lastSymbolTimestampRef.current;
      if (lastSymbol === null) {
        return;
      }
      if (Date.now() - lastSymbol > 4500 && lockStateRef.current === "locked") {
        requestResync();
      }
    }, 400);
    return () => window.clearInterval(timer);
  }, [cameraState, requestResync]);

  const handleSymbol = useCallback(
    async (symbolId: number, indices: number[], payloadHex: string) => {
      const result = await callPythonJson(
        "receiver_add_symbol",
        symbolId,
        indices,
        payloadHex,
      );
      if (result.error) {
        throw new Error(result.error);
      }
      setStatus(result as ReceiverStatus);
      lastSymbolTimestampRef.current = Date.now();
    },
    [callPythonJson],
  );

  const processValue = useCallback(
    async (value: string) => {
      if (value === lastValueRef.current) {
        return;
      }
      lastValueRef.current = value;
      setLastFrame(value);

      if (value.startsWith("Y:")) {
        try {
          const payload = JSON.parse(value.slice(2)) as SyncPayload;
          await handleSync(payload);
        } catch (err) {
          console.warn("Unable to parse sync payload", err);
        }
        return;
      }

      if (value.startsWith("M:")) {
        const payload = value.slice(2);
        const meta = JSON.parse(payload) as BroadcastMetadata;
        pendingMetadataRef.current = meta;
        await handleMetadata(meta);
        return;
      }

      const allowSymbols =
        metadataRef.current &&
        (lockStateRef.current === "locked" ||
          (lockStateRef.current === "acquiring" &&
            lockProgressRef.current > 0));

      const isS2 = value.startsWith("S2:");
      const isS1 = value.startsWith("S:");
      if ((!isS2 && !isS1) || !allowSymbols) {
        return;
      }
      if (isS2) {
        const remainder = value.slice(3);
        const [
          sessionPart,
          sequencePart,
          slotPart,
          symbolIdPart,
          indicesPart,
          payloadHex,
        ] = remainder.split("|", 6);
        if (
          !sessionPart ||
          !sequencePart ||
          !slotPart ||
          !symbolIdPart ||
          !indicesPart ||
          !payloadHex
        ) {
          return;
        }
        if (
          metadataRef.current?.session_id &&
          metadataRef.current.session_id !== sessionPart
        ) {
          return;
        }
        const symbolId = Number.parseInt(symbolIdPart, 10);
        if (Number.isNaN(symbolId)) {
          return;
        }
        const indices = indicesPart
          .split(",")
          .filter(Boolean)
          .map((item) => Number.parseInt(item, 10))
          .filter((item) => !Number.isNaN(item));
        if (!indices.length) {
          return;
        }
        await handleSymbol(symbolId, indices, payloadHex);
        return;
      }

      const remainder = value.slice(2);
      const [sequencePart, indicesPart, payloadHex] = remainder.split("|", 3);
      if (!sequencePart || !indicesPart || !payloadHex) {
        return;
      }
      const symbolId = Number.parseInt(sequencePart, 10);
      if (Number.isNaN(symbolId)) {
        return;
      }
      const indices = indicesPart
        .split(",")
        .filter(Boolean)
        .map((item) => Number.parseInt(item, 10))
        .filter((item) => !Number.isNaN(item));
      if (!indices.length) {
        return;
      }
      await handleSymbol(symbolId, indices, payloadHex);
    },
    [handleMetadata, handleSymbol, handleSync],
  );

  const scanLoop = useCallback(async () => {
    if (!detectorRef.current || !videoRef.current) {
      return;
    }
    try {
      const detections = await detectorRef.current.detect(videoRef.current);
      if (detections.length > 0) {
        for (const detection of detections) {
          const { rawValue } = detection;
          if (rawValue) {
            await processValue(rawValue);
          }
        }
      }
    } catch (err) {
      console.warn("Barcode detection failed; retrying", err);
    }
    animationRef.current = requestAnimationFrame(scanLoop);
  }, [processValue]);

  const handleManualDecode = useCallback(async () => {
    if (cameraState !== "running") {
      setManualDecodeStatus({
        status: "error",
        message: "Camera is not active — start receiving first.",
      });
      return;
    }
    const video = videoRef.current;
    const canvas = manualCanvasRef.current;
    if (!video || !canvas || !video.videoWidth || !video.videoHeight) {
      setManualDecodeStatus({
        status: "error",
        message: "Video frame unavailable for capture.",
      });
      return;
    }
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      setManualDecodeStatus({
        status: "error",
        message: "Snapshot canvas is unavailable.",
      });
      return;
    }

    const captureWidth = Math.min(960, video.videoWidth);
    const captureHeight = Math.max(
      1,
      Math.round((video.videoHeight / video.videoWidth) * captureWidth),
    );
    canvas.width = captureWidth;
    canvas.height = captureHeight;
    ctx.drawImage(video, 0, 0, captureWidth, captureHeight);

    setManualDecodeStatus({
      status: "pending",
      message: "Decoding snapshot…",
    });

    try {
      if (detectorRef.current && captureMode !== "fallback") {
        const detections = await detectorRef.current.detect(canvas);
        if (detections.length > 0) {
          let handled = false;
          for (const detection of detections) {
            if (detection.rawValue) {
              await processValue(detection.rawValue);
              handled = true;
            }
          }
          if (handled) {
            setManualDecodeStatus({
              status: "success",
              message: "Snapshot decoded successfully.",
            });
            return;
          }
        }
        setManualDecodeStatus({
          status: "error",
          message: "No QR code found — adjust alignment and retry.",
        });
        return;
      }

      const module = await import("@zxing/browser");
      const reader = new module.BrowserQRCodeReader();
      try {
        const result = await reader.decodeFromCanvas(canvas);
        const text =
          typeof result.getText === "function"
            ? result.getText()
            : ((result as unknown as { text?: string }).text ?? null);
        if (text) {
          await processValue(text);
          setManualDecodeStatus({
            status: "success",
            message: "Snapshot decoded successfully.",
          });
        } else {
          setManualDecodeStatus({
            status: "error",
            message: "No QR code found — adjust alignment and retry.",
          });
        }
      } catch (err) {
        if (
          module.NotFoundException &&
          err instanceof module.NotFoundException
        ) {
          setManualDecodeStatus({
            status: "error",
            message: "No QR code found — adjust alignment and retry.",
          });
        } else {
          console.error("Manual decode failed", err);
          setManualDecodeStatus({
            status: "error",
            message:
              err instanceof Error ? err.message : "Manual decode failed.",
          });
        }
      } finally {
        try {
          reader.reset();
        } catch (resetErr) {
          console.warn("Manual decode reader reset issue", resetErr);
        }
      }
    } catch (err) {
      console.error("Manual decode error", err);
      setManualDecodeStatus({
        status: "error",
        message: err instanceof Error ? err.message : "Manual decode failed.",
      });
    }
  }, [cameraState, captureMode, processValue]);

  const startCamera = useCallback(async () => {
    setCameraError(null);
    setCameraErrorDetails(null);
    setFallbackStats(createFallbackStats());
    setVideoDiagnostics(createVideoDiagnostics());
    setManualDecodeStatus(createManualDecodeState());
    setCaptureMode("native");
    if (scannerSupported === false) {
      setCameraError("QR detection unavailable in this browser.");
      return;
    }
    try {
      setCameraState("starting");
      lastValueRef.current = null;
      setMetadata(null);
      setStatus(null);
      setRecoveredPayload(null);
      setCopyState("idle");
      syncSequencesRef.current.clear();
      pendingMetadataRef.current = null;
      setLockState("idle");
      setLockProgress(0);
      setLockTarget(null);
      lastSymbolTimestampRef.current = null;
      setCaptureMode("native");
      setFallbackStats(createFallbackStats());

      const preferEnvironment = activeCamera === "environment";
      const getConstraints = (mode: "environment" | "user") => ({
        video: {
          facingMode: { ideal: mode },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });

      let stream: MediaStream | null = null;
      let modeUsed: "environment" | "user" = activeCamera;
      try {
        stream = await navigator.mediaDevices.getUserMedia(
          getConstraints(activeCamera),
        );
      } catch (err) {
        if (preferEnvironment) {
          console.warn(
            "Environment camera unavailable, trying user-facing.",
            err,
          );
          try {
            stream = await navigator.mediaDevices.getUserMedia(
              getConstraints("user"),
            );
            modeUsed = "user";
          } catch (fallbackErr) {
            throw fallbackErr;
          }
        } else {
          throw err;
        }
      }
      if (!stream) {
        throw new Error("Unable to access camera stream");
      }
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) {
        throw new Error("Video element unavailable");
      }
      video.srcObject = stream;
      await video.play();
      updateVideoDiagnostics();
      window.setTimeout(() => updateVideoDiagnostics(), 250);
      setActiveCamera(modeUsed);

      const shouldUseFallback = !detectorRef.current;
      if (shouldUseFallback) {
        const ready = await ensureFallbackReader();
        if (!ready || !fallbackReaderRef.current) {
          throw new Error("Fallback scanner unavailable");
        }
        const reader = fallbackReaderRef.current;
        fallbackDecodeCancelRef.current = () => {
          try {
            reader.reset();
          } catch (err) {
            console.warn("Fallback reader reset issue", err);
          }
        };
        const continuousReader = reader as {
          decodeFromVideoElementContinuously?: (
            element: HTMLVideoElement,
            callback: (
              result: { getText(): string } | null,
              error: unknown,
            ) => Promise<void>,
          ) => void;
        };
        const fallbackCallback = async (
          result: { getText(): string } | null,
          err: unknown,
        ) => {
          if (result) {
            const text = result.getText();
            if (text) {
              const luminance = computeLuminance();
              const sampleTime = Date.now();
              setFallbackStats((prev) => {
                const interval =
                  prev.lastDetectionAt !== null
                    ? sampleTime - prev.lastDetectionAt
                    : null;
                const averaged =
                  interval !== null && prev.detectionIntervalMs !== null
                    ? prev.detectionIntervalMs * 0.7 + interval * 0.3
                    : interval;
                return {
                  detections: prev.detections + 1,
                  lastValue: text,
                  luminance,
                  lastDetectionAt: sampleTime,
                  detectionIntervalMs: averaged ?? null,
                };
              });
              await processValue(text);
            }
            return;
          }
          if (
            err &&
            fallbackNotFoundRef.current &&
            err instanceof fallbackNotFoundRef.current
          ) {
            return;
          }
          if (err) {
            console.warn("Fallback scanner error", err);
          }
        };

        setCaptureMode("fallback");
        if (continuousReader.decodeFromVideoElementContinuously) {
          continuousReader.decodeFromVideoElementContinuously(
            video,
            fallbackCallback,
          );
        } else {
          reader.decodeFromVideoDevice(undefined, video, fallbackCallback);
        }
      } else {
        animationRef.current = requestAnimationFrame(scanLoop);
      }
      setCameraState("running");
    } catch (err) {
      console.error(err);
      setCameraState("error");
      const message =
        err instanceof Error
          ? err.message
          : "Camera permission denied or unavailable.";
      setCameraError("Camera unavailable");
      setCameraErrorDetails(message);
    }
  }, [
    activeCamera,
    ensureFallbackReader,
    processValue,
    scanLoop,
    scannerSupported,
    updateVideoDiagnostics,
  ]);

  const coveragePercent = status ? formatPercent(status.coverage) : "0.0%";
  const overlayMessage =
    cameraState === "starting"
      ? "Starting camera…"
      : cameraState === "running"
        ? lockState === "locked"
          ? !metadata
            ? "Waiting for metadata frame to sync."
            : status?.decode_complete
              ? "Reconstruction verified — integrity confirmed."
              : "Keep the burst inside the guide."
          : lockState === "acquiring"
            ? lockTarget
              ? `Locking… ${lockProgress}/${lockTarget}`
              : "Locking onto sync burst…"
            : "Find the sync frames to begin locking."
        : "Select Begin Reconstruction to activate the camera.";
  const lockDescriptor =
    lockState === "locked"
      ? "Lock engaged"
      : lockState === "acquiring"
        ? lockTarget
          ? `Locking ${lockProgress}/${lockTarget}`
          : "Locking…"
        : "Lock idle";
  const videoResolutionLabel =
    videoDiagnostics.width && videoDiagnostics.height
      ? `${videoDiagnostics.width}×${videoDiagnostics.height}`
      : "—";
  const aspectLabel =
    videoDiagnostics.aspect !== null
      ? `AR ${videoDiagnostics.aspect.toFixed(3).replace(/\.?0+$/, "")}:1`
      : null;
  const detectionCadenceLabel =
    fallbackStats.detectionIntervalMs && fallbackStats.detectionIntervalMs > 0
      ? `${(1000 / fallbackStats.detectionIntervalMs).toFixed(2)} Hz`
      : null;
  const detectionIntervalLabel =
    fallbackStats.detectionIntervalMs !== null
      ? `${Math.round(fallbackStats.detectionIntervalMs)} ms`
      : null;
  const detectionAgeSeconds =
    fallbackStats.lastDetectionAt !== null
      ? (Date.now() - fallbackStats.lastDetectionAt) / 1000
      : null;
  const detectionAgeLabel =
    detectionAgeSeconds !== null
      ? `${
          detectionAgeSeconds >= 10
            ? Math.round(detectionAgeSeconds)
            : detectionAgeSeconds.toFixed(1)
        } s`
      : null;
  const luminanceLabel =
    fallbackStats.luminance !== null
      ? Math.round(fallbackStats.luminance).toString()
      : null;
  const handleCopyPayload = useCallback(async () => {
    if (!recoveredPayload) {
      return;
    }
    try {
      await navigator.clipboard.writeText(recoveredPayload);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1600);
    } catch (err) {
      console.warn("Clipboard unavailable", err);
      setCopyState("error");
      window.setTimeout(() => setCopyState("idle"), 2000);
    }
  }, [recoveredPayload]);
  const reticleClassName = [
    "capture-reticle",
    cameraState !== "running" ? "is-inactive" : "",
    lockState === "locked" ? "is-locked" : "",
    status?.decode_complete ? "is-complete" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const receiverSessionStep = useMemo(() => {
    if (status?.decode_complete) {
      return 4;
    }
    if (status || metadata || lockState === "locked") {
      return 3;
    }
    if (cameraState === "running" || lockState === "acquiring") {
      return 2;
    }
    if (cameraState === "starting") {
      return 1;
    }
    return 0;
  }, [cameraState, lockState, metadata, status]);
  const receiverSessionId = useMemo(
    () => formatSessionId(metadata),
    [metadata],
  );
  const receiverPayloadSize = metadata ? formatBytes(metadata.orig_len) : "—";
  const receiverIntegrityStatus = status?.decode_complete
    ? "Reconstruction Verified — Integrity Confirmed"
    : "Signed Payload · Reconstruction Verification Pending";

  return (
    <section className="panel">
      <div className="panel-header">
        <h2>Reconstruction Console</h2>
        <div className="panel-actions">
          <button className="link" onClick={onBack}>
            Switch Role
          </button>
        </div>
      </div>
      <div className="panel-body">
        <div className="session-summary">
          <div className="session-summary-header">Transport Session</div>
          <div className="session-summary-grid">
            <div>
              <span className="summary-label">Session ID</span>
              <span className="summary-value">{receiverSessionId}</span>
            </div>
            <div>
              <span className="summary-label">Payload Size</span>
              <span className="summary-value">{receiverPayloadSize}</span>
            </div>
            <div className="summary-wide">
              <span className="summary-label">Integrity Status</span>
              <span className="summary-value">{receiverIntegrityStatus}</span>
            </div>
          </div>
          <div className="session-state">
            <div className="session-state-label">Transport Session State</div>
            <ol className="session-state-steps">
              {SESSION_STEPS.map((step, index) => (
                <li
                  key={step}
                  className={[
                    index === receiverSessionStep ? "is-active" : "",
                    index < receiverSessionStep ? "is-complete" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  {step}
                </li>
              ))}
            </ol>
          </div>
        </div>
        <div className="receiver-grid">
          <div className="guidance">
            <h3>Guidance</h3>
            <div className="guidance-text">{guidance}</div>
            <div className="control-strip">
              <button
                className="action"
                onClick={startCamera}
                disabled={
                  cameraState === "starting" || cameraState === "running"
                }
              >
                {cameraState === "running"
                  ? "Scanning"
                  : cameraState === "starting"
                    ? "Starting…"
                    : "Begin Reconstruction"}
              </button>
              <button className="action secondary" onClick={stopCamera}>
                Stop
              </button>
              <button
                className="link"
                onClick={() =>
                  setActiveCamera((prev) =>
                    prev === "environment" ? "user" : "environment",
                  )
                }
                disabled={cameraState === "running"}
              >
                Use {activeCamera === "environment" ? "Front" : "Rear"} Camera
              </button>
            </div>
            <div className="camera-status">
              Active camera:{" "}
              {activeCamera === "environment" ? "Rear (environment)" : "Front"}
            </div>
            <div className="diagnostic-hint">
              <div>
                Decoder:{" "}
                {captureMode === "fallback"
                  ? "ZXing fallback"
                  : "BarcodeDetector"}
              </div>
              <div>
                Video feed: {videoResolutionLabel}
                {aspectLabel ? ` · ${aspectLabel}` : ""}
              </div>
              {captureMode === "fallback" && (
                <>
                  <div>
                    Detections: {fallbackStats.detections}
                    {fallbackStats.lastValue && (
                      <>
                        {" "}
                        · Last frame:{" "}
                        <code>{fallbackStats.lastValue.slice(0, 24)}…</code>
                      </>
                    )}
                  </div>
                  <div>
                    Avg cadence: {detectionCadenceLabel ?? "—"}
                    {detectionIntervalLabel
                      ? ` (${detectionIntervalLabel})`
                      : ""}
                  </div>
                  <div>
                    Last hit:{" "}
                    {detectionAgeLabel ? `${detectionAgeLabel} ago` : "—"}
                  </div>
                  <div>Estimated luminance: {luminanceLabel ?? "—"}</div>
                </>
              )}
            </div>
            <div className="manual-decode">
              <button
                className="action secondary"
                onClick={handleManualDecode}
                disabled={cameraState !== "running"}
              >
                Snapshot Decode
              </button>
              <span
                className={[
                  "manual-status",
                  `manual-status-${manualDecodeStatus.status}`,
                ].join(" ")}
              >
                {manualDecodeStatus.status === "idle"
                  ? "Capture a still frame to validate decoding."
                  : (manualDecodeStatus.message ?? "Decoding snapshot…")}
              </span>
            </div>
            {cameraError && (
              <div className="error-text">
                {cameraError}
                {cameraErrorDetails && (
                  <span className="error-details"> — {cameraErrorDetails}</span>
                )}
              </div>
            )}
            <div className="progress">
              <div className="progress-label">
                Coverage &nbsp;{coveragePercent}
              </div>
              <div className="progress-bar">
                <div
                  className="progress-fill"
                  style={{
                    width: `${Math.min(status?.coverage ?? 0, 1) * 100}%`,
                  }}
                />
              </div>
            </div>
            <div className="progress">
              <div className="progress-label">
                Sync lock &nbsp;
                {lockState === "locked"
                  ? "Locked"
                  : lockTarget
                    ? `${lockProgress}/${lockTarget}`
                    : "Idle"}
              </div>
              <div className="progress-bar">
                <div
                  className="progress-fill is-sync"
                  style={{
                    width:
                      lockState === "locked"
                        ? "100%"
                        : lockTarget
                          ? `${Math.min(lockProgress / lockTarget, 1) * 100}%`
                          : "0%",
                  }}
                />
              </div>
            </div>
            {status && (
              <ul className="metrics-list">
                <li>Symbols observed: {status.symbols_observed}</li>
                <li>Unique indices: {status.unique_symbols}</li>
                <li>
                  Reconstruction:{" "}
                  {status.decode_complete ? "Verified" : "In progress"}
                </li>
              </ul>
            )}
          </div>

          <div className="capture-stage">
            <div className="capture-outline">
              <video
                ref={videoRef}
                className="capture-video"
                playsInline
                autoPlay
                muted
              />
              <canvas ref={sampleCanvasRef} className="capture-sample-canvas" />
              <canvas ref={manualCanvasRef} className="capture-manual-canvas" />
              <div className="capture-overlay">
                <div className="overlay-top">
                  <span
                    className={[
                      "lock-indicator",
                      lockState === "locked"
                        ? "is-locked"
                        : lockState === "acquiring"
                          ? "is-acquiring"
                          : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    {lockDescriptor}
                  </span>
                </div>
                <div className="overlay-middle">
                  <div className={reticleClassName} />
                </div>
                <div className="overlay-bottom">
                  <div className="capture-instruction">{overlayMessage}</div>
                </div>
              </div>
            </div>
            <div className="capture-footer">
              <div className="capture-status">
                {lastFrame
                  ? `Last capture: ${lastFrame.slice(0, 48)}…`
                  : "No frames yet"}
              </div>
              <div className="payload-panel">
                <div className="payload-header">
                  <span>Reconstructed payload</span>
                  <button
                    className="link"
                    onClick={handleCopyPayload}
                    disabled={!recoveredPayload}
                  >
                    {copyState === "copied"
                      ? "Copied!"
                      : copyState === "error"
                        ? "Copy failed"
                        : "Copy"}
                  </button>
                </div>
                <pre>
                  {recoveredPayload
                    ? recoveredPayload
                    : status?.decode_complete
                      ? "Payload will appear momentarily…"
                      : "Payload will appear here once reconstructed."}
                </pre>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default function App() {
  const [pyodideStatus, setPyodideStatus] = useState<PyodideStatus>("idle");
  const [pyodideError, setPyodideError] = useState<string | null>(null);
  const [role, setRole] = useState<Role>("none");
  const buildInfo = window.__TIGHTBEAM_BUILD ?? "dev";

  useEffect(() => {
    let cancelled = false;
    setPyodideStatus("loading");
    ensurePyodide()
      .then(() => {
        if (!cancelled) {
          setPyodideStatus("ready");
        }
      })
      .catch((err: unknown) => {
        console.error(err);
        if (!cancelled) {
          setPyodideError(err instanceof Error ? err.message : String(err));
          setPyodideStatus("error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const callPythonJson = useCallback<CallPythonJson>(
    async (fnName, ...args) => {
      const pyodide = await ensurePyodide();
      const fn = pyodide.globals.get(fnName);
      if (!fn) {
        throw new Error(`Pyodide function "${fnName}" is unavailable`);
      }
      try {
        const result = fn(...args);
        const text = typeof result === "string" ? result : result.toString();
        if (isDestroyable(result)) {
          result.destroy();
        }
        try {
          return JSON.parse(text);
        } catch (err) {
          throw new Error(
            `Unable to parse response from "${fnName}": ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      } catch (err) {
        throw new Error(
          `Pyodide invocation failed for "${fnName}": ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      } finally {
        if (isDestroyable(fn)) {
          fn.destroy();
        }
      }
    },
    [],
  );

  return (
    <div className="app-shell">
      <header className="hero">
        <h1>Tightbeam Optical Transport Layer</h1>
        <p className="hero-subline">
          Designed for environments where outbound connectivity is restricted or
          tightly controlled.
        </p>
        <p>
          Tightbeam is a transport layer for segmented environments. A
          constrained node emits optical transmission bursts, and a receiving
          system reconstructs signed payloads with reconstruction verification
          in real time.
        </p>
        <div className="status-row">
          <span className={`status-pill status-${pyodideStatus}`}>
            Pyodide {pyodideStatus === "ready" ? "ready" : pyodideStatus}
          </span>
          {pyodideError && <span className="error-text">{pyodideError}</span>}
          <span className="build-tag">Build {buildInfo}</span>
        </div>
        {role === "none" && (
          <div className="role-actions">
            <button
              className="role-card"
              onClick={() => setRole("sender")}
              disabled={pyodideStatus !== "ready"}
            >
              <h3>Constrained Node Console</h3>
              <p>
                Initiate a transport session and emit optical bursts from the
                constrained node display.
              </p>
            </button>
            <button
              className="role-card"
              onClick={() => setRole("receiver")}
              disabled={pyodideStatus !== "ready"}
            >
              <h3>Reconstruction Console</h3>
              <p>
                Use a webcam-equipped device to capture the bursts with guided
                feedback and reconstruction verification.
              </p>
            </button>
          </div>
        )}
      </header>

      {role !== "none" && (
        <main className="layout">
          {role === "sender" ? (
            <SenderView
              callPythonJson={callPythonJson}
              onBack={() => setRole("none")}
            />
          ) : (
            <ReceiverView
              callPythonJson={callPythonJson}
              onBack={() => setRole("none")}
            />
          )}
        </main>
      )}
    </div>
  );
}
