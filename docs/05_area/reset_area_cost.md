# Reset Area Cost

Reset은 functional initialization과 recovery contract다. Area 관점에서는 resettable cell 선택, reset MUX/control, tree buffers, routing/fanout, memory inference와 optimization freedom에 영향을 줄 수 있다. Reset 제거는 단순한 cell 절감이 아니라 기능·test·safety·X·RDC contract 변경이다.

> “Resettable FF는 항상 더 크다”거나 “payload reset을 빼면 항상 area가 줄어든다”고 단정하지 않는다. Target library와 implementation report로 확인한다.

Reset 기능의 전체 architecture는 [Reset Architecture Overview](../07_reset/overview.md), stopped/gated clock 관계는 [Reset with Clock Gating](../07_reset/reset_with_clock_gating.md)이 담당한다. 이 문서는 area/physical trade-off만 다룬다.

## 1. Reset이 Area에 영향을 주는 경로

```text
reset requirement
   ├─ resettable sequential cell variant
   ├─ data/reset MUX or control logic
   ├─ reset tree buffers and routing
   ├─ fanout / placement constraints
   ├─ memory/register-array inference
   └─ retiming / replication / optimization freedom
```

실제 mapping은 coding style, reset polarity/type, library cells, synthesis/DFT flow와 constraints에 따라 달라진다.

## 2. State별 Reset 필요성을 분리한다

| State | 일반적인 질문 |
|---|---|
| Architectural config/status | Reset 뒤 외부가 known value를 관찰해야 하는가? |
| Protocol valid/busy/FSM | Phantom transaction/illegal phase를 막아야 하는가? |
| Datapath payload | Corresponding valid가 0이면 값이 관찰되는가? |
| Derived/cache state | Source/version valid로 invalidate 가능한가? |
| Debug/test/safety state | Methodology가 explicit reset을 요구하는가? |

모든 bits에 같은 reset policy를 적용하지 않는다. State inventory는 [State Partitioning and Ownership](../02_architecture/state_partitioning_and_ownership.md)을 참고한다.

## 3. Generic RTL: Valid Reset, Payload Resetless

Contract:

- `DATA_W >= 1`만 지원하며 zero-width payload는 integration/elaboration check가 거부해야 한다.
- `load_valid`는 request이고 `load_accept = load_valid && load_ready`가 accepted event다.
- `load_ready = rst_n && !flush`이므로 reset/flush 동안 request를 수락하지 않는다.
- Event priority: reset → flush → load accept → hold.
- Reset/flush는 in-flight transaction을 폐기한다.
- `out_valid=0`일 때 `out_data`는 architecturally invalid다.

```systemverilog
module reset_partitioned_stage #(
    parameter int unsigned DATA_W = 32
) (
    input  logic              clk,
    input  logic              rst_n,
    input  logic              flush,
    input  logic              load_valid,
    input  logic [DATA_W-1:0] load_data,
    output logic              load_ready,
    output logic              out_valid,
    output logic [DATA_W-1:0] out_data
);
    logic [DATA_W-1:0] data_q;
    logic              load_accept;

    assign load_ready  = rst_n && !flush;
    assign load_accept = load_valid && load_ready;
    assign out_data    = data_q;

    // Event priority: reset > flush > load accept > hold.
    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            out_valid <= 1'b0;
        end else if (flush) begin
            out_valid <= 1'b0;
        end else if (load_accept) begin
            data_q    <= load_data;
            out_valid <= 1'b1;
        end
    end
endmodule
```

`data_q`를 reset하지 않은 것은 valid가 모든 consumer를 mask한다는 contract 때문이다. Reset 직후 `out_data`가 X/old physical value여도 `out_valid=0`에서 사용하지 않는다. Safety/test/debug가 invalid payload도 known value로 요구하면 적용할 수 없다.

### Cycle audit

```text
edge                           E0          E1          E2          E3
rst_n/flush/load_valid         1/0/1       1/1/1       1/0/1       0/0/1
load_ready/load_accept         1/1         0/0         1/1         0/0
valid after                    1           0           1           0
payload meaning                A           invalid     C           invalid
winning event                  accept      flush       accept      reset
```

E1에서 flush와 request가 동시에 오면 `load_ready=0`이므로 request는 accept되지 않는다. E3의 reset에서도 ready/accept는 모두 false다. Upstream은 accept되지 않은 request를 유지하거나 재시도해야 한다.

## 4. Resettable Cell, MUX와 Tree Cost

가능한 구현 요소:

- Dedicated reset pin이 있는 FF
- Data input reset MUX
- Reset polarity conversion
- Reset tree buffers and routes
- Recovery/removal timing 관련 implementation constraints
- DFT/test control integration

Cell area 차이는 library마다 다르며 resettable cell이 동일 footprint일 수도, 다른 drive/area 선택을 가질 수도 있다. RTL만 보고 수치를 단정하지 않는다.

## 5. Reset Fanout와 Physical Area

Wide pipeline/array 전체를 reset하면 reset net이 많은 sinks와 넓은 physical span을 가진다.

```text
reset source ── buffer tree ─┬─ control FFs
                             ├─ payload bank 0
                             ├─ payload bank 1
                             └─ distant registers
```

Potential impact:

- Buffer/inverter cells
- Routing tracks and congestion
- Placement constraints around high-fanout net
- Transition/recovery timing effort
- Clock/reset interaction complexity

Payload reset 제거가 control valid reset보다 큰 physical effect를 가질 수 있지만 report로 확인한다.

## 6. Reset과 Retiming/Inference

Register마다 reset value/type가 다르면 tool이 register merging, retiming 또는 macro/register inference를 제한할 수 있다. 하지만 optimization behavior는 tool/library/constraints에 의존한다.

다음은 hypothesis로 확인한다.

- Resetless pipeline registers가 retiming 후보가 되는가?
- Reset semantics가 다른 registers가 pack/merge되지 않는가?
- Whole-array reset이 memory inference를 막고 FF array로 남는가?
- Output register reset이 macro boundary mapping에 영향을 주는가?

## 7. Array 전체 Reset과 Memory Mapping

```systemverilog
for (int i = 0; i < DEPTH; i++)
    mem[i] <= '0;
```

Whole-array synchronous/asynchronous clear는 많은 FF/decode/write logic으로 구현되거나 target memory template과 맞지 않아 inferred memory/macro mapping을 방해할 가능성이 있다. 어떤 구조가 생성되는지는 target technology와 inference guide/report로 확인한다.

대안 후보:

- Valid bitmap reset
- Epoch/version tag
- Initialization sequence
- Memory macro의 supported initialization/reset feature
- Protocol상 unread-before-write 보장

이 대안도 bitmap/tag/control area와 first-use latency를 가진다. Memory 구조는 [Memory and Register Array](memory_and_register_array.md)를 참고한다.

## 8. Async/Sync Reset과 Clock Stop

Async assertion/deassertion, recovery/removal, synchronizer와 RDC는 area만으로 선택할 수 없다. Function clock이 stopped된 상태에서 synchronous reset은 edge 없이 state를 갱신하지 못한다.

Canonical links:

- [Clock Design Overview](../06_clock/overview.md)
- [Root Clock vs Function Clock](../06_clock/root_vs_function_clock.md)
- [CDC Overview](../08_cdc/overview.md)
- [Reset Architecture Overview](../07_reset/overview.md)
- [Reset Deassertion and RDC](../07_reset/reset_deassertion.md)

이 문서에서는 선택된 reset contract가 buffer/tree/cell/memory area에 주는 영향만 비교한다.

## 9. Synthesis, STA와 Physical Evidence

### Synthesis

- Resettable/non-resettable sequential count
- Reset MUX/control cells
- FF array versus inferred memory
- Removed/added reset logic cone
- Retiming/optimization report, 제공되는 범위

### STA/RDC

- Reset recovery/removal or synchronous reset paths
- Reset release sequencing assumptions
- Reset MUX가 data critical path에 들어가는지
- Clock-gated domain reset applicability

### Physical

- Reset buffer count/fanout
- Route span/congestion
- Cell placement and footprint
- Clock/reset tree interaction

## 10. Timing, Power, Area Trade-off

| Choice | Timing | Power | Area | Risk |
|---|---|---|---|---|
| Reset all payload | reset network 부담 | reset switching | cells/tree 증가 가능 | simple known data |
| Reset valid only | payload path freedom 가능 | reset activity 감소 | area 감소 가능 | valid discipline/X |
| Valid bitmap | access check path | bitmap activity | memory mapping 가능성 | tag coherency |
| Init sequence | startup latency | initialization activity | reset logic 감소 가능 | first-use protocol |

## 11. 적용하면 안 되는 경우

- Valid 없이 payload를 관찰하는 consumer가 있는 경우
- Safety/test/debug가 known reset value를 요구하는 경우
- Resetless state가 wake/interrupt/error recovery에 필요한 경우
- Independent reset domains에서 stale valid를 mask하지 못하는 경우
- Array reset 제거 후 unread-before-write가 가능한 경우
- Area 추정만으로 async/sync reset architecture를 바꾸는 경우

## 12. Common Mistakes

- Resettable FF가 항상 더 크다고 일반화한다.
- Payload reset을 제거하면서 valid/output assertion을 갱신하지 않는다.
- Whole-array reset이 memory inference에 미치는 영향을 확인하지 않는다.
- Reset tree buffer/routing을 area boundary에서 제외한다.
- Reset removal을 equivalence waiver로만 처리하고 functional contract를 기록하지 않는다.
- Gated clock 아래 synchronous reset이 즉시 적용된다고 가정한다.

## 13. Verification Strategy

- Reset assertion/release at idle and in-flight
- Flush+load simultaneous priority
- Invalid payload가 모든 functional observers에서 mask되는지
- First load after reset and back-to-back loads
- X-propagation policy and assertion assumptions
- Memory unread-before-write/valid bitmap
- Scan/test/safety requirements review
- Reset/RDC/clock-stop integration evidence

```systemverilog
ap_invalid_after_reset:
    assert property (@(posedge clk)
        !rst_n |-> !out_valid
    );

ap_flush_invalidates:
    assert property (@(posedge clk) disable iff (!rst_n)
        flush |=> !out_valid
    );

ap_flush_blocks_accept:
    assert property (@(posedge clk) disable iff (!rst_n)
        flush && load_valid |-> !load_ready && !load_accept
    );
```

## 14. Design Review Checklist

- [ ] State별 reset observer와 required value가 정의됐는가?
- [ ] Control/valid와 invalid-masked payload를 구분했는가?
- [ ] Reset/flush/load priority와 handshake가 일치하는가?
- [ ] Test/safety/X/RDC requirement를 검토했는가?
- [ ] Resettable cells, MUX, tree buffers/routing을 포함했는가?
- [ ] Whole-array reset과 memory inference를 report로 확인했는가?
- [ ] Gated/stopped clock reset sequence가 유효한가?
- [ ] Timing, power, area와 physical congestion을 비교했는가?

## 관련 문서

- [Area Design & Optimization](overview.md)
- [Memory and Register Array](memory_and_register_array.md)
- [State Partitioning and Ownership](../02_architecture/state_partitioning_and_ownership.md)
- [Pipeline Design](../03_timing/pipeline.md)
- [Clock Design Overview](../06_clock/overview.md)
- [Reset Architecture Overview](../07_reset/overview.md)
- [Resetless Datapath](../07_reset/resetless_datapath.md)
