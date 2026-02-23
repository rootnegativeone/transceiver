# Tightbeam Agent Context

You are helping develop **Tightbeam**, a deterministic **one-way optical transport layer** for moving **signed payloads** across **segmented or constrained environments** (i.e., where outbound connectivity is restricted or tightly controlled). Tightbeam uses high-frequency QR bursts (rendered as GIF/canvas sequences) and robust reconstruction to tolerate burst loss (Gilbert–Elliott-style channels).

Tightbeam is an **engine** with multiple possible surfaces (security wedge first; POS later). In the near term we are optimizing for a **credible 60-second enterprise demo** and high-signal validation conversations with architects/security people.

---

## North Star (1 sentence)
A one-way optical transport layer for moving signed payloads across segmented environments — without modifying network policy.

---

## Current Phase
**Validation with a prototype**: it must *work reliably* and *look coherent enough* that an enterprise architect/security reviewer takes it seriously.

This is not production. This is not compliance-certified. It must be deterministic, comprehensible, and demoable.

---

## Priorities (ordered)

### P0 — Demo reliability & deterministic flow
- Clean start → transmit → reconstruct → verify.
- No stuck states.
- Stable decode % and completion behavior.
- Run twice in a row without fiddling.

### P1 — Engine correctness (transport primitive)
- Resilience to burst/frame loss (Gilbert–Elliott channel characteristics).
- Prefer **rateless fountain codes** / erasure-resilient approach.
- Deterministic reconstruction + verification (integrity checks).
- Metrics-driven iteration (coverage %, decode time, loss rate tolerance).

### P2 — Enterprise surface framing (copy + tone)
- Remove POS/retail framing from default demo.
- Use architect-grade language: segmented environments, constrained node, signed payload, session metrics, reconstruction verified.

### P3 — Modularity & testability (no big refactors)
- Keep encoder/decoder modular and testable.
- Do not do broad architecture refactors unless directly needed for P0/P1.

---

## Non-goals (explicit)
- No auth, no backend persistence, no user accounts.
- No compliance claims (no PCI references in UI).
- No “key rotation product”, “firmware product”, or market packaging yet.
- No major refactor of the engine unless a reliability bug forces it.

---

## Repo Layout (logical)
- `engine/`
  - Core encoding/decoding primitives (chunking, FEC/fountain, framing, CRC/verification).
- `surfaces/`
  - Thin adapters and UI surfaces (enterprise demo first).
- `sim/` or `web/`
  - Browser-based simulation/demo (Vite + React).
- `utilities/`
  - Metrics, helpers, instrumentation.
- `tests/`
  - Unit + integration tests for engine correctness.
- `logs/`
  - Sample payloads and local run artifacts.

(If your repo currently uses `encoder/` and `decoder/`, keep them, but treat them as `engine/*` conceptually. Do not rename folders unless necessary.)

---

## Terminology (must use)
### Approved terms
- **Constrained Node**
- **Segmented Environment**
- **Signed Payload**
- **Transport Session**
- **Optical Transmission**
- **Reconstruction**
- **Verification**
- **Session Metrics**

### Avoid in default surface
- POS, terminal, store, Clover, Lightspeed
- “Send Logs” / “Exfiltrate Logs” wording
- Retail payments styling cues

(We can add a POS skin later as a surface, but it is not the default for this phase.)

---

## Demo Surface: Enterprise Architect (default)

### UI requirements (minimal)
- Primary CTA: **“Initiate Transport Session”** or **“Initiate Secure Transfer”**
- State machine displayed clearly:
  1) Idle
  2) Session Initiated
  3) Optical Transmission Active
  4) Reconstruction In Progress
  5) Verification Complete

### Minimal credibility cues (no new engine features required)
- Session ID (random/short hash)
- Payload size
- Integrity status:
  - “Signed Payload” label (static)
  - “Reconstruction Verified — Integrity Confirmed” on completion

### Visual tone
- Subdued enterprise palette (slate/navy/charcoal, muted steel-blue accent)
- Calm typography, minimal animation, no neon
- No debug clutter exposed by default (debug toggle is OK)

---

## Milestone: Enterprise Demo MVP (Vercel-hosted)

### Objective
Create a browser-based simulation that makes the optical transport visible and understandable within 10 seconds, and completes end-to-end deterministically for a 60-second demo.

### Definition of Done
- Runs in Chrome on a laptop webcam with minimal setup beyond camera permission.
- End-to-end flow completes reliably (2 consecutive runs).
- Observer can explain Tightbeam back in one sentence after watching.

### Work Items (prioritized)
1. **Enterprise copy + theming pass**
   - Remove POS language
   - Implement enterprise tone and labels
2. **State-machine UI + status line**
   - Clear steps and completion states
   - Session ID / payload size / integrity
3. **Stability fixes for encode → transmit → decode**
   - No stalls; clean completion
4. **Metrics panel preserved**
   - Bitrate, frame rate, % complete (whatever exists today)
5. **Demo payload**
   - Use a small, realistic “signed payload” sample (JSON/text) without calling it “logs”

### Validation Criteria (updated)
- Functional: reconstruction success is high and deterministic for the demo environment.
- Comprehensible: “what’s happening” is clear within 10 seconds.
- Credible: UI does not look like a retail prototype; feels like internal infra tooling.

---

## Agent Operating Instructions
- Optimize for **P0 reliability** and **P2 enterprise framing** first.
- If a change risks breaking the demo, do not do it.
- Prefer small, reversible diffs.
- Keep metrics and instrumentation intact.
- Always run the full demo flow twice before calling a change “done”.

---

## Quick demo script (for internal alignment)
- “Initiate transport session.”
- “Payload is encoded into an optical burst sequence.”
- “Receiver reconstructs under loss.”
- “Reconstruction verified; integrity confirmed.”
- “Session metrics recorded.”

(Do not mention POS. Do not mention compliance. Do not over-explain encoding.)
