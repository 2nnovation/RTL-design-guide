# Datapath MUX and Select

Wide datapath의 select는 단순한 `case` 문이 아니라 data width만큼 복제되는 MUX, select decode, fanout와 routing network다. 기능적으로 같은 선택도 encoded, priority, balanced tree, one-hot masked-OR 또는 variable index 중 어떤 contract와 topology를 쓰느냐에 따라 timing, power, area와 invalid-input behavior가 달라진다.

`if`/`case`/ternary의 language semantics와 priority hardware는 [Priority and MUX](../01_fundamentals/priority_and_mux.md)가 정본이다. Select-before/after-operator architecture는 [Parallelism and Pre-computation](../02_architecture/parallelism_and_precomputation.md), sharing/duplication schedule은 [Resource Sharing vs Duplication](../02_architecture/resource_sharing_vs_duplication.md)이 담당한다. 이 문서는 wide datapath select의 implementation boundary와 검증에 집중한다.

## 1. Select Contract부터 쓴다

MUX RTL 전에 다음을 정의한다.

- Select encoding과 legal code set
- Zero-match, multiple-match와 X/Z input의 behavior
- Invalid selection에서 output data, `out_valid`, error indication
- Select와 data가 같은 transaction인지, 어느 edge에 capture되는지
- Combinational인지 registered/pipelined인지
- Glitch를 허용하는 synchronous data path인지
- Select가 늦게 도착하는지, fanout destination이 어디인지

Invalid select에서 `data='0`만 내보내고 valid를 계속 1로 두면 zero가 정상 result인지 error fallback인지 구분할 수 없다. Data fallback과 validity/error contract를 함께 둔다.

## 2. 주요 Hardware Topology

### Encoded MUX

N개 후보를 `ceil(log2(N))` select bits로 고른다.

```text
d0 ─┐
d1 ─┼── encoded N:1 MUX ──> y
d2 ─┼             ▲
d3 ─┘             sel
```

Compact control encoding이지만 decode와 data selection이 필요하다. N이 power of two가 아니면 unused codes의 behavior를 명시한다.

### Priority MUX

여러 condition이 동시에 참일 수 있고 앞 condition이 이긴다.

```text
if c0 -> d0
else if c1 -> d1
else if c2 -> d2
else fallback
```

뒤 후보는 앞 조건이 모두 false라는 dependency를 거칠 수 있다. Priority가 기능 requirement가 아니라 mutually-exclusive assumption이라면 그 exclusivity를 assertion으로 검증한다.

### Balanced tree

큰 MUX를 계층적인 2:1 tree로 나눈다.

```text
d0 ─┐
    M0 ─┐
d1 ─┘    │
         M2 ──> y
d2 ─┐    │
    M1 ─┘
d3 ─┘
```

Balanced logical depth와 physical grouping을 의도할 수 있지만 synthesis가 다시 flatten/restructure할 수 있다. Hierarchy constraint나 pipeline register를 넣지 않은 RTL 모양만으로 exact tree를 보장하지 않는다.

### One-hot masked-OR candidate

각 candidate를 select bit로 mask한 뒤 OR한다.

```text
(d0 & {W{sel0}}) ─┐
(d1 & {W{sel1}}) ─┼── OR ──> y
(d2 & {W{sel2}}) ─┼
(d3 & {W{sel3}}) ─┘
```

Exactly one select가 high일 때 MUX와 같은 function이다. Multiple-hot이면 data가 bitwise OR되어 priority MUX와 다른 결과가 되고, zero-hot이면 zero가 된다. Exactly-one contract, invalid policy와 assertion이 필요하다.

### Variable index

`array[index]`, variable part-select와 variable shift는 concise하지만 hardware에서는 decoder/MUX network 또는 조건을 만족할 때 memory/read structure가 될 수 있다. Array depth, element width, index range와 read latency가 비용을 결정한다.

## 3. Fixed 4-Way Encoded Select Example

다음 combinational module은 3-bit select에서 0..3만 legal로 정한다. `in_valid=0`이면 어떤 select도 transaction이 아니므로 error를 내지 않는다. Valid transaction에 illegal 또는 X-containing select가 오면 `out_valid=0`, `invalid_select=1`, `out_data='0`이다.

```systemverilog
module select4_encoded #(
  parameter int unsigned DATA_W = 32
) (
  input  logic              in_valid,
  input  logic [2:0]        select,
  input  logic [DATA_W-1:0] data0,
  input  logic [DATA_W-1:0] data1,
  input  logic [DATA_W-1:0] data2,
  input  logic [DATA_W-1:0] data3,
  output logic              out_valid,
  output logic              invalid_select,
  output logic [DATA_W-1:0] out_data
);
  logic select_legal;

  generate
    if (DATA_W < 1) begin : g_bad_width
      initial $fatal(1, "DATA_W must be at least 1");
    end
  endgenerate

  always_comb begin
    out_data       = '0;
    select_legal   = 1'b0;

    case (select)
      3'd0: begin out_data = data0; select_legal = 1'b1; end
      3'd1: begin out_data = data1; select_legal = 1'b1; end
      3'd2: begin out_data = data2; select_legal = 1'b1; end
      3'd3: begin out_data = data3; select_legal = 1'b1; end
      default: ;
    endcase

    out_valid      = in_valid && select_legal;
    invalid_select = in_valid && !select_legal;
  end
endmodule
```

Default assignments가 모든 path를 덮으므로 latch가 없다. Plain `case`의 exact matching 때문에 4..7뿐 아니라 X/Z가 포함되어 어느 legal literal과도 일치하지 않는 select도 `default`로 간다. `select_legal`이 known 0이므로 data와 valid/error output도 정의된다.

`invalid_select`는 combinational level이다. Clocked status에 저장하려면 accepted/valid event에서만 capture하고 set/clear priority를 별도로 정한다. Async error pin이나 clock control에 이 raw combinational output을 직접 쓰지 않는다.

## 4. One-Hot Masked-OR with Safe Invalid Policy

다음 예제는 exactly-one select만 legal로 인정한다. Masked-OR candidate를 계산하지만, illegal/unknown select에서는 externally visible data를 zero로 강제하고 invalid를 표시한다.

```systemverilog
module select4_onehot #(
  parameter int unsigned DATA_W = 32
) (
  input  logic                  in_valid,
  input  logic [3:0]            select_oh,
  input  logic [3:0][DATA_W-1:0] data,
  output logic                  out_valid,
  output logic                  invalid_select,
  output logic [DATA_W-1:0]     out_data
);
  logic [DATA_W-1:0] masked_or;
  logic select_legal;
  integer i;

  generate
    if (DATA_W < 1) begin : g_bad_width
      initial $fatal(1, "DATA_W must be at least 1");
    end
  endgenerate

  always_comb begin
    masked_or = '0;
    for (i = 0; i < 4; i = i + 1)
      masked_or |= data[i] & {DATA_W{select_oh[i]}};

    // Exact legal-set decode also rejects X-containing select values.
    select_legal = 1'b0;
    case (select_oh)
      4'b0001,
      4'b0010,
      4'b0100,
      4'b1000: select_legal = 1'b1;
      default: ;
    endcase

    out_data       = select_legal ? masked_or : '0;
    out_valid      = in_valid && select_legal;
    invalid_select = in_valid && !select_legal;
  end
endmodule
```

Zero-hot를 “valid output 없음”으로 허용하고 싶다면 exactly-one이 아니라 zero-or-one-hot contract와 별도 `has_selection`을 사용한다. Multiple-hot priority가 필요하면 masked OR가 아니라 explicit priority selection이어야 한다.

이 RTL이 silicon에서 반드시 AND-bank + OR-tree로 mapping된다고 단정하지 않는다. Synthesis는 Boolean equivalence, library와 constraints에 따라 MUX/decode 구조로 바꿀 수 있다. Mapping을 report와 netlist에서 확인한다.

`unique case`, `unique0` 또는 `priority` keyword는 simulation/lint intent와 optimization hint를 제공할 수 있지만 physical select bits를 one-hot으로 만들어 주거나 upset/bug에서 exclusivity를 보장하지 않는다. Runtime assertion과 safe invalid output이 별도로 필요하다.

## 5. Invalid Select Policy 비교

| Policy | Data output | Valid/error | 적합한 경우 |
|---|---|---|---|
| Safe constant | zero/safe value | valid=0, error=1 | invalid transaction을 명확히 reject |
| Hold registered output | previous value | no new valid, error=1 | output state가 명시적 register일 때 |
| Default candidate | designated data | valid=1 또는 corrected flag | fallback이 기능 requirement일 때 |
| Fail-stop | inactive output until recovery | sticky fault | safety/ownership 복구가 필요할 때 |
| Don't-care optimization | unspecified | environment assertion | invalid code가 물리적으로 불가능하다는 강한 contract |

Don't-care는 검증을 생략한다는 뜻이 아니다. Environment assumption, fault model와 tool optimization이 일치해야 한다. Security/safety boundary에서 invalid select가 unintended data를 노출하거나 write enable을 만들지 않는지 확인한다.

## 6. Late Select와 Fanout

Wide candidates가 일찍 준비되어도 select가 state decode, arbitration, tag compare 또는 long route 뒤에 도착하면 MUX output이 늦어진다.

```text
data0..N available ──────────────┐
late select ─────────────> decode/MUX ──> capture FF
```

확인할 path는 다음과 같다.

- Select source FF → decode → W-bit MUX select pins → destination FF
- Data source FF → MUX data arc → destination FF
- High-fanout select의 buffer와 net delay
- Reconvergent select/data logic의 glitch와 pessimism
- Distant candidate buses가 central MUX로 모이는 routing congestion

Select를 local register/replica로 배포하면 fanout와 locality가 나아질 수 있지만 control state와 clock load가 늘고 cycle alignment를 증명해야 한다. Final MUX를 pipeline하면 timing은 쉬워질 수 있으나 latency와 valid/tag alignment가 바뀐다.

## 7. Input MUX Before Operator vs Final MUX After Operators

같은 function을 두 구조로 만들 수 있다.

```text
shared:    candidate operands → input MUX → one operator → result

parallel:  candidate 0 → operator 0 ─┐
           candidate 1 → operator 1 ─┴→ final MUX → result
```

Shared form은 operator 수를 줄일 수 있지만 input MUX와 late select가 operator 앞에 놓인다. Parallel form은 operator work를 select보다 먼저 시작할 수 있지만 area, switching, result routing와 final MUX를 늘린다. Concrete registered implementation과 speculative commit은 [Datapath Parallel Pre-computation](parallel_precomputation.md)에서 다룬다.

RTL에 operator를 한 번 썼다고 sharing이 보장되거나 두 번 썼다고 duplication이 보장되는 것은 아니다. Tool은 algebraic factoring, resource sharing option과 timing constraint에 따라 topology를 바꿀 수 있다.

## 8. Constant, Identity와 Cheap Branch

모든 candidate가 full operator를 필요로 하는지 먼저 확인한다.

```text
mode 0: y = x        → identity wire
mode 1: y = x + 0    → identity로 단순화 가능
mode 2: y = x + K    → constant adder candidate
mode 3: y = expensive_f(x)
```

Constant propagation과 identity removal은 operator duplication보다 먼저 적용할 수 있다. 단, finite-width overflow, signed extension과 valid/error semantics가 같아야 한다. `x + 0`을 제거하면서 intermediate width나 flag generation이 달라지면 같은 contract가 아니다.

## 9. Variable Index와 Part-Select

```systemverilog
assign selected_word = words[word_index];
assign selected_field = packed_bus[base +: FIELD_W];
```

Register array의 combinational read는 depth×width MUX가 될 수 있고, memory inference 조건을 만족하면 다른 structure가 될 수 있다. Variable part-select는 base decode와 per-bit selection/routing을 만들 수 있다.

정의해야 할 사항:

- `word_index < DEPTH`, `base + FIELD_W <= BUS_W` range
- Out-of-range에서 X, zero, error 또는 impossible assumption
- Read latency와 synchronous-memory mapping 허용 여부
- Index signedness와 width
- Simultaneous writers/read-during-write semantics

Index range를 줄이면 decoder/MUX input을 줄일 가능성이 있지만 functional address space를 줄여서는 안 된다. Memory/register-array 선택은 [Memory and Register Array](../05_area/memory_and_register_array.md)를 참고한다.

## 10. Power와 Glitch

Combinational MUX가 최종적으로 한 candidate만 내보내도 unselected candidates의 upstream logic은 계속 toggle할 수 있다. Parallel pre-computation에서는 여러 operators가 매 transaction 또는 glitch마다 움직일 수 있다.

Operand isolation으로 unselected operator input을 clamp하면 switching을 줄일 수 있지만 다음 비용이 생긴다.

- Input isolation MUX/gate area
- Isolation control fanout와 timing
- Clamp transition 자체의 switching
- Tool의 factoring/resource-sharing 변화

자세한 적용 조건은 [Operand Isolation](../04_low_power/operand_isolation.md)을 따른다. 실제 activity와 mapped/post-route power evidence 없이 “MUX가 있으므로 다른 branch는 꺼진다”고 가정하지 않는다.

Raw combinational datapath select output은 data path에서 settling하도록 사용한다. 다음 용도로 직접 사용하지 않는다.

- Clock 또는 asynchronous reset/set
- Glitch-sensitive external strobe
- 다른 domain의 unsynchronized event
- Pulse width가 기능인 analog/mixed-signal enable

필요하면 registered control, handshake 또는 전용 clock/reset architecture를 사용한다.

## 11. Ready/Valid Path 주의

Data select와 함께 ready/valid를 조합할 때 source의 `valid`가 destination `ready`를 만들고, destination `ready`가 다시 source `valid`를 만드는 combinational loop를 만들지 않는다.

```text
source valid → select/arbitration → destination valid
      ▲                                │
      └──────── ready decode <─────────┘  (loop 위험)
```

Arbiter, skid buffer 또는 registered ready로 loop를 끊을 수 있지만 buffering depth, latency와 simultaneous acceptance가 달라진다. Priority와 accepted event contract는 [Priority and Simultaneous Events](../09_control_logic/priority_and_simultaneous_events.md)를 참고한다.

## 12. Synthesis, STA와 PPA 관점

### Synthesis

Case/ternary/array-index syntax와 inferred topology는 일대일 대응이 아니다. Tool은 mutually-exclusive knowledge, constants, don't-care, hierarchy와 timing 목표를 사용해 MUX를 balance, factor, duplicate 또는 remove할 수 있다. Report에서 MUX fan-in/depth, select decode와 unexpected priority를 확인한다.

### Timing

- Candidate 수와 width가 클수록 data arc와 routing load가 커질 수 있다.
- Priority chain은 condition dependency가 깊어질 수 있다.
- Balanced tree는 logic depth를 제한할 수 있지만 wire placement가 지배할 수 있다.
- One-hot은 decode를 앞당길 수 있지만 select bit별 fanout가 커질 수 있다.
- Final select가 late하면 pre-computation이 유리할 수 있으나 final MUX는 남는다.

### Power와 area

Encoded control은 select bits가 적지만 decode가 필요하다. One-hot은 control FF/wire가 많을 수 있으나 local selection이 단순해질 수 있다. Wide central MUX는 standard-cell area보다 placement/routing footprint가 더 클 수 있다. 같은 functional contract, constraints와 workload로 비교한다.

## 13. 적용하면 안 되는 단순화

- Multiple-hot 가능성을 검증하지 않고 one-hot masked OR를 priority MUX 대신 사용한다.
- Invalid select에서 data만 zero로 하고 valid/error를 정의하지 않는다.
- `unique` keyword를 runtime exclusivity circuit로 취급한다.
- Late select 문제를 무시하고 operator 앞에 wide MUX를 추가한다.
- Candidate RTL 개수만 보고 physical operator 개수를 단정한다.
- Variable index가 언제나 memory로 mapping된다고 가정한다.
- Combinational data output을 clock, async reset 또는 event pulse로 사용한다.
- Ready/valid selection으로 combinational loop를 만든다.

## 14. Common Mistakes

### Default를 생략한다

Combinational block에서 일부 code만 output을 assign해 latch를 만들거나 stale data가 valid처럼 보이게 한다.

### One-hot violation에서도 OR 결과를 사용한다

두 candidates가 섞인 bitwise OR는 어느 transaction의 data도 아닐 수 있다. Invalid를 표시하고 commit을 막는다.

### X select를 safe zero라고 가정한다

Ternary와 bitwise mask의 X propagation은 plain exact-match case와 다를 수 있다. Simulation X policy와 output validity를 명시한다.

### MUX cell delay만 본다

Select decode/fanout, candidate bus route, reconvergence와 destination setup을 함께 보지 않는다.

### Unselected branch는 power를 쓰지 않는다고 생각한다

Output에서 선택되지 않아도 upstream operator가 입력 toggle을 받아 내부 전환할 수 있다.

## 15. Verification Strategy

Combinational example은 clock boundary에서 stable input을 sampling한다고 가정해 same-sample `|->`로 검사한다. Output register가 추가되면 accepted edge와 해당 latency를 사용하고 reset/flush abort contract를 반영한다.

```systemverilog
default clocking cb @(posedge clk); endclocking
default disable iff (!rst_n);

ap_select0:
  assert property (in_valid && (select == 3'd0) |->
                   out_valid && !invalid_select && out_data == data0);

ap_select3:
  assert property (in_valid && (select == 3'd3) |->
                   out_valid && !invalid_select && out_data == data3);

ap_invalid_is_rejected:
  assert property (in_valid && !select_legal |->
                   !out_valid && invalid_select && out_data == '0);

ap_idle_has_no_error:
  assert property (!in_valid |-> !out_valid && !invalid_select);
```

One-hot implementation에는 다음을 추가한다.

```systemverilog
ap_valid_output_requires_onehot:
  assert property (out_valid |-> $onehot(select_oh));

ap_illegal_onehot_is_rejected:
  assert property (in_valid && !select_legal |->
                   !out_valid && invalid_select && out_data == '0);
```

`select_legal`은 example의 exact-match safe decode이므로 X-containing select에서도 known 0이다. `$onehot`의 X semantics와 formal engine의 2-state/4-state model은 별도로 확인한다.

Reference model은 legal code에서 선택된 candidate를 반환하고 illegal code에서 `{valid=0,error=1,data=0}`를 반환해야 한다. 다음을 directed/random으로 검증한다.

- First/last legal encoded code와 모든 unused code
- Zero-hot, every one-hot bit, every pair of multiple-hot bits와 all-hot
- Select에 X/Z를 inject한 4-state simulation
- All-zero/all-one/alternating/random candidate data
- Late-changing select가 setup을 만족하는 synchronous boundary
- Back-to-back alternating select와 payload association
- Constant/identity optimization 전후 bit/cycle equivalence
- Registered/pipelined variant의 valid/select/data latency

## 16. Design Review Checklist

- [ ] Select encoding과 legal code set이 명시됐는가?
- [ ] Zero/multiple-match와 X/Z의 data, valid와 error behavior가 있는가?
- [ ] Combinational block에 complete default assignment가 있는가?
- [ ] Priority가 requirement인지 exclusivity assumption인지 구분했는가?
- [ ] One-hot contract가 assertion과 safe invalid policy로 보호되는가?
- [ ] `unique`/`priority`를 silicon guarantee로 오해하지 않는가?
- [ ] Encoded, priority, balanced, one-hot과 variable-index 후보를 필요에 맞게 비교했는가?
- [ ] Select arrival, fanout, reconvergence와 wide routing을 STA/physical report에서 보는가?
- [ ] Input-MUX/one-operator와 parallel-operator/final-MUX를 같은 기능으로 비교했는가?
- [ ] Constant/identity branch를 width와 flag semantics까지 보존해 단순화했는가?
- [ ] Variable index/part-select의 range와 invalid behavior를 검증했는가?
- [ ] Unselected branch switching과 isolation overhead를 함께 측정했는가?
- [ ] Ready/valid combinational loop가 없는가?
- [ ] Raw output이 glitch-sensitive clock/async/event control로 사용되지 않는가?
- [ ] Legal/invalid/one-hot cases와 reference equivalence를 검증했는가?

## 관련 문서

- [Priority and MUX](../01_fundamentals/priority_and_mux.md)
- [Parallelism and Pre-computation](../02_architecture/parallelism_and_precomputation.md)
- [Resource Sharing vs Duplication](../02_architecture/resource_sharing_vs_duplication.md)
- [Datapath Parallel Pre-computation](parallel_precomputation.md)
- [Operand Isolation](../04_low_power/operand_isolation.md)
- [Memory and Register Array](../05_area/memory_and_register_array.md)
- [Priority and Simultaneous Events](../09_control_logic/priority_and_simultaneous_events.md)
