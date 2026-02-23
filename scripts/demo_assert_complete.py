import os
import sys


def load_simulation():
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    sim_path = os.path.join(repo_root, "web", "public", "python")
    if sim_path not in sys.path:
        sys.path.insert(0, sim_path)
    import simulation as sim  # type: ignore

    return sim


def main():
    sim = load_simulation()
    payload = ("A" * (10 * 1024)).encode("utf-8")
    package = sim._prepare_package(payload, seed=1337)
    metadata = package["metadata"]
    session = sim.ReceiverSession(
        block_size=metadata["block_size"],
        k=metadata["k"],
        orig_len=metadata["orig_len"],
        integrity_check=metadata.get("integrity_check", True),
    )

    for frame in package["frames"]:
        if frame["type"] != "symbol":
            continue
        status = session.add_symbol(
            frame["sequence"], frame["indices"], frame["payload_hex"]
        )
        if status.get("decode_complete"):
            print("OK: reconstruction completed")
            return 0

    print("FAIL: reconstruction did not complete")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
