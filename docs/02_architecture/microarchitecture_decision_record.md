# Microarchitecture Decision Record

Microarchitecture decision record(MDR)는 “무엇을 구현했는가”만 적는 문서가 아니다. Requirement와 assumption에서 후보를 만들고, 동일한 비교 조건에서 function/PPA/verification/physical evidence를 평가해 왜 한 후보를 선택했는지 남긴다.

> “Pipeline을 넣었다”, “MCP를 적용했다”, “operator를 공유했다”는 결론일 뿐이다. 어떤 contract와 evidence 때문에 다른 후보보다 적합했는지가 기록돼야 한다.

Requirement를 cycle/state contract로 내리는 방법은 [Requirement to Microarchitecture](requirement_to_microarchitecture.md)가 담당한다. 이 문서는 그 결정을 **재현하고 변경 시 재검토할 수 있는 기록 형식**으로 만든다.

## 1. Decision Record가 필요한 이유

RTL과 constraint만으로는 다음을 알기 어렵다.

- Latency/II가 requirement인지 우연한 implementation 결과인지
- Sharing assumption이 mutually exclusive traffic에 근거했는지
- Pipeline stage가 timing 때문인지 protocol boundary 때문인지
- MCP가 실제 delayed capture contract를 표현하는지
- Width가 range analysis로 정해졌는지 관성적인 값인지
- Area/power 숫자가 어떤 workload/corner/constraint에서 나왔는지
- Physical feedback으로 RTL duplication이 추가됐는지
- 어떤 assumption 변경이 decision을 invalidate하는지

Decision record는 RTL을 대체하지 않는다. Requirement, RTL, assertion, constraint와 report 사이의 traceability를 제공한다.

## 2. 최소 구성 요소

| Section | 핵심 내용 |
|---|---|
| Context | 문제, scope와 결정이 필요한 이유 |
| Interface/cycle contract | accept, complete, latency, II, stall/flush |
| Assumptions | traffic, clock/reset/domain, workload, physical 조건 |
| Invariants | 후보가 바꿔서는 안 되는 기능/ordering/numeric behavior |
| Candidates | 구조, schedule와 추가 state/control |
| Comparison boundary | 포함한 hierarchy, FIFO/MUX/arbiter/clock/reset overhead |
| Evidence | function, synthesis/STA, area/power, physical, verification |
| Decision | 선택과 조건부 근거 |
| Rejected alternatives | 왜 현재 조건에서 탈락했는지 |
| Constraint impact | clock, I/O, MCP/false path, CDC/RDC 영향 |
| Ownership | RTL/assertion/constraint/report/document owner |
| Change triggers | assumption/requirement/tool/physical 변경 시 재검토 조건 |
| Known risks | 아직 남은 uncertainty와 follow-up |

## 3. Context와 Contract를 먼저 쓴다

나쁜 기록:

```text
Decision: timing을 위해 pipeline 1단 추가.
```

필요한 정보가 있는 기록:

```text
Context:
- shared select + arithmetic path가 target setup budget을 넘는 후보가 있음

Contract:
- accept = in_valid && in_ready
- fixed output-available latency = 2 cycles
- initiation interval = 1
- ordered, no drop, no duplicate
- downstream stall에서 output valid/payload hold

Decision question:
- latency/II를 유지하면서 어떤 boundary와 resource structure가 contract를 만족하는가?
```

Pipeline 가능 여부는 latency contract에서 나오고, MCP 가능 여부는 actual capture schedule에서 나온다. Negative slack 자체가 두 선택의 권한을 만들지 않는다.

## 4. Assumption과 Invariant를 분리한다

### Assumption

Environment 또는 현재 implementation 조건이며 바뀔 수 있다.

- 두 request source가 동시에 valid일 확률/가능성
- Downstream ready의 maximum stall duration
- Clock target와 analysis modes
- Representative activity workload
- Physical hierarchy와 macro 위치
- Config가 transaction 중 바뀌지 않는 protocol

### Invariant

후보가 반드시 보존해야 하는 기능이다.

- Accepted transaction no-drop/no-duplicate/order
- Numeric range, rounding, saturation 또는 wrap
- Reset/flush priority
- CDC coherency와 domain ownership
- External latency/II와 ready/valid stability

Assumption을 invariant처럼 고정하면 future change를 놓치고, invariant를 assumption처럼 취급하면 최적화 중 기능을 바꿀 수 있다.

## 5. 동일한 Comparison Boundary

후보 A는 operator만, 후보 B는 FIFO/arbiter/valid registers까지 포함해 비교하면 결과가 의미 없다.

공통 boundary에 포함할 것:

- Input capture와 output holding storage
- Arbitration, MUX, tag와 response route
- Pipeline/control/valid registers
- Reset/enable/clock-gating overhead
- Required FIFO/skid capacity
- Buffering/replication cells가 반영되는 hierarchy
- Constraint와 analysis corner/mode
- 동일한 workload/activity window

Synthesis area, timing과 power를 비교할 때 tool version/option을 모두 기록할 필요는 project governance에 따르지만, 결과를 재현할 최소한의 analysis context는 남긴다. 특정 tool syntax를 universal template로 고정하지 않는다.

## 6. Candidate를 Hardware와 Schedule로 적는다

각 후보에 최소 다음을 포함한다.

```text
Candidate name
Hardware blocks: registers / operators / MUX / queue / control
Cycle schedule: accept / stage / output / stall
State ownership: persistent / in-flight / protocol
Expected PPA direction: hypothesis, not result
Primary risks: function / timing / power / area / physical / verification
Required evidence: what would confirm or reject it
```

Source code diff만 첨부하면 architecture 비교가 어렵다. 작은 block/cycle diagram이 더 직접적일 수 있다.

## 7. Generic Worked Decision

### 7.1 Context

두 independent clients가 unsigned 16-bit addition을 요청한다. System requirement는 두 clients가 같은 cycle에 모두 request할 수 있고, accepted request는 각 client의 local result channel에서 fixed latency로 완료되어야 한다.

```text
cycle        0        1        2
client 0     A        B
client 1     X        Y
required     accept A/X together; accept B/Y together
```

기존 후보는 한 shared adder와 fixed-priority arbitration을 사용한다. 이 구조는 cycle당 한 request만 accept하므로 simultaneous traffic contract를 만족하지 않는다.

### 7.2 Invariants

- 두 clients의 same-cycle accept 가능
- Per-client ordering, no drop/no duplicate
- Unsigned full-precision 17-bit sum
- Existing output latency contract 유지
- Reset 시 in-flight validity 폐기

### 7.3 Optimization flow

#### Remove

Unused diagnostic field와 관찰되지 않는 duplicate status register가 comparison boundary에 있다면 먼저 제거한다. Functionally 필요한 두 sums는 제거할 수 없다.

#### Disable

Inactive client lane의 operand registers/operator activity를 valid 조건으로 hold/isolate할 후보를 만든다. Enable/MUX timing과 clock load를 포함해 측정한다.

#### Simplify

Range analysis로 16-bit unsigned operands의 full-precision result가 17-bit임을 확인한다. 관성적인 wider datapath가 있었다면 17-bit로 줄이되 overflow contract를 바꾸지 않는다.

#### Share or Duplicate

| Candidate | Capacity | Added structure | Primary concern |
|---|---|---|---|
| Shared fixed-priority adder | 1 request/cycle | MUX/arbiter/owner | simultaneous contract 실패 |
| Shared adder + FIFO | bursts queue 가능, service 1/cycle | FIFO/tag/backpressure | sustained 2/cycle 불가 |
| Two local adders | 2 requests/cycle 가능 | duplicated arithmetic/output | area/switching 증가 |

Buffer는 burst를 흡수하지만 shared adder service rate를 2/cycle로 만들지 않는다. 현재 invariant에서는 local duplication candidate만 required capacity를 직접 만족한다.

#### Pipeline or architecture-valid MCP

- Shared adder pipeline은 clock timing/II를 개선할 수 있어도 single input issue width를 2로 만들지 않는다.
- Destination이 next defined edge에 capture한다면 MCP는 허용되지 않는다.
- Local adders가 target timing을 만족하지 못하고 external latency가 추가 stage를 허용한다면 per-lane pipeline을 별도 후보로 평가한다.

#### Physical optimization

Local adders를 각 client register/result channel 가까이에 배치할 가설을 검토한다. Post-route에서 result merge, clock load 또는 congestion이 새 bottleneck인지 확인한다.

### 7.4 Decision

현재 contract에서는 two-local-adder architecture를 선택한다. 근거는 “adder가 빠르다”가 아니라 simultaneous accept invariant를 충족하고 central arbitration/MUX를 제거한다는 것이다. Area와 switching 증가는 known cost이며 idle valid workload에서 enable/isolation 후보를 별도로 비교한다.

### 7.5 Rejected alternatives

- Shared fixed priority: client starvation/no-accept 가능
- Shared round-robin: fairness는 개선하지만 capacity는 1/cycle
- Shared + FIFO: bounded burst에는 유효하지만 sustained required rate 불충족
- MCP: actual next-edge capture와 불일치

### 7.6 Required evidence

- Both-valid continuous traffic no-drop/no-duplicate
- Width/carry boundary tests
- Shared vs duplicated same-boundary synthesis area
- Per-lane STA and central-control removal confirmation
- Representative activity power comparison
- Post-placement locality/congestion and clock-load review

이 사례의 숫자와 구조는 generic illustrative example이다. 실제 decision은 project requirement와 reports로 다시 작성한다.

## 8. Evidence의 질

### Functional evidence

- Transaction-level scoreboard와 assertions
- Sequential equivalence 또는 latency-aware comparison
- Boundary/simultaneous/reset/flush cases
- Numeric range/overflow proof

### Timing evidence

- Correct clock/mode/corner
- Startpoint/endpoint와 launch/capture edge
- Cell/net/late-control composition
- Setup/hold와 new worst path
- Pre-layout vs post-route correlation

### Power evidence

- Representative workload와 activity source
- Clock, internal, switching와 leakage 구분 가능 범위
- Speculative/inactive activity 확인
- Added enable/isolation/control cost

### Area/physical evidence

- Cell/register/operator/MUX/buffer breakdown
- Comparison boundary와 hierarchy
- Placement footprint, utilization/congestion
- Buffering/replication와 routing impact

“Report 첨부”만으로 충분하지 않다. Report가 어떤 claim을 지지하거나 반박하는지 한 줄로 연결한다.

## 9. Constraint Impact

Decision record는 constraint를 복사하는 장소가 아니라 functional 근거와 영향 범위를 연결하는 장소다.

기록할 것:

- New/removed clock 또는 generated relationship
- I/O latency/cycle contract 변화
- Pipeline stage 추가에 따른 path endpoints
- MCP/false path가 있다면 functional capture/no-capture evidence
- CDC/RDC boundary 변화
- Mode-specific constraint와 owner

MCP는 [Multi-Cycle Path](../03_timing/multi_cycle_path.md)의 contract와 setup/hold review를 만족해야 한다. “Timing 통과”를 decision 근거로만 적지 않는다.

## 10. Ownership과 Change Trigger

Owner는 사람 이름 대신 유지 가능한 role 또는 artifact 책임으로 기록할 수 있다.

| Artifact | Owner responsibility | Change trigger |
|---|---|---|
| Interface contract | latency/II/ordering | protocol revision |
| RTL | state/schedule implementation | feature or width change |
| Assertions/scoreboard | invariants | new stall/flush/mode |
| Constraints | clock/capture assumptions | boundary/clock change |
| PPA evidence | comparable reports | library/frequency/floorplan change |
| Decision record | assumption traceability | any trigger above |

대표 change trigger:

- Traffic can now overlap
- Maximum burst/stall changed
- Target frequency or latency changed
- Operand range/numeric policy changed
- Clock/reset/power domain changed
- Resource moved across hierarchy/macro boundary
- Synthesis/physical evidence reverses expected benefit
- Tool/library update materially changes mapping

## 11. Copyable Markdown Template

````markdown
# Microarchitecture Decision: <short title>

## Status

- Proposed / Accepted / Superseded
- Date or revision:
- Scope:

## Context and Decision Question

- Problem:
- Why a decision is needed now:
- Comparison boundary:

## Interface and Cycle Contract

- Acceptance event:
- Result-available / consumption event:
- Latency / II / throughput:
- Ordering, backpressure, stall, flush and reset:

## Assumptions

- Traffic/workload:
- Clock/reset/domain:
- Physical/hierarchy:
- Analysis limitations:

## Invariants

- Function/numeric behavior:
- No-drop/no-duplicate/order:
- CDC/RDC and safety requirements:

## Candidates

### Candidate A: <name>

- Hardware/state:
- Cycle schedule:
- Expected PPA direction:
- Risks:
- Required evidence:

### Candidate B: <name>

- Hardware/state:
- Cycle schedule:
- Expected PPA direction:
- Risks:
- Required evidence:

## Comparison Conditions

- Constraints/corners/modes:
- Workload/activity:
- Included logic/storage/control:

## Evidence

- Functional/verification:
- Synthesis/STA:
- Power/area:
- Placement/routing:

## Decision and Rationale

- Selected candidate:
- Contract and evidence supporting it:
- Costs accepted:

## Rejected Alternatives

- Candidate and reason under current assumptions:

## Constraint and Integration Impact

- Clock/I/O/MCP/false-path impact:
- CDC/RDC/reset/power impact:
- Updated assertions/documents:

## Known Risks and Follow-up

- Remaining uncertainty:
- Evidence still required:

## Ownership and Change Triggers

- Responsible artifacts/roles:
- Assumptions that require re-review when changed:
````

Template를 조직 고유 승인 flow처럼 사용하지 않는다. Project의 review process에 맞게 fields를 줄이거나 추가하되 contract, alternatives, evidence와 triggers는 보존한다.

## 12. 적용하면 안 되는 기록 방식

- 선택 결과만 있고 requirement/alternatives가 없는 문서
- 서로 다른 clock target/workload/hierarchy의 PPA 숫자를 한 표에서 비교
- Synthesis area만 보고 FIFO/MUX/clock/reset overhead를 제외
- Pre-layout timing을 post-route guarantee처럼 표현
- MCP command만 있고 functional capture evidence가 없음
- “Tool이 최적화함”으로 state/schedule ownership을 넘김
- Known risk를 숨기고 모든 항목을 pass로 표시

## 13. Common Mistakes

### Implementation 완료 후 정당화를 역으로 쓴다

실제 후보와 rejected evidence가 사라지고 선택 bias만 남는다.

### Assumption에 owner와 trigger가 없다

Traffic나 clock이 바뀌어도 old decision이 그대로 재사용된다.

### Area, timing, power의 measurement boundary가 다르다

숫자는 정밀해 보여도 후보 비교로 사용할 수 없다.

### Rejected alternative를 영구 금지로 기록한다

현재 assumption에서 탈락한 이유를 적어 future requirement에서 재평가할 수 있게 한다.

### Document가 RTL보다 stale하다

Decision ID 또는 link를 RTL/assertion/constraint review에 연결하고 change trigger를 regression/review checklist에 포함한다.

## 14. Verification and Review Strategy

Decision record 자체도 검증 대상이다.

- Contract가 current interface assertions와 일치하는가?
- Candidate schedule이 current RTL register boundaries와 일치하는가?
- Constraint exception scope가 record의 functional evidence와 일치하는가?
- Report revision과 comparison conditions가 동일한가?
- Rejected reason이 current requirement에서도 유효한가?
- Known risks가 issue/test/report로 추적되는가?

Architecture 변경 review에서는 “RTL diff가 맞는가?”와 함께 “decision record의 assumption 또는 outcome이 바뀌었는가?”를 묻는다.

## 15. Design Review Checklist

### Context와 contract

- [ ] Decision question과 scope가 구체적인가?
- [ ] Accept/output/latency/II/backpressure contract가 있는가?
- [ ] Assumption과 invariant를 구분했는가?
- [ ] 비교 boundary에 모든 storage/control/clock/reset overhead가 포함됐는가?

### Candidates와 evidence

- [ ] Remove→Disable→Simplify 순서를 먼저 검토했는가?
- [ ] Share/duplicate, pipeline/MCP와 physical 후보를 비교했는가?
- [ ] Rejected alternatives의 현재 조건상 이유가 있는가?
- [ ] 동일 constraint/corner/workload에서 PPA를 비교했는가?
- [ ] Functional, STA, area/power와 physical evidence를 claim에 연결했는가?

### Maintainability

- [ ] RTL/assertion/constraint/report/document owner가 있는가?
- [ ] Traffic, range, latency, clock/reset/domain과 floorplan trigger가 있는가?
- [ ] Known risk와 missing evidence를 숨기지 않았는가?
- [ ] Superseded decision과 current decision을 구분할 수 있는가?
- [ ] Review 시 current RTL/cycle schedule과 record가 일치하는가?

## 관련 문서

- [Requirement to Microarchitecture](requirement_to_microarchitecture.md)
- [State Partitioning and Ownership](state_partitioning_and_ownership.md)
- [Resource Sharing vs Duplication](resource_sharing_vs_duplication.md)
- [Architectural Timing Budget](architectural_timing_budget.md)
- [Area Design & Optimization](../05_area/overview.md)
- [RTL Design Review Checklist](../15_checklist/rtl_design_review_checklist.md)
