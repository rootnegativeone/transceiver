# File: utilities/fountain/encoder.py
"""
LT-style fountain encoder with robust soliton distribution and optional systematic output.
"""

from __future__ import annotations

import math
import random
import zlib
from typing import List, Optional

from ..shared.metrics import FountainMetrics
from ..shared.utils import split_blocks


class LTEncoder:
    def __init__(
        self,
        data: bytes,
        block_size: int,
        c: float = 0.1,
        delta: float = 0.5,
        systematic: bool = True,
        *,
        integrity_check: bool = False,
        metrics: Optional[FountainMetrics] = None,
    ):
        self.orig_len = len(data)
        self.blocks = split_blocks(data, block_size)
        self.k = len(self.blocks)
        self.c = c
        self.delta = delta
        self.systematic = systematic
        self.generated = 0
        self.integrity_check = integrity_check
        self.tag_bytes = 4 if integrity_check else 0
        self.metrics = metrics
        self._cdf = self._build_robust_soliton_cdf()

    def _build_robust_soliton_cdf(self) -> List[float]:
        """Pre-compute cumulative distribution for the robust soliton distribution."""
        k = self.k
        if k <= 1:
            return [1.0]

        c = max(self.c, 1e-6)
        delta = min(max(self.delta, 1e-6), 0.999999)

        R = c * math.log(k / delta) * math.sqrt(k)
        if R < 1.0:
            R = 1.0

        threshold = int(k / R)
        rho = [0.0] * k
        tau = [0.0] * k

        rho[0] = 1.0 / k
        for d in range(2, k + 1):
            rho[d - 1] = 1.0 / (d * (d - 1))

        if threshold >= 1:
            upper = min(threshold, k)
            for d in range(1, upper):
                tau[d - 1] = R / (d * k)
            if threshold <= k:
                tau[threshold - 1] = R * math.log(R / delta) / k

        total = sum(rho[i] + tau[i] for i in range(k))
        if total == 0.0:
            # Fallback to ideal distribution if something went wrong
            return [1.0 / k * (i + 1) for i in range(k)]

        cumulative = []
        running = 0.0
        for i in range(k):
            running += (rho[i] + tau[i]) / total
            cumulative.append(running)

        cumulative[-1] = 1.0  # guarantee final value hits 1
        return cumulative

    def _robust_soliton(self) -> int:
        """Sample a degree from the robust soliton distribution."""
        if self.k <= 1:
            return 1

        r = random.random()
        for idx, cutoff in enumerate(self._cdf, start=1):
            if r <= cutoff:
                return idx
        return self.k

    def emit_systematic(self):
        """Yield each original block directly in systematic mode."""
        for i, block in enumerate(self.blocks):
            payload = self._apply_integrity(block)
            if self.metrics:
                self.metrics.record_degree(1)
            if self.generated < i + 1:
                self.generated = i + 1
            yield ([i], payload)

    def encode_symbol(self) -> tuple[int, bytes]:
        # Optionally emit systematic block first
        if self.systematic and self.generated < self.k:
            block = self.blocks[self.generated]
            payload = self._apply_integrity(block)
            if self.metrics:
                self.metrics.record_degree(1)
            symbol = (self.generated, payload)
            self.generated += 1
            return symbol
        # Otherwise random combination
        d = self._robust_soliton()
        idxs = random.sample(range(self.k), d)
        payload_bytes = bytearray(self.blocks[idxs[0]])
        for i in idxs[1:]:
            block = self.blocks[i]
            payload_bytes = bytearray(x ^ y for x, y in zip(payload_bytes, block))
        payload = self._apply_integrity(bytes(payload_bytes))
        if self.metrics:
            self.metrics.record_degree(len(idxs))
        return (tuple(idxs), payload)

    def encode(self, n: int) -> list[tuple]:
        return [self.encode_symbol() for _ in range(n)]

    def _apply_integrity(self, payload: bytes) -> bytes:
        """Attach integrity checksum if enabled."""
        if not self.integrity_check:
            return payload
        checksum = zlib.crc32(payload) & 0xFFFFFFFF
        return payload + checksum.to_bytes(self.tag_bytes, byteorder="big")
