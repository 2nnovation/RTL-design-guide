# Resetless Datapath

Datapath payload reset을 생략할 수 있는 핵심 조건은 “초기값이 중요하지 않아 보인다”가 아니다. Corresponding valid/control이 reset되어 있고, payload가 invalid인 동안 **모든 architectural observer가 그 값을 사용하지 않는다는 contract와 evidence**가 있어야 한다.

> 이 문서의 `rst_n`은 destination domain에서 안전하게 release된 active-low reset이다. `0`이 asserted, `1`이 deasserted다. 예제는 valid만 asynchronous reset하고 payload register에는 reset assignment를 두지 않는다.

State lifetime과 observer 분류는 [State Partitioning and Ownership](../02_architecture/state_partitioning_and_ownership.md), reset cell/tree/inference 비용은 [Reset Area Cost](../05_area/reset_area_cost.md)가 canonical하게 다룬다. 이 문서는 resetless payload의 functional/X/verification contract에 집중한다.

## 1. Architecturally Invalid와 Unknown은 다르다

세 개념을 구분한다.

| 개념 | 의미 |
|---|---|
| Architecturally invalid | Contract상 consumer가 값을 사용하면 안 됨 |
| Simulation `X` | RTL simulator가 0/1을 결정하지 못한 four-state value |
| Physical unknown/old value | Silicon power-up 또는 이전 transaction의 실제 0/1 pattern |

Resetless FF는 simulation에서 `X`로 시작할 수 있지만 silicon에서는 어떤 0/1 상태를 가진다. `valid=0`이 모든 observer를 막아야 두 표현이 같은 functional behavior를 만든다.

```text
payload_q = X or old physical bits
valid_q   = 0
                ↓
consumer must perform no data-dependent action
```

“Output data가 X지만 valid가 0이므로 괜찮다”는 말은 output consumer뿐 아니라 compare, error, clock/power control, debug와 test observer까지 확인한 뒤에만 성립한다.

## 2. Resetless 후보와 Reset 필수 State

Resetless 후보:

- Pipeline payload captured only on accepted transaction
- Buffer data protected by valid/occupancy
- Derived/cached value protected by version valid
- Memory entry protected by valid bitmap or initialization state
- Uncommitted result hidden until completion valid

Reset이 필요한 가능성이 높은 state:

- Input/output valid, busy, ready ownership state
- FSM, pointer, occupancy, credit and phase
- Error/interrupt/side-effect control
- Clock enable, reset controller and wake state
- Software-visible configuration/status default
- Safety/test/security-defined initialization state

Payload와 valid가 같은 register bank에 있다는 이유로 같은 reset policy를 적용할 필요는 없다.

## 3. Observer Audit

Payload reset을 제거하기 전에 cone of influence를 검토한다.

| Observer | 확인 질문 |
|---|---|
| Functional consumer | `valid=0`에서 payload를 sample/compare하는가? |
| Output interface | Invalid payload를 외부가 읽거나 side effect로 사용하는가? |
| Error/parity logic | Payload alone으로 error/interrupt를 만들지 않는가? |
| Clock/power control | Data-dependent idle/gating/isolation decode가 있는가? |
| CDC/RDC | Payload와 valid가 다른 domain/reset sequence에서 어긋나는가? |
| Debug/trace/scan | Invalid payload도 deterministic/zeroized여야 하는가? |
| Security/safety | Old value remanence나 unknown propagation을 금지하는가? |
| Verification | Assertion/scoreboard가 invalid data를 우연히 constrain하는가? |

Observer 하나라도 valid mask를 우회하면 payload는 더 이상 architecturally invalid하지 않다. Reset을 유지하거나 observer 구조를 고친다.

## 4. Generic One-entry Elastic Stage

다음 stage는 one-entry storage이며 same-edge consume/refill을 허용한다.

Contract:

- `DATA_W >= 1`만 지원한다.
- `in_valid`은 request, `in_accept = in_valid && in_ready`가 accepted input event다.
- `out_accept = out_valid && out_ready`가 consumed output event다.
- `flush`는 `clk` domain의 glitch-free control이며 high인 동안 handshake를 즉시 mask하고 active edge에서 `valid_q`를 clear한다.
- Reset/flush 중 `in_ready=0`, `in_accept=0`이다.
- Event priority: reset → flush → accepted input → consumed output → hold.
- Full stage에서 `out_ready=1`이면 old output consume와 new input accept가 같은 edge에 가능하다.
- `out_valid=0`이면 `out_data`는 architecturally invalid다.

```systemverilog
module resetless_elastic_stage #(
    parameter int unsigned DATA_W = 32
) (
    input  logic              clk,
    input  logic              rst_n,
    input  logic              flush,

    input  logic              in_valid,
    input  logic [DATA_W-1:0] in_data,
    output logic              in_ready,

    output logic              out_valid,
    output logic [DATA_W-1:0] out_data,
    input  logic              out_ready
);
    logic [DATA_W-1:0] payload_q;
    logic              valid_q;
    logic              in_accept;
    logic              out_accept;

    assign in_ready   = rst_n && !flush && (!valid_q || out_ready);
    assign in_accept  = in_valid && in_ready;
    assign out_valid  = rst_n && !flush && valid_q;
    assign out_accept = out_valid && out_ready;
    assign out_data   = payload_q;

    // Payload is intentionally resetless and changes only on acceptance.
    always_ff @(posedge clk) begin
        if (in_accept) begin
            payload_q <= in_data;
        end
    end

    // Valid-state priority:
    // reset > flush > accepted input > consumed output > hold.
    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            valid_q <= 1'b0;
        end else if (flush) begin
            valid_q <= 1'b0;
        end else if (in_accept) begin
            valid_q <= 1'b1;
        end else if (out_accept) begin
            valid_q <= 1'b0;
        end
    end
endmodule
```

`payload_q`에는 reset/flush assignment가 없다. Reset이나 flush 뒤 physical bits가 old value를 유지하거나 simulation `X`여도 `out_valid=0`에서 사용되지 않는다는 contract다. Registered `valid_q`는 reset되며, outward `out_valid`도 reset/flush로 mask되어 같은 edge의 downstream handshake를 차단한다.

`in_ready`가 reset과 flush에 의해 combinationally low가 되므로 raw `in_valid`은 acceptance가 아니다. Producer는 request가 accept될 때까지 data를 유지하거나 protocol이 허용하는 retry를 해야 한다.

## 5. Cycle Audit: Reset, Back-to-back and Flush

`rst_n`은 E1 setup 전에 안전하게 high가 되었다고 가정한다.

```text
edge                              E0       E1       E2       E3       E4       E5
rst_n/flush                       0/0      1/0      1/0      1/0      1/1      1/0
in_valid/data                     1/A      1/A      1/B      1/C      1/C      1/C
out_ready                         1        1        1        0        1        1
in_ready/in_accept                0/0      1/1      1/1      0/0      0/0      1/1
out_accept before edge            0        0        1(A)     0        0        0
out_valid/data after edge         0/-      1/A      1/B      1/B      0/-      1/C
winning event                     reset    input    refill   hold     flush    input
```

- E1은 reset release 뒤 첫 accepted input이다.
- E2에서 A가 consume되고 B가 같은 edge에 accepted되어 bubble 없이 replacement된다.
- E3은 output backpressure 때문에 B와 valid를 hold하며 C는 accept되지 않는다.
- E4는 flush가 output consume와 input request보다 우선한다. C는 accept되지 않는다.
- E5에서 producer가 C를 유지/재시도하면 accept된다.

`-`는 값이 physically 없다는 뜻이 아니라 architecturally invalid라는 뜻이다. `payload_q`에는 여전히 어떤 bits가 존재한다.

## 6. First Accepted Transaction and NBA Semantics

Reset deassertion이 safe한 domain-local synchronizer의 NBA로 clock edge 직후 발생했다면 그 edge의 downstream logic은 여전히 reset branch를 실행한다. `in_ready`는 edge 뒤 high가 될 수 있지만 accepted event는 다음 `posedge`에서 계산된다.

Accepted edge에서 `payload_q`와 `out_valid`은 NBA로 함께 갱신된다. Consumer는 그 edge 뒤 cycle 동안 `out_valid=1`과 matching `out_data`를 관찰한다. Same-edge combinational consumer와 registered consumer의 sampling contract를 혼동하지 않는다.

Back-to-back refill에서는 E2 edge 직전 A가 valid한 output이고, E2 NBA 뒤 B가 next output이다. Scoreboard는 raw cycle data가 아니라 `in_accept/out_accept` events로 transaction ownership을 추적한다.

## 7. Hidden Observers

다음 구조는 output interface가 valid를 사용해도 hidden observer가 될 수 있다.

```systemverilog
// Unsafe unless payload_q is known or compare is explicitly valid-qualified.
assign payload_error = (payload_q == ERROR_CODE);
```

권장되는 functional qualification:

```systemverilog
assign payload_error = out_valid && (payload_q == ERROR_CODE);
```

하지만 `&&` 한 줄만 추가했다고 review가 끝나지 않는다.

- `payload_error`가 clock/power enable이나 asynchronous control에 들어가는가?
- Synthesis가 valid qualification을 expected cone으로 유지하는가?
- X semantics가 verification intent와 맞는가?
- Error가 invalid cycle에 반드시 zero여야 하는가?
- Debug/test가 raw payload를 별도로 노출하는가?

Data-dependent clock generation이나 raw asynchronous controls에는 resetless payload를 사용하지 않는다.

## 8. X Optimism, X Pessimism and Verification

Resetless payload는 X-aware verification을 요구한다.

### X optimism

일부 `if/case` 구조나 testbench 비교가 X를 특정 branch로 숨길 수 있다. Simulation이 pass해도 invalid payload가 control에 영향을 주는 bug가 감춰질 수 있다.

### X pessimism

실제 hardware에서 valid가 0이라 consumer가 값을 무시하는데 simulation X가 wide cone으로 퍼져 unrelated outputs까지 X로 만들 수 있다. 이때 payload를 편의상 reset해 X를 없애기보다 valid contract와 X modeling을 고친다.

### Assertion direction

- `out_valid=1`일 때 `out_data`가 known이고 reference transaction과 일치하는지 확인한다.
- `out_valid=0`일 때 payload 값을 zero라고 요구하지 않는다.
- Invalid payload로 side effect/error/accept가 발생하지 않는지 확인한다.
- X-propagation mode, formal initialization와 assumptions를 문서화한다.

Formal에서 resetless state를 arbitrary initial value로 두는 것은 모든 physical power-up patterns에 대한 proof를 강화할 수 있다. 그러나 environment를 과도하게 constrain해 arbitrary state를 숨기지 않는다.

## 9. Security, Safety, Test and Debug

Functional invalidity가 data remanence/zeroization requirement를 만족한다는 뜻은 아니다.

- Security boundary가 old payload clearing을 요구할 수 있다.
- Safety mechanism이 invalid state도 deterministic하게 monitor할 수 있다.
- Scan/debug path가 raw payload를 관찰할 수 있다.
- Test pattern/bring-up이 known reset state를 요구할 수 있다.
- Error containment이 X/old bits의 physical use를 금지할 수 있다.

이 경우 payload reset, explicit zeroization sequence, scan restriction 또는 isolation 같은 별도 mechanism이 필요할 수 있다. 구체적인 requirement가 functional PPA optimization보다 우선한다.

## 10. Memory and Register Arrays

Whole-array reset을 제거할 때는 entry validity를 별도로 관리한다.

Possible contracts:

- Valid bitmap reset; payload array resetless
- Epoch/generation tag invalidation
- Initialization sweep before ready
- Unread-before-write interface guarantee
- Macro-supported initialization feature

```text
read address
    ├─> valid bitmap ── false ─> no architectural data
    └─> payload array ─────────> data only if valid
```

Valid bitmap 자체는 reset되어야 할 수 있고, tag wrap/coherency와 first-use latency가 생긴다. Mapping과 port trade-off는 [Memory and Register Array](../05_area/memory_and_register_array.md)를 따른다.

## 11. Synthesis, STA and Physical View

### Synthesis

- Payload FF가 non-resettable cell로 mapping되는가?
- Valid/reset qualification이 hidden observer cone에 유지되는가?
- Reset 제거가 retiming/packing을 허용하는가?
- Array가 intended memory로 inference되는가?
- Flush가 payload clear logic으로 다시 확장되지 않는가?

### STA

- `out_valid` qualification이 data/error critical path에 들어가는가?
- `in_ready`의 full/ready feedback가 late path가 되는가?
- Resetless payload가 retimed될 때 valid alignment가 유지되는가?
- Flush/reset high-fanout path가 control timing을 만족하는가?

### RDC and physical

- Valid와 payload가 independent reset domains에서 어긋나지 않는가?
- Resetless payload가 reset된 peer domain에 stale data로 보이지 않는가?
- Reset sink 수, buffer/tree와 route span이 실제로 줄었는가?
- Added valid bitmap/qualification의 area와 congestion을 포함했는가?

## 12. Timing, Power, Area Trade-off

| Choice | Timing | Power | Area | Verification/functional risk |
|---|---|---|---|---|
| Reset payload + valid | reset path/fanout 증가 | reset switching | reset cells/tree 증가 가능 | deterministic payload |
| Reset valid only | payload path freedom 가능 | reset activity 감소 | area/routing 감소 가능 | observer/X discipline |
| Valid bitmap | access check path | bitmap activity | array inference 가능 | coherency/wrap |
| Init sweep | startup latency | sweep activity | reset logic 감소 가능 | ready sequencing |
| Explicit zeroization | clear bandwidth 필요 | clear switching | controller/state | security completion |

Actual result는 target library, array mapping, fanout와 physical implementation으로 확인한다.

## 13. 적용하면 안 되는 경우

- Valid 없이 payload를 compare, error, write-enable 또는 clock/power control에 사용하는 경우
- Output/debug/test가 reset 직후 payload 값을 관찰해야 하는 경우
- Security가 old data zeroization을 요구하는 경우
- Safety가 invalid payload도 deterministic하게 monitor해야 하는 경우
- Independent reset domain에서 valid는 reset되지만 stale payload observer가 남는 경우
- Memory entry를 initialization 전에 읽을 수 있고 validity protocol이 없는 경우
- X를 없애려는 목적만으로 functional observer bug를 숨기는 경우

## 14. Common Mistakes

- “Data는 중요하지 않다”는 주장만 하고 observer cone을 검토하지 않는다.
- Valid reset은 했지만 ready/accept가 reset 중 transaction을 센다.
- Flush에서 valid만 clear하면서 same-cycle load를 accept했다고 잘못 보고한다.
- Simulation X와 physical unknown을 같은 현상으로 설명한다.
- `$isunknown(out_data)`를 invalid cycle에도 요구한다.
- Compare/error/debug가 raw payload를 보는 것을 놓친다.
- Whole-array reset만 제거하고 unread-before-write를 허용한다.
- Area saving을 mapped/post-route evidence 없이 확정한다.

## 15. Verification Strategy

### Functional

- Reset assertion while empty/full
- Reset/flush/in-valid/out-ready simultaneous matrix
- First accepted transaction after release
- Back-to-back consume/refill and prolonged backpressure
- Flush while output valid and request held
- Resetless payload initialized to random/X patterns
- Hidden observer and side-effect checks
- Independent reset, clock stop and stale-state scenarios

### Assertions

```systemverilog
ap_no_accept_during_flush:
    assert property (@(posedge clk) disable iff (!rst_n)
        flush |-> !in_ready && !in_accept
    );

ap_accepted_data_is_presented_or_flushed:
    assert property (@(posedge clk) disable iff (!rst_n)
        in_accept |=>
            flush || (out_valid && (out_data == $past(in_data)))
    );

ap_flush_discards_valid_state:
    assert property (@(posedge clk) disable iff (!rst_n)
        flush |=> !valid_q
    );

ap_no_consume_when_invalid:
    assert property (@(posedge clk) disable iff (!rst_n)
        !out_valid |-> !out_accept
    );
```

`ap_accepted_data_is_presented_or_flushed`는 next clock sample에서 previous edge NBA 결과를 본다. Flush가 없으면 accepted data와 valid가 반드시 일치해야 한다. Consequent edge에 `flush=1`이면 이 stage contract는 pending output을 폐기하므로 presentation 대신 explicit abort를 허용한다. 이는 단순 waiver가 아니다. `ap_flush_discards_valid_state`가 같은 flush event가 registered `valid_q`를 실제로 clear했는지 다음 sample에서 별도로 확인한다. Reset은 `disable iff`로 pending transaction을 abort한다.

`flush`가 asserted되는 즉시 outward `out_valid`이 mask되므로, accepted data가 next sample까지 유지된다는 보장은 flush가 없는 경우에만 적용된다. Flush/replace semantics가 다른 stage는 antecedent, abort condition과 scoreboard를 해당 contract에 맞춘다.

Async reset assertion의 same-timestamp effect는 clocked property만으로 판단하지 않는다. Reset edge monitor와 reset-aware test를 별도로 사용한다.

## 16. Design Review Checklist

- [ ] Payload와 valid/control의 lifetime과 owner가 분리됐는가?
- [ ] `valid=0`일 때 모든 architectural observer가 payload를 무시하는가?
- [ ] Compare/error/clock/power/debug/test/security observer를 확인했는가?
- [ ] Reset/flush 중 ready와 accept가 false인가?
- [ ] First accepted transaction과 back-to-back refill을 cycle audit했는가?
- [ ] NBA sampling과 assertion observation cycle이 설명됐는가?
- [ ] X optimism/pessimism과 formal arbitrary initialization을 검토했는가?
- [ ] Memory unread-before-write와 valid bitmap/init sequence가 정의됐는가?
- [ ] Independent reset domain에서 stale payload 사용을 막는가?
- [ ] Reset cells/tree/inference와 added valid logic의 PPA를 함께 비교했는가?

## 관련 문서

- [Reset Architecture Overview](overview.md)
- [Synchronous vs Asynchronous Reset](sync_vs_async_reset.md)
- [Reset Deassertion and RDC](reset_deassertion.md)
- [Reset Area Cost](../05_area/reset_area_cost.md)
- [State Partitioning and Ownership](../02_architecture/state_partitioning_and_ownership.md)
- [Pipeline Design](../03_timing/pipeline.md#9-reset-strategy)
- [Memory and Register Array](../05_area/memory_and_register_array.md)
