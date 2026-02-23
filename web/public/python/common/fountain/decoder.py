"""
LT-style fountain decoder using bit-sliced Gaussian elimination over GF(2).
Provides compatibility with systematic and redundant LT fountain streams.
"""

from __future__ import annotations

import zlib
from time import perf_counter
from typing import Iterable, List, Optional, Sequence, Tuple

from ..shared.metrics import FountainMetrics
from ..shared.utils import combine_blocks
from .matrix import solve_gf2


class LTDecoder:
    """Recover source blocks from LT fountain symbols."""

    def __init__(
        self,
        block_size: int,
        k: int,
        orig_len: int,
        *,
        integrity_check: bool = False,
        metrics: Optional[FountainMetrics] = None,
    ):
        """
        Parameters
        ----------
        block_size:
            Size in bytes for each original source block.
        k:
            Number of source blocks expected from the encoder.
        orig_len:
            Length of the original payload in bytes (used to trim padding).
        integrity_check:
            When True, expect a 4-byte CRC32 tag appended to each payload.
        metrics:
            Optional FountainMetrics collector for instrumentation.
        """
        self.block_size = block_size
        self.k = k
        self.orig_len = orig_len
        self.integrity_check = integrity_check
        self.tag_bytes = 4 if integrity_check else 0
        self.metrics = metrics
        self.symbols: List[Tuple[List[int], bytes]] = []
        self.last_pivots = 0
        self.last_rank = 0

    def add_symbol(self, idxs: int | Iterable[int], payload: bytes) -> bool:
        """Add a received symbol, dropping it if integrity checks fail."""
        if isinstance(idxs, int):
            idx_list = [idxs]
        else:
            idx_list = list(idxs)

        payload_bytes = payload
        if self.tag_bytes:
            if len(payload_bytes) < self.tag_bytes:
                if self.metrics:
                    self.metrics.record_symbol_rejected("too_short")
                return False
            data = payload_bytes[: -self.tag_bytes]
            provided = payload_bytes[-self.tag_bytes :]
            expected = zlib.crc32(data) & 0xFFFFFFFF
            if provided != expected.to_bytes(self.tag_bytes, byteorder="big"):
                if self.metrics:
                    self.metrics.record_symbol_rejected("crc_mismatch")
                return False
            payload_bytes = data

        self.symbols.append((idx_list, payload_bytes))
        return True

    def decode(self) -> bytes | None:
        """
        Attempt to reconstruct the original payload.

        Returns the recovered bytes or ``None`` if the system is underdetermined.
        """
        if len(self.symbols) < self.k:
            return None

        start = perf_counter()
        matrix = self._build_coefficient_matrix(self.symbols)
        selection, pivots = self._select_independent_rows(matrix)
        self.last_pivots = pivots
        self.last_rank = pivots
        if selection is None:
            if self.metrics:
                duration = perf_counter() - start
                self.metrics.record_decode(duration, False, pivots, len(self.symbols))
            return None

        payload_ints = self._convert_payloads_to_ints(self.symbols)
        matrix = [matrix[i] for i in selection]
        payload_ints = [payload_ints[i] for i in selection]

        solution = self._solve_bitwise(matrix, payload_ints)
        duration = perf_counter() - start
        success = solution is not None
        if self.metrics:
            symbols_used = len(selection) if success else pivots
            self.metrics.record_decode(
                duration, success, symbols_used, len(self.symbols)
            )

        if not success:
            return None

        blocks = self._convert_ints_to_blocks(solution)
        return combine_blocks(blocks, self.orig_len)

    def _build_coefficient_matrix(
        self, symbols: Sequence[Tuple[Sequence[int], bytes]]
    ) -> List[List[int]]:
        """Create the GF(2) coefficient matrix from symbol indices."""
        return [
            [1 if col in idxs else 0 for col in range(self.k)] for (idxs, _) in symbols
        ]

    def _convert_payloads_to_ints(
        self, symbols: Sequence[Tuple[Sequence[int], bytes]]
    ) -> List[int]:
        """Convert each symbol payload to an integer for bit slicing."""
        return [int.from_bytes(payload, byteorder="big") for (_, payload) in symbols]

    def _select_independent_rows(
        self, matrix: List[List[int]]
    ) -> Tuple[Optional[List[int]], int]:
        """
        Pick a subset of symbols that provides full rank.

        Returns a tuple of (selection, pivots) where `selection` is a list of row
        indices if full rank was achieved, otherwise ``None``. `pivots` counts the
        number of independent rows discovered.
        """
        if not matrix:
            return None, 0

        m = len(matrix)
        k = self.k
        working = [row[:] for row in matrix]
        row_indices = list(range(m))
        pivot_row = 0

        for col in range(k):
            pivot = None
            for r in range(pivot_row, m):
                if working[r][col] == 1:
                    pivot = r
                    break

            if pivot is None:
                continue

            if pivot != pivot_row:
                working[pivot_row], working[pivot] = working[pivot], working[pivot_row]
                row_indices[pivot_row], row_indices[pivot] = (
                    row_indices[pivot],
                    row_indices[pivot_row],
                )

            for r in range(pivot_row + 1, m):
                if working[r][col] == 1:
                    for c in range(col, k):
                        working[r][c] ^= working[pivot_row][c]

            pivot_row += 1
            if pivot_row == k:
                break

        if pivot_row < k:
            return None, pivot_row

        return row_indices[:k], pivot_row

    def _solve_bitwise(
        self, matrix: List[List[int]], payload_ints: List[int]
    ) -> List[int] | None:
        """
        Solve each bit plane independently using the GF(2) solver.

        Returns the reconstructed block integers, or ``None`` if any bit-plane
        is unsolvable (typically due to insufficient rank).
        """
        total_bits = self.block_size * 8
        recovered = [0] * self.k

        for bit in range(total_bits):
            rhs = [(value >> bit) & 1 for value in payload_ints]
            solution_bits = solve_gf2(matrix, rhs)
            if solution_bits is None:
                return None

            for idx, bit_value in enumerate(solution_bits):
                if bit_value:
                    recovered[idx] |= 1 << bit

        return recovered

    def _convert_ints_to_blocks(self, values: Sequence[int]) -> List[bytes]:
        """Convert integer block representations back to fixed-size byte blocks."""
        return [value.to_bytes(self.block_size, byteorder="big") for value in values]


__all__ = ["LTDecoder"]
