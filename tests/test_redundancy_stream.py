import random

from common.fountain.encoder import LTEncoder


def test_redundancy_stream_not_systematic_duplicates():
    random.seed(1337)
    payload = ("A" * (10 * 1024)).encode("utf-8")
    encoder = LTEncoder(
        data=payload, block_size=48, systematic=True, integrity_check=True
    )

    systematic_symbols = list(encoder.emit_systematic())
    systematic_map = {idxs[0]: payload for idxs, payload in systematic_symbols}

    redundancy = encoder.encode(500)
    duplicate_count = 0
    for idxs, payload in redundancy:
        if isinstance(idxs, tuple):
            idx_list = list(idxs)
        else:
            idx_list = list(idxs)
        if len(idx_list) == 1 and systematic_map.get(idx_list[0]) == payload:
            duplicate_count += 1

    duplicate_ratio = duplicate_count / len(redundancy)
    assert duplicate_ratio < 0.05
