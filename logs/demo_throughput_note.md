# Demo Throughput Note (10KB)

## What Was Wrong
- Redundancy stream duplicated systematic symbols because the encoder did not advance its internal counter after `emit_systematic()`.
- The receiver attempted a full decode on every accepted symbol, causing extra work and UI jitter near the end.

## What Changed
- `emit_systematic()` now advances the encoder’s `generated` counter so redundancy symbols are truly LT-coded.
- Receiver decode is gated: it only attempts solving after `k + margin`, and no more than every 8 new symbols or 400ms.
- Receiver UI now surfaces phase (Collecting → Solving → Finalizing) and decode attempt timing.
- Demo cadence is 450ms per frame, block size is 96 bytes, sync insert interval is 8 frames.

## Before / After (Simulated)
Baseline (old settings, simulated @ 650ms, block size 48):
- 0% loss: ~146.9s, 1.54 symbols/sec, complete
- 10% loss: ~242.5s, 1.33 symbols/sec, complete

After changes (simulated @ 450ms, block size 96):
- 0% loss: 53.55s, 2.22 symbols/sec, complete
- 10% loss: 58.05s, 2.05 symbols/sec, complete

Notes:
- These are simulated times at fixed frame cadence; handheld capture will vary.
