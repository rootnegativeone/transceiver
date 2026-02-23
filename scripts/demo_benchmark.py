import os
import random
import sys


def load_simulation():
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    sim_path = os.path.join(repo_root, "web", "public", "python")
    if sim_path not in sys.path:
        sys.path.insert(0, sim_path)
    import simulation as sim  # type: ignore

    return sim


def run_benchmark(
    sim, loss_rate: float, seed: int = 1337, frame_interval: float = 0.45
):
    payload = ("A" * (10 * 1024)).encode("utf-8")
    package = sim._prepare_package(payload, seed=seed)
    metadata = package["metadata"]
    session = sim.ReceiverSession(
        block_size=metadata["block_size"],
        k=metadata["k"],
        orig_len=metadata["orig_len"],
        integrity_check=metadata.get("integrity_check", True),
    )

    frames = [frame for frame in package["frames"] if frame["type"] == "symbol"]
    simulated_time = 0.0
    last_progress_time = 0.0
    max_stall = 0.0
    status = None

    for frame in frames:
        if random.random() < loss_rate:
            simulated_time += frame_interval
            continue
        status = session.add_symbol(
            frame["sequence"], frame["indices"], frame["payload_hex"]
        )
        simulated_time += frame_interval
        if status.get("newly_added"):
            max_stall = max(max_stall, simulated_time - last_progress_time)
            last_progress_time = simulated_time
        if status.get("decode_complete"):
            break

    if status is None:
        status = session._status_dict(redundant=False, newly_added=False)

    accepted = status.get("accepted_symbols_total", 0)
    symbols_per_sec = accepted / simulated_time if simulated_time else 0.0
    return {
        "loss_rate": loss_rate,
        "simulated_time_s": round(simulated_time, 2),
        "symbols_per_sec": round(symbols_per_sec, 2),
        "max_stall_s": round(max_stall, 2),
        "decode_complete": status.get("decode_complete"),
        "accepted_symbols": accepted,
        "unique_indices": status.get("accepted_unique_symbols"),
        "k": status.get("k"),
        "last_decode_attempt_ms": status.get("last_decode_attempt_ms"),
        "last_decode_duration_ms": status.get("last_decode_duration_ms"),
    }


def main():
    random.seed(1337)
    sim = load_simulation()
    for loss in (0.0, 0.10):
        result = run_benchmark(sim, loss)
        print(
            f"loss={result['loss_rate']:.0%} "
            f"time={result['simulated_time_s']}s "
            f"sym/s={result['symbols_per_sec']} "
            f"stall_max={result['max_stall_s']}s "
            f"accepted={result['accepted_symbols']}/{result['k']} "
            f"complete={result['decode_complete']} "
            f"last_decode={result['last_decode_attempt_ms']}ms "
            f"decode_dur={result['last_decode_duration_ms']}ms"
        )


if __name__ == "__main__":
    main()
