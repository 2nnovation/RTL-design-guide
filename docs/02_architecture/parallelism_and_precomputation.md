# Parallelism and Pre-computation

Critical operation 앞에 late select가 있으면 `select → MUX → expensive calculation`이 한 timing path에 이어질 수 있다. 가능한 결과를 미리 병렬 계산하고 마지막에 선택하면 select가 늦어도 operator 계산을 앞당길 수 있다. 대신 operator duplication, speculative switching, wider routing와 final MUX 비용을 지불한다.

> Pre-computation은 계산을 공짜로 빠르게 만드는 기법이 아니다. 아직 선택되지 않은 후보를 먼저 계산하고, architectural commit은 valid한 선택 결과 하나에만 허용하는 trade-off다.

이 문서는 계산을 **언제, 몇 개, select의 어느 쪽에서** 수행할지를 다룬다. Resource 수와 arbitration의 전체 선택은 [Resource Sharing vs Duplication](resource_sharing_vs_duplication.md), pipeline stage 구현은 [Pipeline Design](../03_timing/pipeline.md), MUX/priority semantics는 [Priority and MUX](../01_fundamentals/priority_and_mux.md)가 authoritative responsibility를 가진다.

## 1. 세 가지 Parallelism을 구분한다

### Spatial parallelism

같은 cycle에 여러 operator 또는 lane이 서로 다른 work를 수행한다.

```text
input 0 ─> operator 0 ─> result 0
input 1 ─> operator 1 ─> result 1
```

동시 throughput이나 late-select timing을 개선할 수 있지만 logic, routing와 switching이 증가한다.

### Temporal parallelism / pipelining

하나의 transaction work를 stage로 나누고 여러 transaction이 다른 stage에 동시에 존재하게 한다.

```text
cycle 0: A stage 0
cycle 1: A stage 1, B stage 0
cycle 2: A output, B stage 1, C stage 0
```

Operator를 완전히 복제하지 않고 II를 개선할 수 있지만 latency, FF와 control alignment 비용이 있다.

### Speculative or pre-computation

Select 또는 condition이 확정되기 전에 여러 candidate result를 계산한다.

```text
candidate inputs ─┬─> expensive F0 ─┐
                  └─> expensive F1 ─┼─> final select ─> committed result
late select ─────────────────────────┘
```

필요 없는 candidate도 toggle할 수 있다. 계산 결과가 존재한다는 사실과 architectural effect가 commit됐다는 사실을 구분해야 한다.

## 2. Select 전후의 Operator 위치

다음 두 구조는 순수 combinational function 관점에서 같은 결과를 만들 수 있다.

### Select then calculate

```text
a/c ── MUX ──┐
              ├─ adder ─> result
b/d ── MUX ──┘
       ▲
     select
```

예상 비용:

- Adder 한 개
- 두 operand MUX
- Select arrival + MUX + adder path

### Calculate then select

```text
a,b ── adder 0 ──┐
                  ├─ result MUX ─> result
c,d ── adder 1 ──┘       ▲
                       select
```

예상 비용:

- Adder 두 개
- Result MUX 한 개
- Data path는 adder + MUX, late select path는 final MUX 중심

두 번째 구조가 항상 빠른 것은 아니다. Result MUX가 wide하고 두 adders가 멀리 배치되거나 congestion이 커지면 net delay가 이득을 상쇄할 수 있다. Synthesis가 Boolean/arithmetic equivalence와 constraints에 따라 구조를 다시 바꿀 수도 있으므로 mapped netlist와 timing report를 확인한다.

## 3. Select Arrival Time이 핵심인 이유

Data와 select가 같은 시점에 도착한다고 가정하지 않는다.

```text
time ─────────────────────────────────────────────>

candidate data available       early
select available                              late
capture deadline                                  |
```

Select가 state decode, arbitration, tag lookup 또는 long control fanout 뒤에 나오면 shared-path operator는 늦게 시작한다. Parallel pre-computation은 select와 독립적인 operator work를 먼저 시작하고 마지막 MUX만 select를 기다리게 할 수 있다.

반대로 select가 일찍 안정되고 operands가 늦다면 parallelization의 timing 이득이 작을 수 있다. Critical path report에서 data arrival와 select arrival를 분리해 본다.

## 4. 동일한 1-Cycle Contract 비교

다음 두 RTL 후보는 같은 interface contract를 구현한다.

- E0: `in_valid` transaction의 operands와 `sel` capture
- E1: 선택된 unsigned sum과 `out_valid` capture
- `sel == 0`: `{1'b0, a} + {1'b0, b}`
- `sel == 1`: `{1'b0, c} + {1'b0, d}`
- Latency: accept E0 → output valid E1
- II: 1, stall 없는 pipeline
- Reset은 valid state를 clear하고 invalid payload는 관찰하지 않음

```text
edge                    E0          E1          E2
accepted transaction     A           B
captured input/select    A           B
output result/valid                  A           B
```

### 4.1 Select then calculate: shared-path candidate

```systemverilog
module select_then_add (
    input  logic       clk,
    input  logic       rst_n,
    input  logic       in_valid,
    input  logic       in_sel,
    input  logic [7:0] in_a,
    input  logic [7:0] in_b,
    input  logic [7:0] in_c,
    input  logic [7:0] in_d,
    output logic       out_valid,
    output logic [8:0] out_sum
);
    logic       valid_input_q;
    logic       sel_input_q;
    logic [7:0] a_input_q;
    logic [7:0] b_input_q;
    logic [7:0] c_input_q;
    logic [7:0] d_input_q;
    logic [7:0] selected_lhs;
    logic [7:0] selected_rhs;
    logic [8:0] shared_sum;

    always_comb begin
        selected_lhs = sel_input_q ? c_input_q : a_input_q;
        selected_rhs = sel_input_q ? d_input_q : b_input_q;
        shared_sum   = {1'b0, selected_lhs} + {1'b0, selected_rhs};
    end

    // Event priority: reset discards in-flight validity;
    // otherwise the input and output stages advance every cycle.
    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            valid_input_q <= 1'b0;
            out_valid     <= 1'b0;
        end else begin
            valid_input_q <= in_valid;
            out_valid     <= valid_input_q;

            if (in_valid) begin
                sel_input_q <= in_sel;
                a_input_q   <= in_a;
                b_input_q   <= in_b;
                c_input_q   <= in_c;
                d_input_q   <= in_d;
            end

            if (valid_input_q)
                out_sum <= shared_sum;
        end
    end
endmodule
```

### 4.2 Calculate then select: parallel pre-computation candidate

```systemverilog
module parallel_add_then_select (
    input  logic       clk,
    input  logic       rst_n,
    input  logic       in_valid,
    input  logic       in_sel,
    input  logic [7:0] in_a,
    input  logic [7:0] in_b,
    input  logic [7:0] in_c,
    input  logic [7:0] in_d,
    output logic       out_valid,
    output logic [8:0] out_sum
);
    logic       valid_input_q;
    logic       sel_input_q;
    logic [7:0] a_input_q;
    logic [7:0] b_input_q;
    logic [7:0] c_input_q;
    logic [7:0] d_input_q;
    logic [8:0] sum_ab;
    logic [8:0] sum_cd;
    logic [8:0] selected_sum;

    always_comb begin
        sum_ab       = {1'b0, a_input_q} + {1'b0, b_input_q};
        sum_cd       = {1'b0, c_input_q} + {1'b0, d_input_q};
        selected_sum = sel_input_q ? sum_cd : sum_ab;
    end

    // Event priority: reset discards in-flight validity;
    // otherwise the input and output stages advance every cycle.
    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            valid_input_q <= 1'b0;
            out_valid     <= 1'b0;
        end else begin
            valid_input_q <= in_valid;
            out_valid     <= valid_input_q;

            if (in_valid) begin
                sel_input_q <= in_sel;
                a_input_q   <= in_a;
                b_input_q   <= in_b;
                c_input_q   <= in_c;
                d_input_q   <= in_d;
            end

            if (valid_input_q)
                out_sum <= selected_sum;
        end
    end
endmodule
```

두 후보 모두 operands를 9-bit로 확장한 뒤 더해 carry를 보존하고, signedness는 unsigned로 동일하다. `sel_input_q`는 operands와 E0에서 capture되어 transaction A의 select가 A의 result에 적용된다. Nonblocking assignment 때문에 E1 output은 E0에 capture한 input state를 읽는다.

코드 모양만으로 adder 개수를 보장하지 않는다. Tool은 function, hierarchy, constraints와 optimization settings에 따라 공유 또는 복제를 선택할 수 있다. 이 문서의 구조는 architecture 후보이며 실제 mapping을 report/netlist로 확인한다.

## 5. Architectural Commit과 Speculative Result

Parallel candidate에서는 `sum_ab`와 `sum_cd`가 모두 계산되지만 architectural output은 `sel_input_q`가 고른 하나뿐이다.

```text
speculative candidates: sum_ab, sum_cd
commit condition:        valid_input_q && selected branch
architectural state:     out_sum when out_valid=1
```

사용되지 않은 candidate는 다음을 일으키면 안 된다.

- Memory write 또는 external request
- Counter/credit/state update
- Interrupt/error report
- Exception/flag commit
- Unselected destination valid

Candidate 계산이 pure combinational이어도 overflow, exception 또는 error flag가 있다면 **selected branch의 flag만** output transaction에 commit해야 한다. 두 branch의 flag를 OR하면 선택되지 않은 speculative operation이 architectural behavior를 바꾼다.

## 6. Mutually Exclusive Branch와 Wasted Computation

Branch가 functional하게 mutually exclusive여도 parallel implementation에서는 두 operators가 동시에 toggle할 수 있다.

```text
functionally selected: one branch
physically evaluated:  one or more branches, depending on structure
```

검토할 선택:

- Late-select timing이 중요하면 parallel evaluation 유지
- Power가 중요하고 select가 충분히 일찍 오면 selected operand만 operator에 전달
- Branch별 local register enable 또는 operand isolation
- Constant branch는 operator 대신 constant/간단한 logic으로 precompute
- Rare branch를 shared slower path로 분리하고 latency contract를 variable하게 만들지 검토

Operand isolation은 switching을 줄일 수 있지만 MUX/control delay와 fanout 비용이 있다. 자세한 조건은 [Operand Isolation](../04_low_power/operand_isolation.md)을 참고한다.

## 7. Constant와 Cheap Case를 먼저 본다

모든 branch에 expensive operator가 필요한지 확인한다.

```text
if mode 0: y = x + 0       → pass-through candidate
if mode 1: y = x + K       → constant adder candidate
if mode 2: y = expensive_f(x)
```

Constant propagation이나 algebraic simplification으로 branch를 제거할 수 있다면 full operator duplication보다 먼저 적용한다. 다만 finite width와 overflow semantics를 보존해야 한다.

Pre-computation 후보:

- 다음 state에서 사용할 small decode
- Constant compare 결과 또는 one-hot select
- Both polarities / increment-decrement candidates
- Address 후보와 boundary check
- Rounding/saturation 후보, numeric equivalence가 명확한 경우

## 8. Locality, Fanout와 MUX Position

### Input MUX position

Shared operator 앞의 wide MUX는 여러 distant sources를 central point로 모은다. Operand width와 physical span이 크면 routing/capacitance가 증가할 수 있다.

### Output MUX position

Parallel operators 뒤의 result MUX는 outputs를 모은다. Operators를 consumer 근처에 둘 수 있는지, final MUX가 중앙 bottleneck이 되는지 본다.

### Select fanout

하나의 late select가 많은 local MUX를 구동하면 fanout가 커진다. Select를 local register/duplicate decode로 분배하면 timing을 개선할 수 있지만 state alignment와 area가 늘 수 있다.

### Reconvergence

Parallel candidates가 final MUX에서 reconverge하면 arrival imbalance와 glitch가 생길 수 있다. RTL activity만으로 internal glitch와 routed capacitance를 충분히 예측하기 어렵다.

Physical 결론은 placement, congestion, fanout와 post-route timing/power report로 확인한다.

## 9. Temporal Pipeline과 결합하기

Parallel pre-computation도 timing을 만족하지 못하면 candidates와 final select 사이에 register를 둘 수 있다.

```text
input ─> parallel operators ─> candidate FF ─> final MUX ─> output FF
select/tag ──────────────────> aligned FF ────────┘
```

이때 latency가 증가하고 candidate width만큼 FF가 추가된다. `select`, valid, tag, error와 cancellation state를 candidate FF와 같은 cycle 수로 이동해야 한다. Stall/flush 시 모든 candidate/control state가 함께 hold 또는 invalidate되어야 한다.

Latency를 바꿀 수 없다면 parallelization, faster/local structure, operator simplification과 timing budget 재배분을 비교한다. MCP는 candidate 계산을 앞당기거나 operator를 복제하지 않는다.

## 10. Synthesis, STA와 Physical View

### Synthesis

확인할 구조:

- Shared candidate의 operand MUX와 inferred operator 수
- Parallel candidate의 operator duplication 여부
- Constant folding과 common subexpression sharing
- Output MUX width/depth와 valid/control registers
- Timing-driven replication 또는 optimization boundary

### STA

Shared path:

```text
input/select FF → operand MUX → operator → result FF
```

Parallel path:

```text
input FF → operator → result MUX → result FF
select FF ────────────────> result MUX → result FF
```

Data와 select arrival 중 어느 path가 critical인지 확인한다. Operator duplication 뒤 select path가 여전히 worst라면 early decode/register 또는 MUX structure가 문제일 수 있다.

### Physical

Operators, input sources, final MUX와 consumer 위치를 함께 본다. Logical depth 감소가 longer routes와 congestion으로 상쇄될 수 있다. Pre-layout 합성 이득은 post-route sign-off를 대신하지 않는다.

## 11. Timing, Power, Area Trade-off

| 구조 | Timing | Power | Area | Latency/II |
|---|---|---|---|---|
| Select then calculate | late select가 operator 시작을 늦출 수 있음 | selected path 중심 activity 가능 | operator 감소, input MUX | same contract 가능 |
| Parallel precompute | operator work를 select보다 먼저 시작 가능 | unselected candidate switching | operator 복제, result MUX | same contract 가능 |
| Parallel + operand isolation | control/MUX path 추가 | inactive branch activity 감소 가능 | isolation logic | control arrival에 의존 |
| Pipelined candidates | stage timing 개선 가능 | candidate FF clock activity | wide FF/control 증가 | latency 증가, II 유지 가능 |
| Multiple full lanes | throughput/locality 개선 가능 | lane activity/clock 증가 | logic/state 복제 | aggregate throughput 증가 가능 |

어느 효과도 절대적이지 않다. Width, operator mapping, activity correlation, select arrival, floorplan과 target clock에 따라 결과가 달라진다.

## 12. 적용하면 안 되는 경우

- Unselected branch가 memory write나 state update 같은 side effect를 일으키는 경우
- Exception/error를 selected branch로 mask하지 않는 경우
- Operator area/leakage/clock power가 budget을 초과하는 경우
- Select가 이미 일찍 도착하고 shared structure가 timing을 만족하는 경우
- Final output/memory port가 bottleneck이라 duplication이 throughput을 늘리지 못하는 경우
- Candidate computation의 numeric order가 원래 function과 동등하지 않은 경우
- Physical congestion이 심한데 report 없이 operator를 대량 복제하는 경우
- Security/safety requirement상 speculative evaluation 자체가 제한되는 경우

## 13. Common Mistakes

### `if` branch가 exclusive이므로 한 branch만 toggle한다고 가정한다

Synthesized parallel candidates는 selected되지 않아도 input 변화에 따라 switching할 수 있다.

### Operator duplication만 보고 timing 개선을 단정한다

Final MUX, select fanout와 routing이 새 critical path가 될 수 있다.

### Data만 precompute하고 control을 현재 cycle에서 사용한다

Candidate A data에 transaction B의 select/tag가 적용된다.

### Speculative flag를 모두 OR한다

Unselected branch의 overflow/error가 architectural output에 노출된다.

### Sharing 문서와 같은 결정을 중복한다

Resource sharing/duplication은 service capacity와 arbitration boundary를 정한다. 이 문서는 late select 주변의 calculation placement와 speculative commit을 판단한다.

### RTL expression이 netlist topology를 보장한다고 생각한다

Tool과 constraints에 따라 factoring, sharing 또는 replication이 달라질 수 있다.

## 14. Verification Strategy

### Functional equivalence

두 후보에 동일한 accepted transaction stream을 넣고 같은 E1 output-valid slot에서 result를 비교한다.

```text
expected = sel ? (zero_extend(c) + zero_extend(d))
               : (zero_extend(a) + zero_extend(b))
```

검증 항목:

- `sel=0/1`의 min/max operands와 carry
- Back-to-back transaction에서 alternating select
- Bubble과 reset 직전/직후 valid
- Invalid payload가 consumer에 commit되지 않는지
- Selected result와 selected overflow/error flag가 함께 이동하는지
- Pipeline/stall을 추가했다면 모든 candidates와 control이 함께 hold되는지

### Example properties

```systemverilog
ap_one_cycle_valid:
    assert property (@(posedge clk) disable iff (!rst_n)
        in_valid |-> ##1 out_valid
    );

ap_no_spurious_commit:
    assert property (@(posedge clk) disable iff (!rst_n)
        !out_valid |-> !architectural_write_enable
    );
```

두 번째 property의 `architectural_write_enable`은 integration 환경의 실제 side-effect signal로 바꿔야 한다. 예시는 speculative calculation과 commit을 분리하는 의도를 보여준다.

### Implementation evidence

- Mapped operator 수와 MUX 위치
- Data/select path arrival breakdown
- Activity에서 unselected candidate toggle
- Post-route locality, fanout와 congestion
- Same contract에서 timing/power/area comparison

## 15. Design Review Checklist

### Requirement와 function

- [ ] Latency, II와 output commit event가 고정됐는가?
- [ ] Branches가 mutually exclusive인지, 동시에 계산만 가능한지 구분했는가?
- [ ] Precompute transformation이 finite-width numeric behavior를 보존하는가?
- [ ] Unselected exception/side effect가 architecturally mask되는가?

### Structure

- [ ] Select와 operands의 actual arrival time을 확인했는가?
- [ ] Input MUX + operator와 operators + result MUX를 비교했는가?
- [ ] Data, valid, select, tag와 flags가 같은 transaction으로 정렬되는가?
- [ ] Shared downstream port 또는 final merge bottleneck이 없는가?
- [ ] Operator/MUX의 physical locality와 select fanout를 검토했는가?

### PPA와 evidence

- [ ] Unselected candidate switching을 representative workload로 측정했는가?
- [ ] Operand isolation의 control timing과 area 비용을 포함했는가?
- [ ] Synthesis가 예상 operator sharing/duplication을 만들었는가?
- [ ] STA에서 data path와 late-select path를 따로 확인했는가?
- [ ] Post-route congestion/net delay가 timing 이득을 유지하는가?
- [ ] 같은 interface contract에서 power/area를 비교했는가?

### Verification

- [ ] Shared와 parallel 후보가 transaction-level equivalent한가?
- [ ] Back-to-back alternating select와 bubbles를 검증했는가?
- [ ] Reset/flush/stall에서 speculative candidates가 commit되지 않는가?
- [ ] Selected result와 error/control이 함께 commit되는가?

## 관련 문서

- [Resource Sharing vs Duplication](resource_sharing_vs_duplication.md)
- [Feedback Dependency](feedback_dependency.md)
- [Architectural Timing Budget](architectural_timing_budget.md)
- [Priority and MUX](../01_fundamentals/priority_and_mux.md)
- [Pipeline Design](../03_timing/pipeline.md)
- [Critical Path](../03_timing/critical_path.md)
- [Operand Isolation](../04_low_power/operand_isolation.md)
- [Datapath Parallel Pre-computation](../10_datapath/parallel_precomputation.md)
