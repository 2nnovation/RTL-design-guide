# Operand Isolation

Operand isolation은 결과를 사용하지 않는 동안 큰 combinational block의 input activity가 내부로 전파되지 않도록 막는 low-power technique다.

> Destination register를 hold하는 것과 combinational block 자체를 조용하게 만드는 것은 다른 문제다.

전체 low-power 흐름은 [Low-Power RTL Design](overview.md), register update 제어는 [Register Enable](register_enable.md)을 참고한다.

## 1. Why It Matters

다음 구조에서 `result_en == 0`이면 output register는 hold하지만 multiplier input이 계속 바뀐다.

```systemverilog
assign product = a * b;

always_ff @(posedge clk) begin
    if (result_en)
        result <= product;
end
```

```text
a,b toggle ──> multiplier toggles ──> result FF holds
```

Wide multiplier, adder tree, comparator bank나 decoder가 자주 idle이고 operand는 계속 변한다면, 내부 switching이 불필요한 dynamic power가 될 수 있다.

## 2. Hardware View

Operand isolation은 expensive block 앞에 functional guard를 둔다.

```text
Before

changing operands ──────────────> expensive block ──> unused result

After

changing operands ── isolation ─> expensive block ──> unused result
                       ▲
                       │ use_result
```

Isolation value는 보통 stable constant나 hold된 operand다. 어떤 값이 가장 적합한지는 block mapping과 glitch behavior에 따라 다를 수 있다.

## 3. RTL Patterns

### 3.1 Constant clamp

```systemverilog
logic [W-1:0] a_iso;
logic [W-1:0] b_iso;

assign a_iso = use_result ? a : '0;
assign b_iso = use_result ? b : '0;
assign product = a_iso * b_iso;
```

`use_result == 0` 동안 isolated operands가 constant이면 내부 activity가 줄 가능성이 있다.

### 3.2 Registered operand capture

Transaction이 시작될 때만 operand register를 update한다.

```systemverilog
always_ff @(posedge clk) begin
    if (accept) begin
        a_hold <= a;
        b_hold <= b;
    end
end

assign product = a_hold * b_hold;
```

이 구조는 input MUX 대신 register enable을 사용한다. Transaction 사이에 operand가 hold되어 block input이 안정된다. Latency, capture timing과 stale-result validity를 명확히 해야 한다.

### 3.3 Operation selection

```systemverilog
always_comb begin
    add_a = '0;
    add_b = '0;

    if (do_add) begin
        add_a = src_a;
        add_b = src_b;
    end
end

assign sum = add_a + add_b;
```

Default assignment는 latch 방지를 위한 것이며, 실제 isolation 효과는 synthesis mapping과 activity로 확인한다.

## 4. Isolation Control Requirements

Isolation control이 잘못되면 power 문제가 아니라 functional corruption이 된다.

다음을 정의한다.

- 어느 cycle부터 result가 필요해지는가?
- Operand가 block에 들어가야 하는 마지막 edge는 언제인가?
- Combinational result가 capture될 때 isolation이 풀려 있는가?
- Pipeline stage별 enable과 alignment가 맞는가?
- Abort/flush 시 isolation state는 무엇인가?
- Control이 다른 clock domain에서 오는가?

Late-arriving isolation control은 critical path에 MUX를 추가할 수 있다.

## 5. Glitch and Hazard Considerations

Combinational `use_result`가 여러 decode path의 glitch를 포함하면 isolation MUX가 오히려 operand를 토글시킬 수 있다.

```text
glitchy decode ──> isolation select ──> wide operand fanout
```

가능하면 stable/registered control을 사용하고, control generation switching과 fanout를 포함해 측정한다. Clock gating과 달리 data-path glitch가 곧 extra clock edge를 만들지는 않지만, power와 timing을 악화시키고 capture edge 근처의 data stability를 해칠 수 있다.

## 6. Synthesis View

RTL의 isolation MUX는 다음처럼 변할 수 있다.

- explicit input MUX 유지
- arithmetic input의 AND/OR gating으로 흡수
- constant propagation과 operator simplification
- downstream select와 결합
- resource-sharing MUX와 재구성

다음을 확인한다.

- MUX가 실제 expensive block 앞에 남았는가?
- Isolation이 operator mapping을 나쁘게 바꾸지 않았는가?
- Constant operand가 macro inference를 방해하지 않는가?
- Control fanout buffer와 route overhead는 얼마인가?
- 결과가 사용되지 않는 cone을 tool이 이미 제거할 수 있었는가?

## 7. Timing Impact

### Input-path penalty

```text
operand FF ── isolation MUX ── expensive operator ── result FF
```

MUX delay가 critical operator 앞에 추가될 수 있다. 해결 후보:

- operand를 한 cycle 일찍 capture
- isolation control pre-decode
- MUX를 macro input register 앞에 배치
- timing-critical operand는 isolate하지 않음
- block-level clock/enable architecture 재검토

### Control fanout

하나의 `use_result`가 여러 wide block을 제어하면 physical fanout와 routing이 커질 수 있다. Local registered enable이나 hierarchy별 control duplication을 검토하되 area/power와 함께 측정한다.

## 8. Power Impact

절감 가능성이 큰 조건:

- Expensive block의 input activity가 높다.
- Result가 사용되지 않는 시간이 길다.
- Block 내부 capacitance가 isolation MUX보다 훨씬 크다.
- Isolation control이 안정적이고 switching이 낮다.

절감이 작거나 음수가 될 수 있는 조건:

- Block이 대부분 active다.
- Operand가 원래 거의 변하지 않는다.
- Isolation MUX/control network가 크다.
- Tool/macro가 이미 내부 operand gating을 한다.
- Isolation으로 glitch가 늘어난다.

Representative activity를 이용해 operator 내부, input MUX, control network를 함께 비교한다.

## 9. Area Impact

- Operand width만큼 MUX/logic 증가 가능
- Control buffer와 routing 증가
- Registered isolation은 operand FF와 enable 추가
- Constant propagation으로 일부 logic 감소 가능
- Resource-sharing/macro mapping 변화 가능

Wide operand를 두 개 이상 isolate하면 MUX bit 수가 빠르게 커진다. 작은 comparator에는 overhead가 더 클 수 있다.

## 10. Operand Isolation vs Other Techniques

| 기법 | 직접 제어하는 것 | 적합한 상황 |
|---|---|---|
| Register enable | destination FF update | result register가 idle |
| Operand isolation | combinational block input activity | expensive block result가 자주 버려짐 |
| Clock gating | sequential clock activity | 큰 FF group이 오래 idle |
| Remove logic | logic 존재 자체 | 기능적으로 필요 없음 |
| Pipeline gating | stage별 data/valid movement | bubble이 많은 pipeline |

한 변경에서 여러 기법을 조합할 수 있지만 control overlap과 overhead를 검증한다.

## 11. Example: Conditional Comparator Bank

```systemverilog
logic [3:0] match;
logic [W-1:0] key_iso;

assign key_iso = lookup_valid ? key : '0;

for (genvar i = 0; i < 4; i++) begin : g_cmp
    assign match[i] = (key_iso == table_entry[i]);
end
```

이 예는 `lookup_valid == 0` 동안 key transition이 comparator bank로 전달되는 것을 줄이려는 의도다. 하지만 `table_entry`가 계속 바뀐다면 comparator는 여전히 토글할 수 있다. 어느 operand가 activity source인지 측정해야 한다.

## 12. Verification Strategy

Functional property는 isolation이 풀린 valid cycle에 원래 연산과 동일한 결과를 내는지 확인한다.

```systemverilog
ap_isolated_result_correct:
    assert property (@(posedge clk) disable iff (!rst_n)
        use_result |-> isolated_result == reference_result
    );
```

추가 검증:

- `use_result` assertion 직후 첫 transaction
- deassert 직전 마지막 capture
- back-to-back active/idle 전환
- reset/flush와 isolation overlap
- control이 X/unknown일 때 verification policy
- Pipeline stall에서 stage별 isolation alignment

Power verification에서는 isolation output과 expensive block internal activity가 실제 감소했는지 확인한다.

## 13. Common Mistakes

- Destination FF enable만으로 operator도 멈춘다고 가정한다.
- 모든 arithmetic input에 isolation MUX를 추가한다.
- Glitchy combinational control을 wide isolation select로 사용한다.
- Isolation MUX timing penalty를 무시한다.
- 한 operand만 isolate하고 다른 high-activity operand를 놓친다.
- Macro inference와 internal gating을 확인하지 않는다.
- Functional result만 검증하고 실제 switching reduction은 측정하지 않는다.

## 14. Design Review Checklist

- [ ] Result가 사용되지 않는 interval이 명확한가?
- [ ] Expensive block input이 그 interval에도 실제로 toggle하는가?
- [ ] 어떤 operand가 주요 activity source인가?
- [ ] Constant clamp와 registered hold 중 어떤 구조가 적합한가?
- [ ] Isolation control은 올바른 cycle에 안정적인가?
- [ ] Input MUX가 critical path를 악화시키지 않는가?
- [ ] Control fanout와 buffer/routing 비용을 포함했는가?
- [ ] Operator/macro inference가 유지됐는가?
- [ ] Active cycle functional equivalence와 boundary 전환을 검증했는가?
- [ ] Representative workload에서 internal switching과 총 PPA가 개선됐는가?

## 관련 문서

- [Low-Power RTL Design](overview.md)
- [Register Enable](register_enable.md)
- [Counter Optimization](counter_optimization.md)
- [Pipeline Design](../03_timing/pipeline.md)
