# Unused Logic and State Reduction

Unused hardware는 source에서 읽히지 않는 signal만 뜻하지 않는다. 어떤 state나 logic cone이 제거 가능한지는 functional, protocol, debug/test, clock/reset/power, CDC와 constraint observer가 존재하는지로 판단한다.

> Dead code elimination을 tool에 맡기는 것과 architecture에서 불필요한 state를 제거하는 것은 다르다. Observer와 reachability proof를 먼저 만든다.

State lifetime과 owner는 [State Partitioning and Ownership](../02_architecture/state_partitioning_and_ownership.md), 전체 area 순서는 [Area Design & Optimization](overview.md)이 담당한다. Constant propagation과 mapped dead-logic report의 해석은 [Constant and Dead Logic](../11_synthesis/constant_dead_logic.md)을 참고한다.

## 1. Observer와 Cone of Influence

```text
state / input
    ↓
logic cone ──> functional output
           ├─> next state
           ├─> protocol valid/ready/error
           ├─> clock/reset/power enable
           ├─> CDC source
           └─> debug/test/assertion/constraint observer
```

어떤 node가 모든 meaningful observer의 cone 밖에 있고 future state에도 영향을 주지 않는다면 removal 후보다.

Observer를 분류한다.

| Observer | 제거 전 확인 |
|---|---|
| Functional output/state | 정상·오류·mode에서 영향이 없는가? |
| Protocol | valid, ready, ordering, interrupt, retry에 영향이 없는가? |
| Debug/test/scan | product requirement인지 verification convenience인지? |
| Assertion/coverage | design function observer인지 proof instrument인지? |
| Clock/reset/power | gating, wake, retention, isolation control인가? |
| CDC/RDC | 다른 domain이 event/state를 관찰하는가? |
| Constraint | path endpoint 또는 exception assumption인가? |

Assertion이 signal을 읽는다는 이유만으로 hardware state가 반드시 필요한 것은 아니다. 반대로 synthesis에서 무시되는 assertion이라도 그 property가 표현하는 functional invariant는 보존해야 한다.

## 2. Compile-Time와 Runtime Unreachable

### Compile-time unreachable

Parameter/constant configuration에서 branch가 제거된다.

```systemverilog
if (FEATURE_EN)
    result = feature_result;
else
    result = base_result;
```

`FEATURE_EN`이 elaboration constant이면 inactive branch가 제거될 가능성이 있다. Configuration별로 필요한 hardware가 다르므로 report도 같은 parameter에서 비교한다.

### Runtime unreachable

FSM/state/input invariant 때문에 논리적으로 도달하지 않는 branch다. Simulation에서 한 번도 실행되지 않았다는 사실만으로 proof가 되지 않는다.

필요 evidence:

- Legal reset/start states
- Complete transition relation
- Environment assumptions
- Formal reachability 또는 exhaustive bounded reasoning
- Illegal state recovery contract

Runtime invariant를 synthesis don't-care로 활용하면 assumption이 깨질 때 hardware behavior가 달라질 수 있다. Verification과 constraint ownership이 필요하다.

## 3. Tool Dead-Code Removal과 Architectural Removal

Synthesis는 unused output cone, constant branch와 redundant Boolean logic을 제거할 수 있다. 그러나 다음 이유로 logic이 남을 수 있다.

- Module output/debug visibility
- `keep`류의 flow-specific preservation
- Separate compilation/hierarchy boundary
- Reset/test/scan observation
- Unknown parameter or mode input
- Logic이 next-state/enable에 간접 영향

Architectural removal은 requirement와 interface에서 feature/state 자체를 제거한다. 이는 더 큰 cone을 없앨 수 있지만 integration contract 변경이므로 review와 regression이 필요하다.

## 4. Stored Derived State

Source state에서 항상 계산 가능한 flag를 별도 FF로 저장하면 coherency와 update cost가 생긴다.

```text
payload_q ──> compare/decode ──> derived flag
     └──────── stored flag_q ──> consumer
```

Stored flag를 제거하면 FF/reset/enable은 줄 수 있지만 compare가 consumer timing path로 이동한다. Area만 보고 결정하지 않는다.

## 5. Before/After RTL Example

Contract:

- `load_valid`는 request이고 `load_accept = load_valid && load_ready`가 accepted event다.
- `load_ready = rst_n && !clear`이므로 reset/clear 동안 request를 수락하지 않는다.
- Event priority: reset → clear → load accept → hold.
- `payload_valid=0`이면 payload와 zero indication은 architecturally invalid다.

### Before: duplicated derived state

```systemverilog
module stored_derived_flag (
    input  logic       clk,
    input  logic       rst_n,
    input  logic       clear,
    input  logic       load_valid,
    input  logic [7:0] load_data,
    output logic       load_ready,
    output logic       payload_valid,
    output logic [7:0] payload,
    output logic       payload_is_zero
);
    logic [7:0] data_q;
    logic       zero_q;
    logic       load_accept;

    assign load_ready  = rst_n && !clear;
    assign load_accept = load_valid && load_ready;
    assign payload     = data_q;

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            payload_valid <= 1'b0;
        end else if (clear) begin
            payload_valid <= 1'b0;
        end else if (load_accept) begin
            data_q         <= load_data;
            zero_q         <= (load_data == 8'd0);
            payload_valid  <= 1'b1;
        end
    end

    assign payload_is_zero = payload_valid && zero_q;
endmodule
```

### After: derive from authoritative payload

```systemverilog
module derived_flag_removed (
    input  logic       clk,
    input  logic       rst_n,
    input  logic       clear,
    input  logic       load_valid,
    input  logic [7:0] load_data,
    output logic       load_ready,
    output logic       payload_valid,
    output logic [7:0] payload,
    output logic       payload_is_zero
);
    logic [7:0] data_q;
    logic       load_accept;

    assign load_ready      = rst_n && !clear;
    assign load_accept     = load_valid && load_ready;
    assign payload         = data_q;
    assign payload_is_zero = payload_valid && (data_q == 8'd0);

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            payload_valid <= 1'b0;
        end else if (clear) begin
            payload_valid <= 1'b0;
        end else if (load_accept) begin
            data_q        <= load_data;
            payload_valid <= 1'b1;
        end
    end
endmodule
```

Data payload는 valid로 mask되므로 reset하지 않는다. Clear와 request가 동시에 오면 `load_ready=0`이므로 새 payload는 accept되지 않는다. 이렇게 request와 accepted event를 분리해야 upstream이 같은 cycle의 request를 유지하거나 재시도할 수 있다.

### Cycle audit

```text
edge                         E0          E1          E2          E3
rst_n/clear/load_valid/data  1/0/1/0     1/1/1/5     1/0/1/5     0/0/1/9
load_ready/load_accept       1/1         0/0         1/1         0/0
valid after                  1           0           1           0
is_zero after                1           0           0           0
winning event                accept      clear       accept      reset
```

두 구현은 `payload_valid=1`인 observation에서 같은 `payload_is_zero`를 만든다. After 후보는 `zero_q`를 제거하지만 comparator가 output path에 존재한다.

## 6. Duplicated, Shadow와 Cached State

제거 후보를 구분한다.

- Exact duplicate: 같은 owner/event로 항상 같은 값
- Derived cache: source에서 재계산 가능하지만 timing용으로 저장
- Shadow state: atomic commit 전 programming state
- Replica: fanout/locality 또는 availability 목적

Shadow/replica를 “중복”이라고 제거하면 atomic update, fanout 또는 recovery contract를 깨뜨릴 수 있다. Authoritative source, version, invalidation과 observation point를 확인한다.

## 7. Redundant Mode와 Feature State

Mode bit가 다른 state 조합에서 완전히 유도 가능할 수 있다. 제거 전 질문:

- Illegal/transitional state에서 유도값은 무엇인가?
- Mode change가 atomic인가?
- Software/debug가 mode bit 자체를 읽는가?
- Clock/power/CDC control이 mode를 사용하지 않는가?
- Derived decode가 timing/fanout을 악화시키지 않는가?

FSM minimization도 state count만 줄이는 문제가 아니다. Encoding과 illegal recovery는 [FSM and Counter Encoding](fsm_counter_encoding.md)을 참고한다.

## 8. Synthesis, STA와 Physical View

### Synthesis

Before/after에서 FF count뿐 아니라 comparator, enable/reset MUX와 fanout을 확인한다. Tool이 `zero_q`를 이미 optimize하거나 comparator를 duplicate할 수 있으므로 netlist evidence가 필요하다.

### STA

Stored flag는 load-time compare path를 만들고 consumer에는 short FF path를 제공할 수 있다. Derived flag는 consumer compare path를 늘릴 수 있다. 어느 path가 critical한지 report로 판단한다.

### Physical

FF 한 bit 제거보다 global flag fanout, comparator locality와 buffering 영향이 클 수 있다. Replica 제거가 long route를 만들면 physical area/timing이 악화될 수 있다.

## 9. Timing, Power, Area Trade-off

| Action | Timing | Power | Area | Risk |
|---|---|---|---|---|
| Stored flag 제거 | consumer decode 증가 가능 | FF clock 감소, compare activity 증가 | FF/control 감소 가능 | observer/coherency |
| Unreachable mode 제거 | cone 단순화 | inactive logic 제거 | state/logic 감소 | reachability assumption |
| Replica 제거 | fanout/route 악화 가능 | central net activity | cells 감소 | locality |
| Cached state 제거 | recompute path 증가 | recompute switching | FF 감소 | latency |

## 10. 적용하면 안 되는 경우

- Debug/test/safety observer를 product-unused로 오인하는 경우
- Coverage가 없다는 이유만으로 runtime branch를 제거하는 경우
- Registered derived flag가 timing contract 일부인데 combinational화하는 경우
- Shadow state의 atomic commit 의미를 무시하는 경우
- Clock/wake/CDC source state를 local functional cone만 보고 제거하는 경우
- Illegal state recovery를 unreachable assumption으로 삭제하는 경우

## 11. Common Mistakes

- Synthesis가 제거했으니 architecture proof도 끝났다고 생각한다.
- Simulation coverage 0을 reachability proof로 사용한다.
- FF bit만 비교하고 added comparator/fanout을 제외한다.
- Valid가 0인 payload 값을 formal에서 과도하게 constraint한다.
- Duplicate state의 authoritative owner와 change trigger를 기록하지 않는다.

## 12. Verification Strategy

- Cone-of-influence review: 모든 functional/protocol/domain observers 열거
- Formal reachability: alleged unreachable state/branch
- Equivalence: valid observation window에서 before/after 비교
- Reset/clear/load simultaneous priority
- Mode/config transition과 illegal state injection
- Synthesis netlist에서 intended cone removal 확인

```systemverilog
ap_invalid_masks_zero:
    assert property (@(posedge clk) disable iff (!rst_n)
        !payload_valid |-> !payload_is_zero
    );
```

Derived-state removal equivalence는 invalid payload bit pattern이 아니라 architecturally valid output을 비교한다.

## 13. Design Review Checklist

- [ ] 모든 observer와 next-state cone을 열거했는가?
- [ ] Compile-time constant와 runtime reachability를 구분했는가?
- [ ] Debug/test/scan/assertion/clock/reset/power/CDC observer를 검토했는가?
- [ ] Stored derived, shadow, cache와 replica state를 구분했는가?
- [ ] Removal 후 timing/fanout/recompute cost를 포함했는가?
- [ ] Clear/load/reset priority와 valid masking이 보존되는가?
- [ ] Formal/equivalence와 mapped netlist로 제거를 확인했는가?
- [ ] Constraint/document/change trigger를 함께 갱신했는가?

## 관련 문서

- [Area Design & Optimization](overview.md)
- [State Partitioning and Ownership](../02_architecture/state_partitioning_and_ownership.md)
- [FSM and Counter Encoding](fsm_counter_encoding.md)
- [Critical Path](../03_timing/critical_path.md)
- [RTL Design Review Checklist](../15_checklist/rtl_design_review_checklist.md)
