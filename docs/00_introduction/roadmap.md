# Documentation Roadmap

이 프로젝트는 V0.1 문서 묶음으로 끝나는 교재가 아니라 지속적으로 확장하는 **RTL Engineering Knowledge Base**다. Version은 작성량보다 기술 감사, canonical ownership, cross-link와 검증 상태를 기준으로 구분한다.

> 새 문서를 많이 만드는 것보다, 한 개념의 authoritative 설명 위치를 정하고 기존 문서와 일관되게 연결하는 것을 우선한다.

## 1. Version Definition

| 단계 | 의미 | Exit criteria |
|---|---|---|
| Draft | 내용 작성 중 | 구조와 핵심 message 존재 |
| Review Candidate | 기술/중복 검토 가능 | 예제, trade-off, checklist 포함 |
| Release Candidate | 통합 검증 단계 | nav/link/build/lint 및 기술 감사 완료 |
| Released | Git tag와 공개 release | 승인된 commit, release note, public check |

문서 본문에 `V0.1`이라고 적혀 있다는 사실만으로 GitHub release가 된 것은 아니다.

## 2. Current Foundation: V0.1 Candidate

V0.1은 전체 가이드의 판단 framework와 대표 문서를 제공한다.

- Introduction과 good RTL philosophy
- Timing overview, Critical Path, Pipeline, MCP
- Low-Power overview, Register Enable, Counter Optimization, Operand Isolation
- Clock overview, Clock Gating, inferred/explicit, root/function partition
- CDC overview, Metastability, 2FF, Pulse, Multi-bit, Bundled Data
- RTL Design Review Checklist
- MkDocs navigation과 strict build

Release 전 남은 공통 검증:

- 대표 Chapter의 public primary-reference technical audit
- SystemVerilog module/example syntax check
- SVA가 partial example임을 구분하고 tool support 확인
- canonical terminology와 중복 경계 점검
- rendered diagram/table/code visual review
- commit/tag/release는 repository-manager task에서 승인 후 수행

## 3. Full Chapter Plan

### 00. Introduction

- What Makes Good RTL?
- RTL vs Software Code
- RTL → Synthesis → Gate → P&R feedback loop
- Function/Timing/Power/Area/Robustness/Maintainability
- PPA trade-off와 guide 사용법
- requirement-to-evidence workflow
- design decision record template

### 01. RTL Design Fundamentals

- [공통 용어](../01_fundamentals/terminology.md)
- combinational vs sequential logic
- FF/register/state와 clock cycle
- concurrent hardware
- `if`/`case`/ternary의 hardware view
- priority와 mutual exclusivity
- width, signedness와 four-state simulation basics

우선 작성: `think_hardware_not_code.md`, `combinational_vs_sequential.md`, `priority_and_mux.md`, `width_and_signedness.md`

### 02. Architecture & Microarchitecture

- Requirement → architecture
- latency, throughput, initiation interval
- pipeline balancing와 feedback dependency
- serial vs parallel
- resource sharing vs duplication
- pre-computation
- architectural timing budget

우선 작성: `requirement_to_microarchitecture.md`, `latency_throughput_ii.md`, `resource_sharing_vs_duplication.md`, `feedback_dependency.md`, `architectural_timing_budget.md`

### 03. Timing

현재 기반: Timing overview, Critical Path, Pipeline, Multi-Cycle Path

추가 후보:

- setup/hold timing diagram deep dive
- priority/MUX/decode timing
- high fanout와 late control
- timing exception governance
- pre-layout vs post-route timing correlation

### 04. Low Power

현재 기반: Low-Power overview, Register Enable, Counter Optimization, Operand Isolation

추가 후보:

- activity-driven review workflow
- datapath/pipeline gating
- memory access activity
- power estimation evidence quality
- low-power change equivalence

### 05. Area

- bit-width minimization
- unused register/logic removal
- state reduction
- sharing vs duplication
- reset cost
- counter/FSM encoding
- area vs routing/congestion

우선 작성: `bit_width_minimization.md`, `resource_sharing.md`, `reset_area_cost.md`, `fsm_counter_encoding.md`

### 06. Clock

현재 기반: Clock overview, Clock Gating, Inferred vs Explicit Clock Gating, Root vs Function Clock

추가 후보:

- clock mux/divider architecture
- generated clock modeling concepts
- clock stop/resume protocol
- clock gating verification and DFT boundary

### 07. Reset

- reset requirement and resetless datapath
- synchronous vs asynchronous reset
- assertion and deassertion
- reset synchronizer and RDC
- reset fanout
- reset with gated/stopped clocks
- independent domain reset

우선 작성: `overview.md`, `sync_vs_async_reset.md`, `reset_deassertion.md`, `resetless_datapath.md`, `reset_with_clock_gating.md`

### 08. CDC

현재 기반: CDC overview, Metastability, 2FF Synchronizer, Pulse Crossing, Multi-Bit CDC, Bundled Data

추가 후보:

- handshake protocol
- Gray pointer
- async FIFO architecture/review
- reconvergence
- CDC waiver governance
- reset-domain crossing relationship

### 09. Control Logic

- FSM architecture and encoding
- counter/control window
- clear/load/count priority
- pulse vs level
- simultaneous/back-to-back events
- boundary, overflow and underflow
- illegal state recovery

우선 작성: `fsm_design.md`, `priority_and_simultaneous_events.md`, `pulse_level_event.md`, `counter_boundary.md`, `illegal_state_recovery.md`

### 10. Datapath

- arithmetic inference
- add/sub/compare/shift/MUX
- signed/unsigned and width management
- overflow, saturation, rounding
- parallelization and pre-computation
- constant optimization

우선 작성: `width_signedness.md`, `overflow_saturation_rounding.md`, `mux_and_select.md`, `parallel_precomputation.md`

### 11. Synthesis-Aware RTL

- RTL construct to hardware mapping
- MUX/register enable/arithmetic inference
- constant propagation and dead logic
- sharing and optimization
- synthesis report/netlist feedback
- avoid over-coding tool optimizations

우선 작성: `rtl_to_hardware_mapping.md`, `enable_and_mux_inference.md`, `constant_dead_logic.md`, `read_synthesis_reports.md`

### 12. Physical-Aware RTL

- high fanout and long route
- congestion and hierarchy
- placement sensitivity
- clock/reset tree implications
- replication and locality
- PPA feedback loop

우선 작성: `fanout_and_locality.md`, `congestion_aware_structure.md`, `hierarchy_and_placement.md`, `rtl_to_post_route_feedback.md`

### 13. Verification & Robustness

- design for verification
- assertion/invariant
- corner-case matrix
- reset/mode/back-to-back events
- lint, formal and equivalence
- illegal state and protocol violation

우선 작성: `assertion_driven_rtl.md`, `corner_case_matrix.md`, `lint_formal_equivalence.md`, `reset_mode_transition_verification.md`

### 14. Common RTL Anti-Patterns

각 항목은 Bad example → failure mechanism → better architecture → exceptions 순서를 따른다.

- raw clock gating
- free-running unused counter
- reset everything
- oversized register
- deep priority chain
- independent 2FF bus
- MCP used to hide timing
- excessive pipeline
- unnecessary clear
- enable everywhere
- large decode without timing review
- ignored synthesis/fanout
- assumption hidden only in SDC

### 15. RTL Design Review Checklist

현재 checklist를 requirement/architecture decision record, RTL/assertion location, timing/power/area report, CDC/RDC review, owner/change trigger와 연결한다.

## 4. Recommended Expansion Order

```text
Foundation + canonical terms
        ↓
Architecture / latency / throughput
        ↓
Area + Reset
        ↓
Control Logic + Datapath
        ↓
Synthesis-Aware + Physical-Aware
        ↓
Verification + Anti-Patterns
        ↓
Cross-chapter audit + V1.0
```

이 순서는 앞 Chapter의 용어와 decision framework를 뒤 Chapter가 재사용하도록 하기 위한 것이다.

## 5. Per-Document Definition of Done

- [ ] 왜 필요한지 실제 설계 문제로 설명한다.
- [ ] Hardware structure 또는 timing/protocol diagram이 있다.
- [ ] Generic SystemVerilog example 또는 명시적 비적용 이유가 있다.
- [ ] Synthesis/STA/physical mapping을 조건부로 설명한다.
- [ ] Timing/Power/Area trade-off를 다룬다.
- [ ] 적용하면 안 되는 경우와 common mistake가 있다.
- [ ] Verification strategy와 review checklist가 있다.
- [ ] Canonical 용어를 재정의하지 않고 상대 링크한다.
- [ ] 기존 문서의 authoritative section과 중복되지 않는다.
- [ ] 확인되지 않은 tool-specific behavior를 사실처럼 쓰지 않는다.
- [ ] MkDocs strict build, relative link와 code fence 검증을 통과한다.

## 6. Release Discipline

각 release는 included document list, technical review scope, known limitations, build/link/lint result, public-repository scan, commit/tag와 follow-up backlog를 남긴다.

Release를 한 뒤에도 잘못된 설명을 고치고 cross-chapter ownership을 개선할 수 있도록 change history를 유지한다.
