"""
Pyodide entry point that mirrors the browser Send → Encode → Receive flow.
"""

from __future__ import annotations

import base64
import json
import random
from dataclasses import dataclass, field
from time import perf_counter
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

from sim_payload import generate_sample_logs

from common.fountain.decoder import LTDecoder
from common.fountain.encoder import LTEncoder
from common.shared.metrics import FountainMetrics

DEFAULT_BLOCK_SIZE = 96
DEFAULT_REDUNDANCY = 4
DEFAULT_SEED = 1337

SYNC_PREAMBLE_COUNT = 6
SYNC_INSERT_INTERVAL = 8
SYNC_CONFIRMATION_REQUIRED = 4
DECODE_MARGIN = 12
DECODE_SYMBOL_STEP = 8
DECODE_MIN_INTERVAL = 0.4


def _normalize_indices(idxs: int | Iterable[int]) -> List[int]:
    if isinstance(idxs, int):
        return [idxs]
    return list(idxs)


def _encode_metadata_frame(
    sequence: int, metadata: Dict[str, int | str]
) -> Dict[str, object]:
    return {
        "sequence": sequence,
        "type": "meta",
        "content": metadata,
        "qr_value": f"M:{json.dumps(metadata, separators=(',', ':'))}",
    }


def _encode_symbol_frame(
    sequence: int,
    idx_list: List[int],
    payload: bytes,
    *,
    systematic: bool,
) -> Dict[str, object]:
    payload_hex = payload.hex()
    indices_part = ",".join(str(i) for i in idx_list)
    qr_value = f"S:{sequence}|{indices_part}|{payload_hex}"
    return {
        "sequence": sequence,
        "type": "symbol",
        "indices": idx_list,
        "degree": len(idx_list),
        "payload_hex": payload_hex,
        "systematic": systematic,
        "qr_value": qr_value,
    }


def _encode_sync_frame(
    sequence: int, ordinal: int, total: int, metadata: Dict[str, int | str]
) -> Dict[str, object]:
    payload = {
        "sequence": sequence,
        "ordinal": ordinal,
        "total": total,
        "block_size": metadata["block_size"],
        "k": metadata["k"],
        "orig_len": metadata["orig_len"],
        "integrity_check": metadata["integrity_check"],
        "session_id": metadata["session_id"],
        "confirmation_required": SYNC_CONFIRMATION_REQUIRED,
    }
    return {
        "sequence": sequence,
        "type": "sync",
        "ordinal": ordinal,
        "total": total,
        "content": payload,
        "qr_value": f"Y:{json.dumps(payload, separators=(',', ':'))}",
    }


def _prepare_package(payload: bytes, seed: int = DEFAULT_SEED) -> Dict[str, object]:
    random.seed(seed)

    metrics = FountainMetrics()
    encoder = LTEncoder(
        data=payload,
        block_size=DEFAULT_BLOCK_SIZE,
        systematic=True,
        integrity_check=True,
        metrics=metrics,
    )

    systematic_symbols = [
        (idxs, payload) for idxs, payload in encoder.emit_systematic()
    ]
    redundant_symbols = [
        (idxs, payload)
        for idxs, payload in encoder.encode(len(encoder.blocks) + DEFAULT_REDUNDANCY)
    ]
    all_symbols = systematic_symbols + redundant_symbols

    session_id = f"TB-{random.getrandbits(32):08X}"
    metadata = {
        "block_size": DEFAULT_BLOCK_SIZE,
        "k": len(encoder.blocks),
        "orig_len": len(payload),
        "integrity_check": True,
        "session_id": session_id,
    }

    frames: List[Dict[str, object]] = []
    sequence = 0

    sync_count = 0

    def append_sync() -> None:
        nonlocal sequence, sync_count
        ordinal = (sync_count % SYNC_PREAMBLE_COUNT) + 1
        frames.append(
            _encode_sync_frame(
                sequence=sequence,
                ordinal=ordinal,
                total=SYNC_PREAMBLE_COUNT,
                metadata=metadata,
            )
        )
        sequence += 1
        sync_count += 1

    for _ in range(SYNC_PREAMBLE_COUNT):
        append_sync()

    frames.append(_encode_metadata_frame(sequence=sequence, metadata=metadata))
    sequence += 1

    since_last_sync = 0
    for offset, (idxs, payload_bytes) in enumerate(all_symbols):
        idx_list = _normalize_indices(idxs)
        frames.append(
            _encode_symbol_frame(
                sequence=sequence,
                idx_list=idx_list,
                payload=payload_bytes,
                systematic=offset < len(systematic_symbols),
            )
        )
        sequence += 1
        since_last_sync += 1

        if since_last_sync >= SYNC_INSERT_INTERVAL:
            append_sync()
            since_last_sync = 0

    return {
        "seed": seed,
        "payload_text": _safe_decode_text(payload),
        "metadata": metadata,
        "frames": frames,
        "total_frames": len(frames),
        "systematic_count": len(systematic_symbols),
        "redundant_count": len(redundant_symbols),
        "sync": {
            "preamble_count": SYNC_PREAMBLE_COUNT,
            "interval": SYNC_INSERT_INTERVAL,
            "confirmation_required": SYNC_CONFIRMATION_REQUIRED,
        },
    }


def _is_utf8(payload: bytes) -> bool:
    try:
        payload.decode("utf-8")
        return True
    except UnicodeDecodeError:
        return False


def _safe_decode_text(payload: bytes) -> str:
    try:
        return payload.decode("utf-8")
    except UnicodeDecodeError:
        return base64.b64encode(payload).decode("ascii")


def _render_package(package: Dict[str, object]) -> str:
    return json.dumps(package)


def prepare_broadcast(seed: int = DEFAULT_SEED) -> str:
    payload = generate_sample_logs()
    package = _prepare_package(payload=payload, seed=seed)
    return _render_package(package)


def prepare_broadcast_from_base64(payload_b64: str, seed: int = DEFAULT_SEED) -> str:
    try:
        payload = base64.b64decode(payload_b64)
    except (base64.binascii.Error, ValueError) as exc:
        return json.dumps({"error": f"Invalid base64 payload: {exc}"})

    if not payload:
        return json.dumps({"error": "Payload is empty"})

    package = _prepare_package(payload=payload, seed=seed)
    package["payload_is_base64"] = not _is_utf8(payload)
    return _render_package(package)


@dataclass
class ReceiverSession:
    block_size: int
    k: int
    orig_len: int
    integrity_check: bool
    decoder: LTDecoder = field(init=False)
    metrics: FountainMetrics = field(init=False)
    sequences_seen: set[int] = field(default_factory=set)
    unique_indices: set[int] = field(default_factory=set)
    recovered_text: Optional[str] = None
    accepted_symbols: int = 0
    last_decode_attempt: float = 0.0
    last_decode_symbols: int = 0
    last_decode_duration: float = 0.0
    phase: str = "collecting"
    decode_error: Optional[str] = None
    finalize_status: str = "idle"
    finalize_started_at: Optional[float] = None
    finalize_error: Optional[str] = None
    phase_started_at: float = field(init=False)
    phase_durations: Dict[str, float] = field(
        default_factory=lambda: {
            "collecting": 0.0,
            "solving": 0.0,
            "finalizing": 0.0,
            "done": 0.0,
            "error": 0.0,
        }
    )
    start_time: float = field(init=False)

    def __post_init__(self) -> None:
        self.metrics = FountainMetrics()
        self.decoder = LTDecoder(
            block_size=self.block_size,
            k=self.k,
            orig_len=self.orig_len,
            integrity_check=self.integrity_check,
            metrics=self.metrics,
        )
        self.start_time = perf_counter()
        self.phase_started_at = self.start_time

    def add_symbol(
        self, sequence: int, indices: List[int], payload_hex: str
    ) -> Dict[str, object]:
        now = perf_counter()
        if sequence in self.sequences_seen:
            self._maybe_attempt_decode(now, new_symbol=False)
            return self._status_dict(redundant=True, newly_added=False)

        payload = bytes.fromhex(payload_hex)
        accepted = self.decoder.add_symbol(indices, payload)
        if not accepted:
            self._maybe_attempt_decode(now, new_symbol=False)
            return self._status_dict(redundant=False, newly_added=False)

        self.sequences_seen.add(sequence)
        self.unique_indices.update(indices)
        self.accepted_symbols += 1

        self._maybe_attempt_decode(now, new_symbol=True)

        return self._status_dict(redundant=False, newly_added=True)

    def _status_dict(self, *, redundant: bool, newly_added: bool) -> Dict[str, object]:
        coverage = len(self.unique_indices) / self.k if self.k else 0.0
        summary = self.metrics.summary()
        phase_durations = dict(self.phase_durations)
        now = perf_counter()
        if self.phase in phase_durations:
            phase_durations[self.phase] += now - self.phase_started_at
        return {
            "redundant": redundant,
            "newly_added": newly_added,
            "symbols_observed": len(self.sequences_seen),
            "unique_symbols": len(self.unique_indices),
            "accepted_symbols_total": self.accepted_symbols,
            "accepted_unique_symbols": len(self.unique_indices),
            "k": self.k,
            "rank_estimate": self.decoder.last_rank,
            "unknowns_remaining": max(self.k - self.decoder.last_rank, 0),
            "coverage": coverage,
            "decode_complete": self.recovered_text is not None,
            "recovered_text": self.recovered_text,
            "phase": self.phase,
            "last_decode_attempt_ms": round(
                (self.last_decode_attempt - self.start_time) * 1000, 1
            )
            if self.last_decode_attempt
            else None,
            "last_decode_attempt_age_ms": round(
                (now - self.last_decode_attempt) * 1000, 1
            )
            if self.last_decode_attempt
            else None,
            "last_decode_duration_ms": round(self.last_decode_duration * 1000, 1)
            if self.last_decode_duration
            else None,
            "phase_durations_ms": {
                key: round(value * 1000, 1) for key, value in phase_durations.items()
            },
            "decode_error": self.decode_error,
            "finalize_status": self.finalize_status,
            "finalize_error": self.finalize_error,
            "finalize_elapsed_ms": round((now - self.finalize_started_at) * 1000, 1)
            if self.finalize_started_at and self.finalize_status == "in_progress"
            else None,
            "metrics": summary,
        }

    def _set_phase(self, next_phase: str) -> None:
        if next_phase == self.phase:
            return
        now = perf_counter()
        if self.phase in self.phase_durations:
            self.phase_durations[self.phase] += now - self.phase_started_at
        self.phase = next_phase
        self.phase_started_at = now

    def _maybe_attempt_decode(self, now: float, *, new_symbol: bool) -> None:
        if self.recovered_text is not None or self.phase == "error":
            return
        if self.accepted_symbols < self.k + DECODE_MARGIN:
            self._set_phase("collecting")
            return

        due_to_timer = (now - self.last_decode_attempt) >= DECODE_MIN_INTERVAL
        due_to_symbols = new_symbol and (
            (self.accepted_symbols - self.last_decode_symbols) >= DECODE_SYMBOL_STEP
        )
        if not (due_to_timer or due_to_symbols):
            return

        self._set_phase("solving")
        self.last_decode_attempt = now
        self.last_decode_symbols = self.accepted_symbols
        attempt_start = perf_counter()
        try:
            recovered = self.decoder.decode()
        except Exception as exc:
            self.last_decode_duration = perf_counter() - attempt_start
            self.decode_error = str(exc)
            self.finalize_status = "error"
            self.finalize_error = self.decode_error
            self._set_phase("error")
            return

        self.last_decode_duration = perf_counter() - attempt_start
        if recovered is not None:
            self._finalize_recovery(recovered)
        else:
            self._set_phase("collecting")

    def _finalize_recovery(self, recovered: bytes) -> None:
        self._set_phase("finalizing")
        if self.finalize_status == "idle":
            self.finalize_status = "in_progress"
            self.finalize_started_at = perf_counter()
        try:
            self.recovered_text = recovered.decode("utf-8")
            self.finalize_status = "done"
            self._set_phase("done")
        except Exception as exc:
            self.finalize_status = "error"
            self.finalize_error = str(exc)
            self._set_phase("error")


_active_session: Optional[ReceiverSession] = None


def reset_receiver(
    block_size: int, k: int, orig_len: int, integrity_check: bool = True
) -> str:
    """Initialise a fresh receiver session with supplied metadata."""
    global _active_session
    _active_session = ReceiverSession(
        block_size=block_size,
        k=k,
        orig_len=orig_len,
        integrity_check=integrity_check,
    )
    return json.dumps({"status": "ready", "block_size": block_size, "k": k})


def receiver_add_symbol(sequence: int, indices: List[int], payload_hex: str) -> str:
    """Forward a decoded symbol from the browser receiver into the fountain decoder."""
    if _active_session is None:
        return json.dumps({"error": "receiver_not_initialised"})

    status = _active_session.add_symbol(sequence, indices, payload_hex)
    return json.dumps(status)


def receiver_status() -> str:
    """Return the current receiver session status."""
    if _active_session is None:
        return json.dumps({"error": "receiver_not_initialised"})
    return json.dumps(_active_session._status_dict(redundant=False, newly_added=False))


def simulate_transfer(seed: int = DEFAULT_SEED) -> str:
    """
    Compatibility helper mirroring the previous testing-oriented payload.
    """
    package = json.loads(prepare_broadcast(seed))
    metadata = package["metadata"]

    reset_receiver(
        block_size=metadata["block_size"],
        k=metadata["k"],
        orig_len=metadata["orig_len"],
        integrity_check=metadata.get("integrity_check", True),
    )

    timeline = []
    for frame in package["frames"]:
        if frame["type"] != "symbol":
            continue
        sequence = frame["sequence"]
        indices = frame["indices"]
        payload_hex = frame["payload_hex"]
        status = json.loads(receiver_add_symbol(sequence, indices, payload_hex))
        timeline.append(
            {
                "sequence": sequence,
                "coverage": status["coverage"],
                "decode_complete": status["decode_complete"],
            }
        )

    package["timeline"] = timeline
    package["receiver_summary"] = json.loads(receiver_status())
    return json.dumps(package)
