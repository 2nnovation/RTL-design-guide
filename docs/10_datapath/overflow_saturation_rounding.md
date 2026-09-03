# Overflow, Saturation, and Rounding

Overflow는 arithmetic operator가 틀렸다는 뜻이 아니라 **수학적 결과가 선택한 표현 범위를 벗어났다는 사건**이다. 설계는 그 사건을 wrap, wider result, saturation, flag/error 중 무엇으로 처리할지 정해야 한다. Fixed-point에서는 scale을 줄이며 버리는 bits가 rounding bias와 추가 overflow를 만들 수 있으므로 resize 순서까지 contract에 포함한다.

SystemVerilog width/signedness 규칙은 [Width and Signedness](../01_fundamentals/width_and_signedness.md), datapath boundary에서 operand/result 폭을 정규화하는 방법은 [Datapath Width and Signedness](width_signedness.md)가 담당한다. Counter의 terminal/wrap/error 정책은 [Counter Boundary Design](../09_control_logic/counter_boundary.md)이 정본이다.

## 1. Carry, Borrow와 Signed Overflow를 구분한다

W-bit vector의 bit pattern은 같아도 representation에 따라 overflow 조건이 다르다.

### Unsigned addition

두 operands를 W+1 bits로 zero-extend해 더하면 `sum_ext[W]`가 carry-out이고, W-bit unsigned range를 벗어났다는 overflow indication이 된다.

```systemverilog
logic [W:0] sum_u_ext;
logic [W-1:0] sum_u_wrap;
logic add_u_overflow;

assign sum_u_ext = {1'b0, a_u} + {1'b0, b_u};
assign sum_u_wrap = sum_u_ext[W-1:0];
assign add_u_overflow = sum_u_ext[W];
```

### Unsigned subtraction

`a_u - b_u`의 수학적 결과가 음수이면 unsigned underflow다. Explicit comparison이 가장 읽기 쉽다.

```systemverilog
logic [W:0] diff_u_ext;
logic [W-1:0] diff_u_wrap;
logic sub_u_underflow;

assign diff_u_ext = {1'b0, a_u} - {1'b0, b_u};
assign diff_u_wrap = diff_u_ext[W-1:0];
assign sub_u_underflow = (a_u < b_u);
```

Library나 arithmetic mapping에 따라 borrow/carry polarity가 다르게 노출될 수 있으므로 “MSB가 borrow다” 같은 암묵적 규칙보다 range comparison과 bit-exact reference를 사용한다.

### Signed addition

Two's-complement signed addition은 같은 부호 두 수를 더했는데 wrapped result 부호가 바뀌면 overflow다.

```systemverilog
assign add_s_overflow = ~(a_s[W-1] ^ b_s[W-1]) &&
                         (sum_s_wrap[W-1] ^ a_s[W-1]);
```

Positive + positive가 negative로 wrap하면 positive overflow, negative + negative가 nonnegative로 wrap하면 negative overflow다. Carry-out은 signed overflow와 같은 개념이 아니다. 예를 들어 W=4에서 -1 + -1은 bit-level carry가 생길 수 있지만 결과 -2는 legal signed range 안이다.

### Signed subtraction

`a_s - b_s`는 operands의 부호가 다르고 wrapped result 부호가 `a_s`와 달라질 때 overflow다.

```systemverilog
assign sub_s_overflow = (a_s[W-1] ^ b_s[W-1]) &&
                        (diff_s_wrap[W-1] ^ a_s[W-1]);
```

실무에서는 sign formula와 별개로 W+1-bit sign-extended intermediate가 signed min/max 범위를 넘는지도 검증하면 review가 쉬워진다.

## 2. Result Policy를 선택한다

| Policy | Overflow 시 결과 | 장점 | 주의점 |
|---|---|---|---|
| Wrap/modulo | low W bits만 보존 | 작은 hardware, modulo 연산에 정확 | magnitude가 반대 boundary로 이동 |
| Widen | full intermediate 제공 | 정보 보존 | interface/register/operator 폭 증가 |
| Saturate | signed min/max 또는 unsigned 0/max에 clamp | 제어·DSP에서 큰 discontinuity 방지 | compare와 result MUX, sticky indication 여부 |
| Flag/error | wrapped/full result와 event/status 제공 | caller가 정책 선택 | flag ownership, clear, backpressure 필요 |
| Reject/hold | state를 갱신하지 않고 error | credit/occupancy에 적합 | request acceptance와 retry semantics 필요 |

Saturation이 “더 안전한 wrap”인 것은 아니다. Modular checksum, address ring 또는 cryptographic finite-width arithmetic에는 wrap이 기능이다. 반대로 control limit, image/audio clamp, bounded accumulator에서는 saturation이 requirement일 수 있다.

Flag가 pulse인지 sticky status인지도 정한다. Sticky set/clear 우선순위와 accepted event semantics는 [Priority and Simultaneous Events](../09_control_logic/priority_and_simultaneous_events.md)를 따른다.

## 3. Parameter-Safe Signed Saturating Adder

다음 combinational module은 W-bit two's-complement inputs를 W+1 bits로 먼저 sign-extend해 더한다. Extended result를 representable min/max와 비교한 뒤 W-bit output을 선택한다. 지원 contract는 `W >= 1`이다.

```systemverilog
module signed_saturating_adder #(
  parameter int unsigned W = 8
) (
  input  logic signed [W-1:0] a,
  input  logic signed [W-1:0] b,
  output logic signed [W-1:0] sum_sat,
  output logic                overflow
);
  localparam logic signed [W-1:0] MAX_VALUE =
      {1'b0, {(W-1){1'b1}}};
  localparam logic signed [W-1:0] MIN_VALUE =
      {1'b1, {(W-1){1'b0}}};

  logic signed [W:0] a_ext, b_ext, sum_ext;
  logic signed [W:0] max_ext, min_ext;

  generate
    if (W < 1) begin : g_bad_width
      initial $fatal(1, "W must be at least 1");
    end
  endgenerate

  assign a_ext = $signed({a[W-1], a});
  assign b_ext = $signed({b[W-1], b});
  assign sum_ext = a_ext + b_ext;

  assign max_ext = $signed({MAX_VALUE[W-1], MAX_VALUE});
  assign min_ext = $signed({MIN_VALUE[W-1], MIN_VALUE});

  always_comb begin
    overflow = 1'b0;
    sum_sat  = sum_ext[W-1:0];

    if (sum_ext > max_ext) begin
      overflow = 1'b1;
      sum_sat  = MAX_VALUE;
    end else if (sum_ext < min_ext) begin
      overflow = 1'b1;
      sum_sat  = MIN_VALUE;
    end
  end
endmodule
```

Saturation 여부는 truncation 전에 W+1-bit `sum_ext`에서 결정한다. 먼저 low W bits로 자른 뒤 sign만 검사하면 이미 overflow 방향 정보가 사라질 수 있다.

`initial $fatal`의 synthesis/elaboration 처리는 tool flow에 따라 다르다. `W=0`은 port range 자체를 잘못 만들 수 있으므로 generator/configuration 단계에서 먼저 거부하고, lint/elaboration matrix에서도 `W>=1`을 검사한다.

### W=1 감사

W=1 two's-complement 범위는 -1..0이다.

| A | B | Mathematical sum | Saturated result | Overflow |
|---:|---:|---:|---:|---:|
| 0 | 0 | 0 | 0 | 0 |
| 0 | -1 | -1 | -1 | 0 |
| -1 | 0 | -1 | -1 | 0 |
| -1 | -1 | -2 | -1 | 1 |

`MAX_VALUE={1'b0,{0{1'b1}}}`는 1'b0, `MIN_VALUE={1'b1,{0{1'b0}}}`는 1'b1이므로 zero-length repetition을 허용하는 SystemVerilog semantics에서 정확하다. 지원 tool이 이를 받는지 minimum-parameter compile을 수행한다.

## 4. Fixed-Point Scale와 Resize 순서

Fixed-point value는 저장 integer와 fractional-bit 수 F를 함께 가져야 한다.

```text
real value = signed_or_unsigned_integer × 2^(-F)
```

- 같은 F의 addition/subtraction은 binary point가 정렬되어 있다.
- F가 다르면 한 operand를 shift/extend해 공통 scale로 맞춘다.
- Multiplication 결과의 fractional bits는 `F_A + F_B`다.
- Output F로 줄일 때 버리는 low bits가 rounding 정보를 가진다.

일반적인 resize 순서는 다음과 같다.

```text
wide arithmetic
    → scale alignment
    → rounding candidate in extended width
    → output-range comparison/saturation
    → final slice/register
```

Rounding increment가 retained field를 넘겨 carry를 만들 수 있으므로 saturation은 **rounding 뒤 candidate**에 적용한다. 예를 들어 최대 output보다 조금 작은 값이 round-up으로 정확히 one-past-maximum이 될 수 있다.

## 5. Truncation Bias와 Rounding Mode

DROP개의 fractional bits를 버릴 때 retained value와 guard/round/sticky 정보를 분리한다.

```text
... retained bits ... | guard | round | lower discarded bits
                                           └─ sticky = OR(all lower bits)
```

Guard는 첫 번째 discarded bit, round는 그다음 bit, sticky는 그 아래 discarded bits의 OR다. DROP이 작아 해당 위치가 없으면 그 정보는 0으로 취급한다. Round-to-nearest-even의 increment 조건은 대표적으로 `guard && (round || sticky || retained_lsb)`이며, exact tie에서는 round/sticky가 0이므로 odd retained value만 even 쪽으로 올라간다.

- **Truncation**: discarded bits를 버린다.
- **Round-to-nearest, ties-up**: half 이상이면 magnitude가 큰 unsigned integer 쪽으로 올린다.
- **Round-to-nearest, ties-to-even**: half보다 크면 올리고, 정확한 tie에서는 retained LSB가 odd일 때만 올린다.
- **Toward zero / ±infinity**: sign과 remainder에 따라 별도 increment/decrement 규칙이 필요하다.

Unsigned positive 값의 low bits를 버리는 truncation은 항상 같거나 작은 결과를 만들어 negative bias를 가진다. Ties-to-even은 장기 누적에서 tie가 한 방향으로만 치우치는 것을 줄일 수 있지만 guard/sticky/retained-LSB decode가 필요하다.

## 6. Signed Right Shift는 Toward Zero가 아니다

Signed arithmetic right shift `>>>`는 sign bit를 채운다. Two's-complement negative odd value에서는 보통 floor, 즉 negative infinity 방향 결과가 된다.

```text
-3 >>> 1 = -2
truncate-toward-zero(-3 / 2) = -1
```

따라서 `signed_value >>> DROP`을 “fractional truncation toward zero”라고 부르면 안 된다. Toward-zero가 필요하면 negative remainder가 있을 때 correction을 적용하거나 magnitude에서 rounding한 뒤 sign을 복원한다. MIN magnitude와 intermediate width를 포함해 별도 검증한다.

## 7. Restricted Unsigned Ties-Up Example

다음 예제는 **unsigned nonnegative input에만** 적용되는 round-to-nearest, ties-up과 saturating narrow output이다. Signed/general rounding solution이 아니다.

지원 범위는 `IN_W >= 2`, `1 <= DROP < IN_W`다. `OUT_W = IN_W - DROP`이며 output은 OUT_W-bit unsigned다. Rounding 결과가 OUT_W range를 넘으면 all-ones로 saturate하고 `overflow=1`을 낸다.

```systemverilog
module unsigned_round_ties_up_sat #(
  parameter int unsigned IN_W = 8,
  parameter int unsigned DROP = 3
) (
  input  logic [IN_W-1:0]  in_value,
  output logic [IN_W-DROP-1:0] out_value,
  output logic             overflow
);
  localparam int unsigned OUT_W = IN_W - DROP;
  localparam logic [IN_W:0] ROUND_BIAS =
      {{(IN_W-DROP+1){1'b0}}, 1'b1, {(DROP-1){1'b0}}};
  localparam logic [OUT_W-1:0] MAX_OUT = {OUT_W{1'b1}};

  logic [IN_W:0] rounded_ext;
  logic [OUT_W:0] rounded_value;

  generate
    if ((IN_W < 2) || (DROP < 1) || (DROP >= IN_W)) begin : g_bad_params
      initial $fatal(1, "Require IN_W >= 2 and 1 <= DROP < IN_W");
    end
  endgenerate

  assign rounded_ext = {1'b0, in_value} + ROUND_BIAS;
  assign rounded_value = rounded_ext[IN_W:DROP];
  assign overflow = rounded_value[OUT_W];
  assign out_value = overflow ? MAX_OUT : rounded_value[OUT_W-1:0];
endmodule
```

`ROUND_BIAS`는 extended width에서 정확히 bit `DROP-1`을 set한다. 먼저 W-bit input 안에서 bias를 더하면 input maximum 부근의 carry가 사라질 수 있다. `rounded_value`도 OUT_W+1 bits로 보존한 뒤 overflow를 판정한다.

### DROP boundary audit

IN_W=4, DROP=2이면 OUT_W=2이고 input integer를 4로 나누어 nearest ties-up으로 만든다.

| `in_value` | Exact scaled value | Rounded candidate | Output/overflow |
|---:|---:|---:|---|
| 4 (`0100`) | 1.00 | 1 | 1 / 0 |
| 5 (`0101`) | 1.25 | 1 | 1 / 0 |
| 6 (`0110`) | 1.50 tie | 2 | 2 / 0 |
| 7 (`0111`) | 1.75 | 2 | 2 / 0 |
| 13 (`1101`) | 3.25 | 3 | 3 / 0 |
| 14 (`1110`) | 3.50 tie | 4 | 3 / 1, saturated |
| 15 (`1111`) | 3.75 | 4 | 3 / 1, saturated |

- DROP=1에서는 discarded bit 하나가 guard이고 lower sticky bits는 없다.
- Maximum DROP=IN_W-1이면 OUT_W=1이다. Half-scale tie는 1로, 1.5 이상은 rounded candidate 2가 되어 output 1로 saturate될 수 있다.
- DROP=0은 이 module의 범위 밖이다. Bypass가 필요하면 generate wrapper에서 별도 identity path로 처리한다.

## 8. Rounding과 Saturation의 순서

다음 순서를 혼동하지 않는다.

1. Wide intermediate에서 discarded bits와 sign을 보존한다.
2. 요구된 rounding mode로 extended candidate를 만든다.
3. Candidate가 output min/max를 넘는지 비교한다.
4. Overflow flag와 saturated/wrapped/wide result를 선택한다.
5. Valid transaction의 결과만 commit한다.

Saturation을 먼저 적용한 뒤 rounding하면 endpoint 근처의 결과가 잘못되거나 overflow flag가 누락될 수 있다. 반대로 algorithm specification이 “먼저 input clamp, 그 후 계산”을 요구한다면 그것은 output saturation과 다른 stage이며 두 clamp를 구분한다.

## 9. Pipeline과 Commit

Wide add, rounding increment, range compare와 saturation MUX가 한 cycle에 직렬로 놓이면 critical path가 될 수 있다.

```text
wide arithmetic → rounding add → min/max compare → saturation MUX → register
```

Pipeline boundary를 추가할 때 data와 함께 다음 control을 이동한다.

- valid와 transaction tag
- signedness/mode/scale metadata
- overflow/underflow direction
- selected rounding mode
- exception enable과 commit permission

Speculative branches가 각각 overflow flag를 만들더라도 선택되지 않은 branch의 flag를 OR해 commit하면 안 된다. Only selected, valid transaction의 numeric result와 flag가 함께 architectural output이 된다. Pipeline의 stall/flush contract는 [Pipeline Design](../03_timing/pipeline.md)를 따른다.

## 10. Synthesis, STA와 PPA 관점

### Synthesis

Saturating add는 adder 외에 overflow/range detection과 endpoint MUX를 만들 수 있다. Sign formula와 extended compare 중 어느 구조가 더 작거나 빠른지는 width, library와 optimization에 따라 달라진다. RTL의 explicit extended intermediate가 반드시 별도 W+1 adder와 comparator를 각각 강제한다고 단정하지 않는다.

### Timing

- Add carry 뒤 saturation select가 이어지면 adder→compare→MUX path가 생길 수 있다.
- Sign-based overflow detect는 MSB 주변 logic으로 단순화될 수 있지만 endpoint selection은 여전히 필요하다.
- Rounding bias addition이 기존 carry path와 결합되거나 별도 stage를 요구할 수 있다.
- Wide mode/scale select가 늦게 오면 conversion MUX가 critical path를 지배할 수 있다.

### Power와 area

Guard bits, rounding adders, comparators, flags와 pipeline FF는 area/clock load를 늘린다. Saturation이 드물어도 combinational logic은 input toggle을 볼 수 있다. Operand isolation은 switching을 줄일 수 있지만 control MUX와 fanout 비용이 있으므로 [Operand Isolation](../04_low_power/operand_isolation.md)의 조건으로 평가한다.

## 11. 적용하면 안 되는 단순화

- Signed overflow를 carry-out 하나로 판정한다.
- Unsigned underflow를 wrapped result의 sign으로 판정한다.
- Low W bits로 자른 후 saturation 방향을 추측한다.
- Unsigned ties-up bias를 negative signed value에 그대로 더한다.
- `>>>`를 truncate-toward-zero로 문서화한다.
- Rounding 뒤 생긴 carry를 버리고 overflow가 없다고 보고한다.
- Unselected speculative candidate의 exception flag를 commit한다.
- Endpoint behavior가 다른 wrap/saturate 후보를 PPA만으로 비교한다.

## 12. Common Mistakes

### Carry와 signed overflow를 같은 flag로 사용한다

Unsigned와 signed interpretation의 representable range가 다르므로 같은 bit pattern에서도 의미가 다르다.

### Saturation constant의 sign/width가 틀린다

Unsized shift나 host integer 계산으로 MAX/MIN을 만들면 large W와 W=1에서 문제가 생길 수 있다. Packed-vector concatenation으로 endpoint bit pattern을 만든다.

### Tie rule을 “round nearest”라고만 쓴다

정확한 half에서 up, away-from-zero, even 중 무엇인지 없으면 bit-exact reference와 RTL이 달라진다.

### Sticky bit를 빼고 ties-to-even을 구현한다

Guard 아래 discarded bit 중 하나라도 1이면 exact tie가 아니다. Sticky OR가 필요하다.

### Output valid보다 error가 먼저 관찰된다

Invalid/speculative cycle의 overflow가 architectural status를 바꾸지 않도록 result와 flag의 commit point를 맞춘다.

## 13. Verification Strategy

### Saturating adder assertions

Combinational output을 synchronous boundary에서 sampling한다고 가정하면 same-sample relationship은 overlapped implication `|->`로 검사한다. Register stage를 추가했다면 accepted input과 registered result 사이에는 해당 latency와 `disable iff`를 반영한다.

```systemverilog
default clocking cb @(posedge clk); endclocking
default disable iff (!rst_n);

ap_positive_saturation:
  assert property (in_valid && (sum_ext > max_ext) |->
                   overflow && sum_sat == MAX_VALUE);

ap_negative_saturation:
  assert property (in_valid && (sum_ext < min_ext) |->
                   overflow && sum_sat == MIN_VALUE);

ap_in_range_is_exact:
  assert property (in_valid &&
                   (sum_ext <= max_ext) && (sum_ext >= min_ext) |->
                   !overflow && sum_sat == sum_ext[W-1:0]);
```

이 snippet의 `in_valid`, `clk`, `rst_n`은 combinational module을 감싸는 integration boundary 신호다. Assertion을 module에 bind할 때 실제 valid/reset 이름과 X policy를 연결한다. Registered wrapper라면 `accept |=> result_valid && result == reference($past(a), $past(b))`처럼 NBA 결과를 다음 sample에서 비교하고, reset/flush가 transaction을 abort하면 property도 같은 contract로 disable 또는 cancel한다.

### Boundary vectors

| Representation | Operation | Boundary expectation |
|---|---|---|
| Unsigned W | max + 1 | carry/overflow=1, wrap=0 |
| Unsigned W | 0 - 1 | underflow=1, wrap=max |
| Signed W | max + 1 | positive overflow, saturate max |
| Signed W | min + (-1) | negative overflow, saturate min |
| Signed W | max + min | -1, no signed overflow |
| Signed W | -1 + -1 | legal for W>=2; W=1만 negative overflow |
| Signed subtract | max - (-1) | positive overflow |
| Signed subtract | min - 1 | negative overflow |
| Rounding | below/tie/above half | mode별 exact candidate |
| Rounding | output max vicinity | rounding-induced overflow와 saturation |

- W=1 signed truth table을 exhaustive하게 검사한다.
- W=2와 representative larger widths에서 all-sign transition을 directed test한다.
- DROP=1, DROP=IN_W-1, exact multiples, just-below-half, tie, just-above-half를 검사한다.
- Arbitrary-precision signed/unsigned reference로 wrap/full/saturate/flag를 동시에 비교한다.
- Pipeline에서는 alternating rounding mode와 back-to-back min/max transactions로 metadata alignment를 확인한다.
- Invalid/bubble/speculative cycle의 flags가 status에 commit되지 않는지 검사한다.

## 14. Design Review Checklist

- [ ] Overflow를 representable range 초과로 정의했는가?
- [ ] Unsigned carry/borrow와 signed overflow를 구분했는가?
- [ ] Wrap, widen, saturate, flag/error 또는 reject 정책이 interface에 있는가?
- [ ] Signed min/max constants가 W=1에서도 정확한가?
- [ ] Saturation을 truncation 전에 extended intermediate에서 결정하는가?
- [ ] Fixed-point operand의 signedness와 fractional-bit 수가 명시됐는가?
- [ ] Rounding mode와 exact tie behavior가 정의됐는가?
- [ ] Guard/round/sticky와 retained LSB를 필요한 mode에 맞게 사용하는가?
- [ ] Negative arithmetic shift와 toward-zero 차이를 반영했는가?
- [ ] Rounding-induced carry 뒤 saturation을 다시 확인하는가?
- [ ] Unsigned-only rounding example을 signed/general path로 재사용하지 않는가?
- [ ] Result, overflow와 mode/tag가 같은 transaction으로 pipeline되는가?
- [ ] Only selected valid candidate의 result/exception만 commit되는가?
- [ ] W=1, DROP=1, maximum DROP와 endpoint vectors를 검증했는가?
- [ ] Mapped adder/compare/MUX 폭과 critical path를 확인했는가?

## 관련 문서

- [Datapath Width and Signedness](width_signedness.md)
- [Width and Signedness](../01_fundamentals/width_and_signedness.md)
- [Bit-Width Minimization](../05_area/bit_width_minimization.md)
- [Counter Boundary Design](../09_control_logic/counter_boundary.md)
- [Priority and Simultaneous Events](../09_control_logic/priority_and_simultaneous_events.md)
- [Pipeline Design](../03_timing/pipeline.md)
- [Operand Isolation](../04_low_power/operand_isolation.md)
