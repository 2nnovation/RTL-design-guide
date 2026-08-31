# Area Design & Optimization

RTL area는 source line 수가 아니다. Synthesis가 만든 registers, operators, MUX, decoders, memories, clock/reset cells와 buffers가 logical cell area를 만들고, placement/routing에서는 whitespace, congestion, buffering와 wire resources까지 physical footprint에 영향을 준다.

> Area optimization은 RTL을 짧게 만드는 일이 아니라, requirement에 필요하지 않은 hardware를 제거하고 필요한 hardware의 width·state·structure를 evidence로 줄이는 일이다.

공통 PPA 용어는 [Canonical RTL Design Terminology](../01_fundamentals/terminology.md)를 따른다. Width/signedness의 기능 의미는 [Width and Signedness](../01_fundamentals/width_and_signedness.md), Architecture sharing 판단은 [Resource Sharing vs Duplication](../02_architecture/resource_sharing_vs_duplication.md)이 canonical하게 다룬다.

## 1. Area를 구성하는 것

### Sequential state

- Payload/config/control FF bits
- Resettable, enable-capable 또는 retention-related cell 선택
- Pipeline, FIFO와 shadow state
- Clock/reset distribution loads

### Combinational logic

- Add/subtract/multiply/shift/compare
- MUX, priority, decoder와 arbitration
- Saturation/rounding/error detection
- Enable, isolation와 clock-gating control

### Memory and macros

- Register arrays versus inferred/instantiated memories
- Ports, byte enables, ECC/parity와 output registers
- Macro boundary/interface logic

Storage shape와 mapping 판단은 [Memory and Register Array](memory_and_register_array.md)에서 자세히 다룬다.

### Implementation overhead

- High-fanout buffers and replication
- Hold/setup fixing cells
- Tie/constant/isolation/level-related cells where applicable
- Clock/reset tree cells
- Routing detours, congestion relief and placement whitespace

RTL statement만 세면 마지막 두 범주를 놓친다.

## 2. Logical Cell Area와 Physical Footprint

```text
RTL
  ↓ synthesis
mapped cells + estimated interconnect
  ↓ placement / clock / routing
physical footprint + buffers + congestion + wiring
```

### Logical area

Mapped library cells 또는 macro area의 합과 같은 synthesis/implementation report metric이다. Report 단위와 포함 범위는 tool/flow에 따라 다를 수 있다.

### Physical footprint

실제 placement region은 cell area뿐 아니라 utilization target, routing channels, macro keepout, power/clock distribution와 congestion을 포함한다. Logical cell area가 줄어도 remaining cells가 멀리 퍼지거나 congestion이 악화되면 block footprint가 같은 비율로 줄지 않을 수 있다.

### 왜 둘을 함께 봐야 하는가

- Sharing으로 operators는 줄었지만 central MUX/routes가 congestion을 만들 수 있다.
- Duplication으로 cell area는 늘어도 local routing과 buffering이 줄 수 있다.
- Reset 제거로 resettable cells/tree load가 줄 가능성이 있지만 placement effect는 flow에 의존한다.
- Width 축소는 FF/operator뿐 아니라 bus routing과 buffer loads에 영향을 줄 수 있다.

## 3. Optimization 순서

```text
Remove
  → Disable / Simplify
  → Width / State / Reset review
  → Share or Duplicate as appropriate
  → Pipeline or valid multi-cycle architecture only if required
  → Physical feedback
```

### 3.1 Remove

가장 좋은 area 절감 후보는 필요 없는 hardware다.

- Unused output/mode/feature
- Never-observed register or derived flag
- Redundant duplicate calculation
- Unreachable state after requirement review
- Over-buffering or unneeded queue entry
- Reset value that has no functional observer

Tool dead-code elimination만 기대하지 않는다. Top-level visibility, debug/test observation, attributes 또는 partial assignments 때문에 logic이 남을 수 있다. 제거 전 requirement와 observability를 확인한다.

### 3.2 Disable

Disable은 주로 switching을 줄인다. Register enable이나 operand isolation을 추가하면 MUX/control FF가 늘어 area가 증가할 수도 있다. 그러나 inactive modes를 protocol로 분리하면 unused calculations/state를 제거하거나 smaller shared structure로 단순화할 기회가 생길 수 있다.

Power 기법의 canonical trade-off는 [Low-Power RTL Design](../04_low_power/overview.md)을 참고한다.

### 3.3 Simplify

- Range에 맞는 width
- Constant propagation과 unreachable branch 제거
- Priority/fan-in 감소
- Arithmetic identity와 compare simplification
- Stored derived state 대신 필요 시 재계산, timing이 허용할 때
- General operator 대신 requirement-specific structure

Finite width, signedness, overflow와 side effect를 보존해야 한다. “수학적으로 같다”와 “RTL bit behavior가 같다”는 별도 검증 대상이다.

### 3.4 Width, State와 Reset

Register 한 bit는 FF 하나만의 문제가 아니다. 그 bit를 갱신/비교/select/route/reset하는 cone도 함께 커질 수 있다.

- Inclusive maximum과 legal range
- Transaction payload versus persistent state
- Extra wrap/version/parity bit의 protocol 의미
- Reset required control versus invalid-masked payload
- Shadow/cache/duplicate state coherency

Width 산출은 [Bit-Width Minimization](bit_width_minimization.md), state lifetime은 [State Partitioning and Ownership](../02_architecture/state_partitioning_and_ownership.md), reset-specific cost는 [Reset Area Cost](reset_area_cost.md)를 참고한다.

### 3.5 Share or Duplicate

Sharing은 operator를 줄일 수 있지만 MUX, arbiter, queue, owner/tag와 long routing을 추가한다. Duplication은 cell area를 늘리지만 latency/II, fanout와 locality를 개선할 수 있다.

Area 비교 boundary에 다음을 모두 넣는다.

- Operators
- Input/output MUX
- Arbitration/tag/storage
- Ready/valid/queue logic
- Buffers/replication and clock/reset loads
- Required throughput/latency

### 3.6 Pipeline과 multi-cycle architecture

Pipeline은 timing을 개선할 수 있지만 payload/control FF, clock power와 reset/flush state가 증가한다. MCP constraint 자체는 hardware area를 줄이지 않는다. Resource reuse가 있는 실제 multi-cycle architecture라면 operator가 줄 가능성이 있지만 scheduler, storage와 II 비용이 생긴다.

### 3.7 Physical feedback

Logical area 최적화 뒤에도 다음을 확인한다.

- Utilization and congestion hotspots
- Buffer/replica count
- Long routes and macro crossings
- Clock/reset distribution
- Post-route timing/power regressions
- Footprint 또는 floorplan constraint 변화

## 4. Worked Example: Counter Cone 전체를 본다

Requirement가 `0..100`의 inclusive count와 terminal compare만 요구한다고 하자.

관성적인 후보:

```systemverilog
logic [31:0] count_q;
logic [31:0] count_next;

assign count_next = count_q + 32'd1;
assign done       = (count_q == 32'd100);
```

Range-driven 후보의 핵심 width는 7-bit다. 상세 parameter guard와 boundary RTL은 [Bit-Width Minimization](bit_width_minimization.md)에서 다룬다.

```systemverilog
logic [6:0] count_q;
logic [6:0] count_next;

assign count_next = count_q + 7'd1;
assign done       = (count_q == 7'd100);
```

예상되는 구조 변화:

- Count FF: 32 → 7 bits
- Incrementer width 감소 가능
- Equality comparator width 감소 가능
- Count bus MUX/buffer/routing load 감소 가능
- Reset/enable loads 감소 가능

그러나 `count_q`가 다른 32-bit interface에 연결되거나 wrap/saturation/error contract가 있다면 extension/conversion logic과 protocol을 포함해 봐야 한다. Area 절감량은 library, mapping, fanout와 physical implementation으로 확인한다.

## 5. Unused Logic와 Register 제거

Observer, authoritative state와 cone 제거 proof의 상세 절차는 [Unused Logic and State Reduction](unused_logic_and_state_reduction.md)을 따른다.

### 관찰 가능성을 확인한다

Signal이 local RTL에서 읽히지 않아도 다음이 observer일 수 있다.

- Module output/status
- Assertion/coverage/test hook
- Scan/debug requirement
- Clock/reset/power control
- Constraint or CDC boundary

실제 기능 observer가 없다면 제거 후보지만, verification-only observer와 product function을 구분한다.

### Derived state를 저장할지 계산할지

```text
source state ── decode ──> derived flag
```

Derived flag FF를 제거하고 combinational 재계산하면 FF는 줄지만 decode timing/fanout/switching이 늘 수 있다. 반대로 flag를 register하면 area/clock load가 늘지만 late path를 줄일 수 있다. 사용 빈도, fanout와 stage budget으로 결정한다.

## 6. Reset Cost

모든 register가 reset 값을 가져야 하는 것은 아니다. Valid/control이 invalid payload를 완전히 mask하고 test/safety requirement가 허용하면 wide payload FF를 resetless로 둘 후보가 있다.

Reset이 area에 영향을 주는 경로:

- Resettable cell variant
- Reset MUX or control logic
- Reset tree buffers/routing
- Fanout/congestion
- Retiming/inference freedom 제한 가능성

반대로 architecturally visible state, protocol valid, safety recovery 또는 clock-stop 조건에 reset이 필수일 수 있다. Reset 제거는 area trick이 아니라 state contract 변경이므로 dedicated review가 필요하다. Area trade-off는 [Reset Area Cost](reset_area_cost.md), broader reset architecture는 [Reset Architecture Overview](../07_reset/overview.md), stage-level 적용은 [Pipeline Reset Strategy](../03_timing/pipeline.md#9-reset-strategy)을 참고한다.

## 7. FSM과 Counter Encoding

Encoding은 state FF 수만 비교하지 않는다.

| Encoding/structure | State bits | Decode/next-state | Physical/timing concern |
|---|---:|---|---|
| Binary counter/FSM | 적은 bits 가능 | decode depth 증가 가능 | compact state, fanout decode |
| One-hot FSM | state bits 증가 | local decode 단순 가능 | clock/reset load 증가 |
| Gray-like transition | application-specific | transition decode | CDC pointer 등 protocol 의미 |

FSM encoding은 state count, transition topology, target cells, timing, power, illegal-state recovery와 verification에 따라 달라진다. Gray는 arbitrary FSM area 최적화 규칙이 아니다.

Encoding과 counter boundary를 비교하는 절차는 [FSM and Counter Encoding](fsm_counter_encoding.md)을 따른다.

## 8. Enable와 MUX Overhead

Conditional register update는 hold feedback, enable-capable FF 또는 clock-gating inference 후보가 될 수 있다. “Update를 줄였다”가 area 감소를 뜻하지 않는다.

추가될 수 있는 구조:

- Enable decode
- Feedback MUX
- Enable/control FF
- High-fanout buffers
- ICG/test logic where applicable

작은 register bank에서는 overhead가 saved activity보다 클 수 있다. Enable의 canonical 의미는 [Register Enable](../04_low_power/register_enable.md)을 참고한다.

## 9. Synthesis Report를 읽는 법

### Before/after 조건

- Same top/hierarchy and black boxes
- Same clocks/constraints/modes/corners
- Same parameter/configuration
- Same memory/macro mapping assumptions
- Same optimization boundary

### Breakdown

- Sequential bits/cell types
- Combinational area by operator/MUX/decode
- Macro/memory area
- Buffer/inverter/tie cells
- Clock/reset or low-power cells, report가 구분할 수 있는 범위

### Netlist inspection

- Width가 예상대로 줄었는가?
- Tool이 operator를 다시 duplicate/share했는가?
- Removed state cone이 실제로 사라졌는가?
- New enable/MUX/buffer가 절감을 상쇄했는가?
- Constant propagation이 configuration에만 의존한 것은 아닌가?

## 10. Physical Area와 Congestion Evidence

Logical cell area가 줄었는데 physical block이 줄지 않을 수 있다.

```text
cell area reduction
  ├─ may reduce utilization
  ├─ may reduce congestion/buffering
  └─ may be hidden by fixed macro/floorplan/routing constraints
```

확인할 evidence:

- Core/block footprint and utilization
- Congestion map/hotspots
- Buffer/replica counts
- Wirelength or route detours, flow가 제공하는 범위
- Timing closure effort and cell upsizing
- Macro/channel constraints

Physical data가 없을 때는 “cell area 감소 후보”라고 조건부로 표현한다.

Placed/routed footprint, sharing/locality와 congestion evidence는 [Physical Area and Congestion](physical_area_and_congestion.md)에서 자세히 다룬다.

## 11. Timing, Power, Verification Trade-off

| Area action | Timing risk/opportunity | Power | Verification/maintainability |
|---|---|---|---|
| Width 축소 | shorter operators/routes 가능 | capacitance 감소 가능 | boundary/overflow proof |
| State 제거 | cone 단순화 가능 | clock/data activity 감소 | observability/equivalence |
| Reset 제거 | reset path/fanout 감소 가능 | reset activity 감소 | X/safety/test contract |
| Sharing | MUX/arbitration timing 악화 가능 | central switching | fairness/II/state |
| Encoding 변경 | decode/critical path 변화 | transition activity 변화 | illegal-state/equivalence |
| Pipeline 제거 | FF 감소 | clock power 감소 | timing/latency 영향 |

Area 하나만 pass하고 timing, power 또는 function이 regress하면 전체 최적화가 아니다.

## 12. 적용하면 안 되는 경우

- Required overflow/extra-wrap/version bit를 “unused MSB”로 제거하는 경우
- Timing-critical registered decode를 area 때문에 combinational로 되돌리는 경우
- Throughput requirement를 무시하고 operators를 공유하는 경우
- Safety/test/reset requirement 없이 reset을 제거했다고 가정하는 경우
- Async FIFO pointer width를 일반 counter처럼 줄이는 경우
- Pre-layout cell area만 보고 physical footprint 절감을 확정하는 경우
- Area report boundary가 다른 후보를 직접 비교하는 경우

## 13. Common Mistakes

### RTL line count를 줄인다

Loop/function/ternary 한 줄이 많은 operators와 MUX를 만들 수 있다.

### Operator 개수만 줄인다

Sharing MUX, arbitration, queue, fanout와 II 비용을 제외한다.

### 모든 logic을 공유한다

Timing/locality/throughput을 악화시키고 physical buffering을 늘릴 수 있다.

### Reset 제거는 항상 area 절감이라고 한다

Functional/test/safety requirement와 actual cell mapping을 확인하지 않는다.

### FF bits만 센다

Incrementer, comparator, MUX, routing와 clock/reset loads를 놓친다.

### Synthesis area 감소를 die/block 축소로 바로 환산한다

Macro, routing, congestion와 floorplan constraints가 빠져 있다.

## 14. Verification Strategy

### Functional proof

- Removed state/logic의 observer가 없는지
- Width range와 overflow policy
- Encoding change의 legal/illegal state behavior
- Sharing change의 no-drop/order/fairness
- Reset removal 뒤 valid/X discipline

### Equivalence

Latency/state mapping이 같으면 combinational/sequential equivalence를 검토한다. Latency, encoding 또는 resource schedule이 바뀌면 transaction-level invariants와 allowed mapping을 명시한다.

### PPA regression

- Same constraints/configuration reports
- New critical path/hold check
- Representative activity power
- Cell/macro/buffer breakdown
- Post-placement footprint/congestion

## 15. Area Design Review Checklist

### Requirement와 removal

- [ ] 모든 state/feature/output의 observer가 있는가?
- [ ] Unused mode, register, derived flag와 duplicate calculation을 제거할 수 있는가?
- [ ] Remove가 debug/test/safety/constraint contract를 깨지 않는가?

### Width/state/reset

- [ ] Range에서 width를 계산하고 boundary를 증명했는가?
- [ ] Extra wrap/version/parity bit의 protocol 의미를 보존했는가?
- [ ] Persistent, in-flight, derived와 payload state lifetime을 구분했는가?
- [ ] Reset이 필요한 state와 valid로 mask되는 payload를 구분했는가?

### Structure와 evidence

- [ ] Sharing의 MUX/arbiter/storage/II 비용을 포함했는가?
- [ ] Encoding/enable 변경의 decode/MUX/fanout 비용을 포함했는가?
- [ ] Same boundary/constraint/configuration에서 report를 비교했는가?
- [ ] Sequential/operator/MUX/buffer/macro breakdown을 확인했는가?
- [ ] Timing, power, verification와 maintainability regression이 없는가?
- [ ] Physical footprint, utilization와 congestion evidence가 있는가?

## 관련 문서

- [Bit-Width Minimization](bit_width_minimization.md)
- [Unused Logic and State Reduction](unused_logic_and_state_reduction.md)
- [Reset Area Cost](reset_area_cost.md)
- [FSM and Counter Encoding](fsm_counter_encoding.md)
- [Memory and Register Array](memory_and_register_array.md)
- [Physical Area and Congestion](physical_area_and_congestion.md)
- [Width and Signedness](../01_fundamentals/width_and_signedness.md)
- [State Partitioning and Ownership](../02_architecture/state_partitioning_and_ownership.md)
- [Resource Sharing vs Duplication](../02_architecture/resource_sharing_vs_duplication.md)
- [Low-Power RTL Design](../04_low_power/overview.md)
- [RTL Design Review Checklist](../15_checklist/rtl_design_review_checklist.md)
