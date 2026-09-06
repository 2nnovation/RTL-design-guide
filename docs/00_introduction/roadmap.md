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

작성 완료: `think_hardware_not_code.md`, `combinational_vs_sequential.md`, `priority_and_mux.md`, `width_and_signedness.md`

### 02. Architecture & Microarchitecture

- Requirement → architecture
- latency, throughput, initiation interval
- pipeline balancing와 feedback dependency
- serial vs parallel
- resource sharing vs duplication
- pre-computation
- architectural timing budget

작성 완료: `requirement_to_microarchitecture.md`, `state_partitioning_and_ownership.md`, `latency_throughput_ii.md`, `buffering_and_backpressure.md`, `feedback_dependency.md`, `resource_sharing_vs_duplication.md`, `parallelism_and_precomputation.md`, `architectural_timing_budget.md`, `microarchitecture_decision_record.md`

Architecture 핵심 문서가 연결되었으며 후속 확장은 cross-chapter audit와 실제 review gap을 기준으로 결정한다.

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

현재 기반: Area overview부터 physical footprint evidence까지 연결된 실무형 area guide

- bit-width minimization
- unused register/logic removal
- state reduction
- sharing vs duplication
- reset cost
- counter/FSM encoding
- area vs routing/congestion

작성 완료: `overview.md`, `bit_width_minimization.md`, `unused_logic_and_state_reduction.md`, `reset_area_cost.md`, `fsm_counter_encoding.md`, `memory_and_register_array.md`, `physical_area_and_congestion.md`

Reset cost의 functional architecture, sequencing와 RDC contract는 작성 완료된 **07. Reset** chapter로 연결한다.

### 06. Clock

현재 기반: Clock overview, Clock Gating, Inferred vs Explicit Clock Gating, Root vs Function Clock

추가 후보:

- clock mux/divider architecture
- generated clock modeling concepts
- clock stop/resume protocol
- clock gating verification and DFT boundary

### 07. Reset

현재 기반: Reset requirement와 state inventory부터 per-domain release, resetless datapath와 gated-clock sequencing까지 연결된 reset architecture guide

작성 완료: `overview.md`, `sync_vs_async_reset.md`, `reset_deassertion.md`, `resetless_datapath.md`, `reset_with_clock_gating.md`

다음 단계의 reset 연계는 작성 완료된 **09. Control Logic** chapter에서 FSM/control window, event priority, pulse/level과 illegal-state recovery로 확장했다.

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

- FSM functional architecture와 request/completion/response acceptance
- priority/merge/reject/queue와 simultaneous/back-to-back events
- same-domain pulse/level, re-arm와 sticky pending
- counter boundary, overflow/underflow와 parameter contract
- illegal encoding/protocol event containment과 recovery

작성 완료: `fsm_design.md`, `priority_and_simultaneous_events.md`, `pulse_level_event.md`, `counter_boundary.md`, `illegal_state_recovery.md`

Control phase에서 생성한 mode/select/valid는 작성 완료된 **10. Datapath** chapter의 arithmetic, resize와 speculative commit contract로 이어진다.

### 10. Datapath

- arithmetic inference
- add/sub/compare/shift/MUX
- signed/unsigned and width management
- overflow, saturation, rounding
- parallelization and pre-computation
- constant optimization

작성 완료: `width_signedness.md`, `overflow_saturation_rounding.md`, `mux_and_select.md`, `parallel_precomputation.md`

RTL construct와 실제 mapping/report feedback은 작성 완료된 **11. Synthesis-Aware RTL** chapter로 연결한다.

### 11. Synthesis-Aware RTL

- RTL construct to hardware mapping
- MUX/register enable/arithmetic inference
- constant propagation and dead logic
- sharing and optimization
- synthesis report/netlist feedback
- avoid over-coding tool optimizations

작성 완료: [RTL to Hardware Mapping](../11_synthesis/rtl_to_hardware_mapping.md), [Enable and MUX Inference](../11_synthesis/enable_and_mux_inference.md), [Constant and Dead Logic](../11_synthesis/constant_dead_logic.md), [Reading Synthesis Reports](../11_synthesis/read_synthesis_reports.md)

Mapping/report 증거는 작성 완료된 **12. Physical-Aware RTL**의 fanout/locality, congestion, hierarchy/placement와 post-route feedback으로 연결한다.

### 12. Physical-Aware RTL

- high fanout and long route
- congestion and hierarchy
- placement sensitivity
- clock/reset tree implications
- replication and locality
- PPA feedback loop

작성 완료: [Fanout and Locality](../12_physical_aware/fanout_and_locality.md), [Congestion-Aware Structure](../12_physical_aware/congestion_aware_structure.md), [Hierarchy and Placement](../12_physical_aware/hierarchy_and_placement.md), [RTL to Post-Route Feedback](../12_physical_aware/rtl_to_post_route_feedback.md)

**13. Verification & Robustness**의 우선 문서 4개와 **14. Common RTL Anti-Patterns**의 계획 문서 13개를 작성했다. 다음 단계는 cross-chapter technical audit와 예제 검증을 수행하고 release candidate 조건의 충족 여부를 판단하는 것이다. 작성 완료는 EDA 검증이나 공개 release 완료를 뜻하지 않는다.

### 13. Verification & Robustness

- design for verification
- assertion/invariant
- corner-case matrix
- reset/mode/back-to-back events
- lint, formal and equivalence
- illegal state and protocol violation

작성 완료: [Assertion-Driven RTL](../13_verification/assertion_driven_rtl.md), [Corner-Case Matrix](../13_verification/corner_case_matrix.md), [Lint, Formal, and Equivalence](../13_verification/lint_formal_equivalence.md), [Reset and Mode Transition Verification](../13_verification/reset_mode_transition_verification.md)

Verification의 우선 문서와 계획된 Anti-Patterns 문서가 연결되었으며 다음 확장은 전체 guide audit에서 발견한 검토 공백을 기준으로 진행한다.

### 14. Common RTL Anti-Patterns

각 항목은 Bad example → failure mechanism → better architecture → exceptions → verification evidence 순서를 따른다.

작성 완료:

- [Raw Clock Gating](../14_anti_patterns/raw_clock_gating.md)
- [Free-Running Unused Counter](../14_anti_patterns/free_running_unused_counter.md)
- [Reset Everything](../14_anti_patterns/reset_everything.md)
- [Oversized Register](../14_anti_patterns/oversized_register.md)
- [Deep Priority Chain](../14_anti_patterns/deep_priority_chain.md)
- [Independent 2FF Bus](../14_anti_patterns/independent_2ff_bus.md)
- [MCP Used to Hide Timing](../14_anti_patterns/mcp_used_to_hide_timing.md)
- [Excessive Pipeline](../14_anti_patterns/excessive_pipeline.md)
- [Unnecessary Clear](../14_anti_patterns/unnecessary_clear.md)
- [Enable Everywhere](../14_anti_patterns/enable_everywhere.md)
- [Large Decode Without Timing Review](../14_anti_patterns/large_decode_without_timing_review.md)
- [Ignoring Synthesis Result and Fanout](../14_anti_patterns/ignoring_synthesis_result_and_fanout.md)
- [Assumption Hidden Only in SDC](../14_anti_patterns/assumption_hidden_only_in_sdc.md)

계획된 anti-pattern 13개 중 남은 미작성 문서는 0개다. 이후 작업은 canonical 문서와의 기술적 일관성·중복 경계 감사, SystemVerilog/SVA 예제 검증, rendered page 점검이다. Commit/tag/release와 공개 작업은 별도 승인 후 진행한다.

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
