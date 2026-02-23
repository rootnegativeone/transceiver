"""
Pyodide entry point that mirrors the browser Send → Encode → Receive flow.
"""

from __future__ import annotations

import base64
import json
import random
from dataclasses import dataclass, field
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

from sim_payload import generate_sample_logs

from common.fountain.decoder import LTDecoder
from common.fountain.encoder import LTEncoder
from common.shared.metrics import FountainMetrics

DEFAULT_BLOCK_SIZE = 48
DEFAULT_REDUNDANCY = 4
DEFAULT_SEED = 1337

SYNC_PREAMBLE_COUNT = 6
SYNC_INSERT_INTERVAL = 6
SYNC_CONFIRMATION_REQUIRED = 4

QR_VERSION = 8
QR_ECC_LEVEL = "M"
MAX_QR_VALUE_BYTES = 180
MAX_SYMBOL_RETRIES = 8


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


def _encode_symbol_payload(
    session_id: str,
    sequence: int,
    slot: int,
    symbol_id: int,
    idx_list: List[int],
    payload: bytes,
    *,
    systematic: bool,
) -> Dict[str, object]:
    payload_hex = payload.hex()
    indices_part = ",".join(str(i) for i in idx_list)
    qr_value = (
        f"S2:{session_id}|{sequence}|{slot}|{symbol_id}|{indices_part}|{payload_hex}"
    )
    return {
        "sequence": sequence,
        "type": "symbol",
        "symbol_id": symbol_id,
        "slot": slot,
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
        (idxs, payload, True) for idxs, payload in encoder.emit_systematic()
    ]
    redundant_symbols = [
        (idxs, payload, False)
        for idxs, payload in encoder.encode(len(encoder.blocks) + DEFAULT_REDUNDANCY)
    ]
    all_symbols = systematic_symbols + redundant_symbols
    all_symbols_iter = iter(all_symbols)

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
    symbol_id = 0
    offset = 0
    while offset < len(all_symbols):
        symbol_entries = []
        for slot in range(2):
            attempts = 0
            while attempts < MAX_SYMBOL_RETRIES:
                if offset >= len(all_symbols):
                    break
                try:
                    idxs, payload_bytes, systematic = next(all_symbols_iter)
                except StopIteration:
                    idxs, payload_bytes = encoder.encode_symbol()
                    systematic = False
                idx_list = _normalize_indices(idxs)
                entry = _encode_symbol_payload(
                    session_id=session_id,
                    sequence=sequence,
                    slot=slot,
                    symbol_id=symbol_id,
                    idx_list=idx_list,
                    payload=payload_bytes,
                    systematic=systematic,
                )
                if len(entry["qr_value"].encode("utf-8")) <= MAX_QR_VALUE_BYTES:
                    symbol_entries.append(entry)
                    symbol_id += 1
                    offset += 1
                    break
                attempts += 1

            if attempts >= MAX_SYMBOL_RETRIES:
                return {
                    "error": (
                        "QR payload exceeds fixed version capacity. "
                        "Reduce payload size or block size."
                    )
                }

        frames.append(
            {
                "sequence": sequence,
                "type": "symbol_pair",
                "symbols": symbol_entries,
            }
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
    symbol_ids_seen: set[int] = field(default_factory=set)
    unique_indices: set[int] = field(default_factory=set)
    recovered_text: Optional[str] = None

    def __post_init__(self) -> None:
        self.metrics = FountainMetrics()
        self.decoder = LTDecoder(
            block_size=self.block_size,
            k=self.k,
            orig_len=self.orig_len,
            integrity_check=self.integrity_check,
            metrics=self.metrics,
        )

    def add_symbol(
        self, symbol_id: int, indices: List[int], payload_hex: str
    ) -> Dict[str, object]:
        if symbol_id in self.symbol_ids_seen:
            return self._status_dict(redundant=True, newly_added=False)

        payload = bytes.fromhex(payload_hex)
        accepted = self.decoder.add_symbol(indices, payload)
        if not accepted:
            return self._status_dict(redundant=False, newly_added=False)

        self.symbol_ids_seen.add(symbol_id)
        self.unique_indices.update(indices)

        recovered = self.decoder.decode()
        if recovered is not None:
            self.recovered_text = recovered.decode("utf-8")

        return self._status_dict(redundant=False, newly_added=True)

    def _status_dict(self, *, redundant: bool, newly_added: bool) -> Dict[str, object]:
        coverage = len(self.unique_indices) / self.k if self.k else 0.0
        summary = self.metrics.summary()
        return {
            "redundant": redundant,
            "newly_added": newly_added,
            "symbols_observed": len(self.symbol_ids_seen),
            "unique_symbols": len(self.unique_indices),
            "coverage": coverage,
            "decode_complete": self.recovered_text is not None,
            "recovered_text": self.recovered_text,
            "metrics": summary,
        }


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


def receiver_add_symbol(symbol_id: int, indices: List[int], payload_hex: str) -> str:
    """Forward a decoded symbol from the browser receiver into the fountain decoder."""
    if _active_session is None:
        return json.dumps({"error": "receiver_not_initialised"})

    status = _active_session.add_symbol(symbol_id, indices, payload_hex)
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
        if frame["type"] == "symbol_pair":
            for symbol in frame["symbols"]:
                symbol_id = symbol["symbol_id"]
                indices = symbol["indices"]
                payload_hex = symbol["payload_hex"]
                status = json.loads(
                    receiver_add_symbol(symbol_id, indices, payload_hex)
                )
                timeline.append(
                    {
                        "sequence": frame["sequence"],
                        "symbol_id": symbol_id,
                        "coverage": status["coverage"],
                        "decode_complete": status["decode_complete"],
                    }
                )

    package["timeline"] = timeline
    package["receiver_summary"] = json.loads(receiver_status())
    return json.dumps(package)
