# Datapath Width and Signedness

Datapath의 width와 signedness는 문법 속성이 아니라 **표현 가능한 값, binary point, overflow 결과와 실제 operator 크기를 결정하는 interface contract**다. 같은 bit pattern도 unsigned인지 two's-complement signed인지에 따라 비교와 확장의 의미가 달라지고, 연산 전에 확보하지 않은 carry나 sign range는 넓은 destination만 선언한다고 복구되지 않는다.

SystemVerilog expression sizing과 cast의 기본 규칙은 [Width and Signedness](../01_fundamentals/width_and_signedness.md), range에서 최소 저장 폭을 정하는 방법은 [Bit-Width Minimization](../05_area/bit_width_minimization.md)이 정본이다. 이 문서는 그 규칙을 실제 datapath boundary, arithmetic implementation과 cycle contract에 적용하는 판단에 집중한다.

## 1. Interface마다 Numeric Representation Contract를 쓴다

Port 이름과 packed width만으로는 충분하지 않다. Producer와 consumer가 공유해야 할 계약은 다음과 같다.

| 항목 | 질문 | 예시 |
|---|---|---|
| Representation | unsigned인가, two's-complement signed인가? | signed two's complement |
| Legal range | 모든 bit pattern이 legal한가? | -128..127, 또는 -100..100만 legal |
| Scale/binary point | 저장 정수 한 count가 실제 얼마인가? | Q3.4, value = stored × 2^-4 |
| Storage width | Register/interface에 몇 bit를 보존하는가? | 8 bits |
| Arithmetic width | Operator 입력과 intermediate가 몇 bit인가? | add 전에 9 bits로 확장 |
| Result policy | full precision, wrap, saturate, flag 중 무엇인가? | 9-bit full sum |
| Validity | 어느 cycle에 값이 유효한가? | `out_valid=1`일 때만 |

Fixed-point에서 같은 8-bit signed vector라도 fractional bits가 0개인지 4개인지 값은 다르다. Addition/subtraction은 보통 binary point를 정렬해야 하고, multiplication은 fractional-bit 수가 더해진다. Scale conversion에서 버리는 bit의 rounding/saturation 정책은 [Overflow, Saturation, and Rounding](overflow_saturation_rounding.md)에서 다룬다.

## 2. 네 가지 Width를 분리한다

한 assignment를 볼 때 다음을 따로 적는다.

```text
stored operand width ──> normalized operator width
                               │
                               v
                        expression/result width
                               │
                               v
                         destination width
```

- **Storage width**: Input port나 register에 실제 저장된 bit 수
- **Operand width**: Operator에 들어가기 직전 sign/zero-extension을 마친 폭
- **Expression width**: Operator가 계산하고 보존하는 bit 수
- **Destination width**: 결과를 받는 wire/register/interface의 폭

Review에서는 `logic [W:0] result`만 보고 full precision이라고 판단하지 않는다. 먼저 operator operands가 필요한 폭과 signed interpretation으로 정규화되었는지 확인한다. Context-dependent sizing에 우연히 기대는 표현은 작은 리팩터링이나 다른 operator 결합으로 의미가 달라지기 쉽다.

## 3. Unsigned Addition: Carry를 연산 전에 확보한다

두 W-bit unsigned 값의 합은 W+1 bits가 필요하다. 다음처럼 양쪽 operand를 먼저 zero-extend하면 carry 보존 의도가 명확하다.

```systemverilog
module unsigned_add_full #(
  parameter int unsigned W = 8
) (
  input  logic [W-1:0] a,
  input  logic [W-1:0] b,
  output logic [W:0]   sum_full,
  output logic [W-1:0] sum_wrap,
  output logic          carry_out
);
  logic [W:0] a_ext, b_ext;

  generate
    if (W < 1) begin : g_bad_width
      initial $fatal(1, "W must be at least 1");
    end
  endgenerate

  assign a_ext = {1'b0, a};
  assign b_ext = {1'b0, b};
  assign sum_full = a_ext + b_ext;

  // The narrow outputs intentionally implement modulo-2^W behavior.
  assign sum_wrap = sum_full[W-1:0];
  assign carry_out = sum_full[W];
endmodule
```

Carry가 W-bit intermediate에서 이미 잘린 뒤 destination만 넓히면 복구할 수 없다.

```systemverilog
logic [W-1:0] sum_narrow;
logic [W:0]   widened_too_late;

assign sum_narrow = a + b;
assign widened_too_late = {1'b0, sum_narrow}; // lost carry stays lost
```

일부 context-determined expression에서는 wider destination context가 operand sizing에 영향을 줄 수 있다. 그러나 그것은 “W+1-bit operands로 계산한다”는 hardware contract를 직접 표현하지 않는다. Self-determined subexpression, narrow function return, named intermediate 또는 refactoring이 들어오면 결과가 달라질 수 있다. Full precision이 requirement라면 explicit extension을 source of truth로 둔다.

## 4. Signed Add/Subtract: 먼저 Sign-Extend한다

두 W-bit signed 값의 full-range sum/difference에는 W+1 bits가 필요하다. `$signed`는 bit pattern의 interpretation을 바꾸지만 자동으로 새로운 range bit를 만들지 않는다.

```systemverilog
logic signed [W-1:0] a_s, b_s;
logic signed [W:0]   a_s_ext, b_s_ext;
logic signed [W:0]   sum_s_full, diff_s_full;

assign a_s_ext = $signed({a_s[W-1], a_s});
assign b_s_ext = $signed({b_s[W-1], b_s});
assign sum_s_full  = a_s_ext + b_s_ext;
assign diff_s_full = a_s_ext - b_s_ext;
```

`$signed(a_s)`는 여전히 W-bit 값이다. 다음 순서를 사용한다.

1. 원래 sign bit를 복제해 필요한 width를 만든다.
2. Concatenation이 만든 unsigned vector를 `$signed(...)`로 명시한다.
3. 같은 width와 signedness의 operands끼리 연산한다.
4. Full result에서 narrowing 정책을 별도로 적용한다.

Unsigned operands의 signed difference는 양수 해석을 보존하도록 zero-extend한 뒤 signed로 해석한다.

```systemverilog
logic        [W-1:0] a_u, b_u;
logic signed [W:0]   delta;

assign delta = $signed({1'b0, a_u}) -
               $signed({1'b0, b_u});
```

이 결과 범위는 `-(2^W-1)`부터 `+(2^W-1)`까지라서 W+1-bit signed에 들어간다.

## 5. Mixed Signed/Unsigned는 Boundary에서 정규화한다

Signed temperature와 unsigned threshold를 직접 비교하면 language conversion에 따라 음수 temperature가 큰 unsigned 값처럼 취급될 수 있다. 공통 표현 범위를 먼저 만든다.

```systemverilog
logic signed [7:0] temperature;
logic        [7:0] threshold;
logic signed [8:0] temperature_n;
logic signed [8:0] threshold_n;
logic              below_threshold;

assign temperature_n = $signed({temperature[7], temperature});
assign threshold_n   = $signed({1'b0, threshold});
assign below_threshold = (temperature_n < threshold_n);
```

이 변환은 threshold의 0..255를 9-bit signed 양수로 보존한다. 단순히 `$signed(threshold)`로 바꾸면 8-bit `8'hFF`가 +255가 아니라 -1이 된다.

### Concatenation과 part-select

Concatenation과 part-select는 원래 signal의 signedness를 그대로 보존한다고 가정하지 않는다.

```systemverilog
logic signed [15:0] packed_s;
logic signed [7:0]  low_field_s;

assign low_field_s = $signed(packed_s[7:0]);
```

이 코드는 lower 8 bits를 새 8-bit signed 값으로 **재해석**한다. 원래 16-bit 수를 수치적으로 보존한 truncation이 아니다. Field 자체의 representation contract가 있을 때만 사용한다.

### Literal과 cast

- Arithmetic constant는 `8'd1`, `9'sd0` 또는 width가 정해진 `localparam`처럼 의도를 드러낸다.
- `'0`과 `'1`은 assignment context에 맞지만 수치 범위와 signedness를 설명해 주지는 않는다.
- Size cast와 type cast는 truncation/extension이 어느 시점에 일어나는지 review한다.
- Unsized decimal과 negative literal을 mixed expression에 넣고 lint warning을 suppress하지 않는다.

## 6. Multiplication과 Accumulation

### Full-precision multiply

W_A-bit와 W_B-bit unsigned operands의 full product는 W_A+W_B bits다. Signed two's-complement multiplication도 각 operand의 full declared range를 보존하려면 같은 합계 폭이 필요하다.

```systemverilog
localparam int unsigned P_W = W_A + W_B;

logic [W_A-1:0] a;
logic [W_B-1:0] b;
logic [P_W-1:0] a_mul_ext, b_mul_ext;
logic [P_W-1:0] product_full;

assign a_mul_ext = {{W_B{1'b0}}, a};
assign b_mul_ext = {{W_A{1'b0}}, b};
assign product_full = a_mul_ext * b_mul_ext;
```

상위 constant-zero bits를 synthesis가 이용할 수 있으므로 이 RTL이 반드시 물리적인 P_W×P_W multiplier를 강제한다고 단정하지 않는다. Report에서 inferred operand/result width와 macro mapping을 확인한다.

### Accumulator guard bits

N개의 nonnegative W-bit 값을 loss 없이 더할 때 안전한 upper bound는 `W + ceil(log2(N))` bits다. 더 정확히는 legal input maximum과 누적 횟수로 최대 합을 계산한다.

```text
maximum accumulator value = N × input_max
required bits = ceil(log2(maximum + 1))
```

Signed accumulation은 positive/negative extrema를 각각 계산한다. Cancellation을 기대해 guard bits를 줄이면 worst-case 같은 부호 입력에서 overflow한다. Saturation, block floating-point 또는 periodic normalization이 있다면 그 event와 latency까지 contract에 포함한다.

## 7. Shift는 Left Operand Width를 먼저 본다

Left shift가 precision을 자동 확장하지는 않는다. W-bit operand를 W-bit expression 안에서 `K`만큼 왼쪽으로 밀면 위 K bits는 버려질 수 있다. 보존하려면 먼저 결과 폭으로 확장한다.

```systemverilog
logic [W-1:0]   value_u;
logic [SHIFT_W-1:0] shamt;
logic [W+MAX_SHIFT-1:0] value_wide;
logic [W+MAX_SHIFT-1:0] shifted_full;

assign value_wide  = {{MAX_SHIFT{1'b0}}, value_u};
assign shifted_full = value_wide << shamt;
```

Contract에서 `shamt <= MAX_SHIFT`를 보장하거나, 더 큰 값의 결과/error를 정의한다. 일반적인 SystemVerilog shift는 shift amount를 operand width로 modulo reduction하는 것으로 가정하지 않는다. Amount가 left operand width 이상이면 logical shift 결과는 모두 zero가 되고, arithmetic right shift는 sign fill 결과가 될 수 있다. Tool-independent requirement는 explicit range check와 assertion으로 남긴다.

Right shift는 다음을 구분한다.

- `unsigned_value >> shamt`: logical right shift, zero fill
- `signed_value >>> shamt`: signed left operand의 arithmetic right shift, sign fill
- Signed vector에 `>>`를 쓰거나 unsigned vector에 `>>>`를 쓴 결과를 이름만 보고 판단하지 않는다.

Variable shift는 constant wiring이 아니라 barrel-shifter/MUX network로 mapping될 수 있다. Width와 shift range가 클수록 logic depth, area와 switching이 늘 가능성이 있다.

## 8. Datapath Boundary에서 Convert하고 Resize한다

Conversion을 operator 중간에 흩뿌리지 말고 producer/consumer boundary 또는 named normalization stage에 둔다.

```systemverilog
logic signed [W:0] normalized_value;
logic signed [W-1:0] stored_value;
logic                 range_ok;

assign range_ok = (normalized_value >= MIN_WIDE) &&
                  (normalized_value <= MAX_WIDE);

// Intentional wrap/truncation only when the interface contract permits it.
assign stored_value = normalized_value[W-1:0];
```

Slice가 보이면 다음 중 하나가 문서에 있어야 한다.

- Modulo/wrap이 정확한 functional requirement
- 앞선 range proof 때문에 잘리는 bits가 sign/zero extension뿐임
- Saturation/rounding을 먼저 수행함
- Truncation flag/error를 함께 제공함

Silent truncation warning을 전역 suppress하지 않는다. Intentional narrowing은 named intermediate, explicit slice와 assertion으로 review 가능하게 만든다.

## 9. One-Cycle Valid-Aligned Example

다음 stage는 두 unsigned W-bit 입력의 signed difference를 W+1 bits로 보존한다. Backpressure가 없는 streaming interface이며, `rst_n=1 && in_valid=1`인 모든 edge가 accepted input이다. E0 acceptance edge의 NBA 뒤 registered result가 valid해지고 downstream이 E1 edge에서 소비하므로 transaction latency는 one registered stage, initiation interval은 1이다.

```systemverilog
module unsigned_delta_stage #(
  parameter int unsigned W = 8
) (
  input  logic           clk,
  input  logic           rst_n,
  input  logic           in_valid,
  input  logic [W-1:0]   in_a,
  input  logic [W-1:0]   in_b,
  output logic           out_valid,
  output logic signed [W:0] out_delta
);
  logic signed [W:0] delta_comb;

  generate
    if (W < 1) begin : g_bad_width
      initial $fatal(1, "W must be at least 1");
    end
  endgenerate

  assign delta_comb = $signed({1'b0, in_a}) -
                      $signed({1'b0, in_b});

  // Event priority: asynchronous reset invalidates the output;
  // otherwise valid advances every cycle and accepted payload is captured.
  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      out_valid <= 1'b0;
    end else begin
      out_valid <= in_valid;
      if (in_valid)
        out_delta <= delta_comb;
    end
  end
endmodule
```

`out_valid`만 reset하며 `out_delta`는 resetless payload register다. `out_valid=0`이면 모든 consumer, assertion, debug path와 output protocol이 payload를 사용하지 않아야 한다. 그렇지 않으면 data reset이 필요하거나 interface를 바꿔야 한다. Resetless datapath의 조건은 [Resetless Datapath](../07_reset/resetless_datapath.md)를 참고한다.

| Edge | Edge 직전 input | Edge에서 downstream이 보는 output | NBA 이후 output |
|---|---|---|---|
| E0 | `in_valid=1`, A/B | invalid, reset 이후 시작 | `out_valid=1`, delta(A,B) |
| E1 | `in_valid=1`, C/D | delta(A,B)를 소비 | `out_valid=1`, delta(C,D) |
| E2 | `in_valid=0` | delta(C,D)를 소비 | `out_valid=0`, payload hold |
| E3 | `in_valid=1`, E/F | invalid, 소비 없음 | `out_valid=1`, delta(E,F) |
| E4 | edge 전에 `rst_n=0` | invalid, 소비 없음 | `out_valid=0`, payload 값은 무관 |

E1에서는 downstream이 edge 직전의 A/B result를 소비하는 동시에 C/D input을 accept할 수 있다. Clocked SVA는 E0 input을 preponed region에서 sampling하고, E0 NBA로 갱신된 output을 E1 preponed sample에서 관찰하므로 `|=>`와 한 sample 전 `$past(in_a)`, `$past(in_b)`를 사용한다. Reset assertion은 pending property를 `disable iff`로 abort한다.

## 10. Boundary Vector Audit

W-bit contract를 parameter sweep과 함께 검증한다.

| Operation | Inputs | Expected full result/관찰점 |
|---|---|---|
| Unsigned add | 0 + 0 | W+1-bit 0 |
| Unsigned add | max + 1 | carry=1, low W bits=0 |
| Unsigned add | max + max | `{1'b1,{W-1{1'b1}},1'b0}`에 해당하는 2^(W+1)-2 |
| Signed add | max + 1 | W-bit wrap은 min, W+1 full result는 positive 2^(W-1) |
| Signed add | min + (-1) | W-bit wrap은 max, W+1 full result는 negative below min |
| Unsigned difference | 0 - max | negative `-(2^W-1)` in W+1 signed |
| Multiply | max × max | `(2^W-1)^2`, 2W-bit result |
| Left shift | unextended W-bit max, amount 0/W-1/W | unchanged / low-bit-only result / zero when amount equals left width |
| Arithmetic right | min, amount 1/W | sign-filled negative / all ones at amount ≥ width |
| Mixed compare | signed -1 vs unsigned 1 | normalized signed comparison is true for -1 < 1 |
| Part-select | signed parent with high field bit 1 | field representation decides negative/unsigned meaning |

Signed `max + 1` 행은 +1이 input으로 표현 가능한 W>=2에 적용한다. W=1을 별도 감사한다. 1-bit unsigned 범위는 0..1이고 1-bit signed 범위는 -1..0이다. “1-bit signed max=1”이라는 직관은 틀리며 saturation/overflow logic에서도 이 차이가 드러난다.

## 11. Synthesis, STA와 PPA 관점

### Synthesis

Explicit extension은 carry/sign 보존 의도를 나타내지만 불필요한 physical gates를 반드시 추가하는 것은 아니다. Constant extension은 wiring으로 흡수될 수 있고, 실제 operator 폭과 macro 선택은 synthesis report/netlist에서 확인한다. 반대로 implicit truncation으로 이미 없어진 bit는 optimization이 복구하지 않는다.

### Timing

- Wider add/subtract는 carry path가 길어질 수 있다.
- Wider compare는 reduction/decode와 routing을 늘릴 수 있다.
- Full product와 variable shifter는 target macro/architecture에 따라 critical path가 될 수 있다.
- Boundary conversion을 한 곳에 몰면 review는 쉬워지지만 그 지점의 fanout, MUX와 wire load가 커질 수 있다.

### Power와 area

Width 증가는 FF, clock load, operator nodes, MUX와 routing capacitance를 늘릴 수 있다. 그러나 requirement상 필요한 carry/guard bit는 제거 대상이 아니다. Range proof로 불필요한 width를 줄이는 작업은 [Bit-Width Minimization](../05_area/bit_width_minimization.md)의 비교 절차를 따른다.

## 12. Trade-off와 적용하면 안 되는 단순화

- Full precision이 필요하지만 destination slice로 upper bits를 버리지 않는다.
- Signed range를 보존해야 하는데 `$signed`만 추가하고 sign-extension을 생략하지 않는다.
- Area 절감을 위해 accumulator guard bits를 workload 평균에 맞추지 않는다.
- Scale이 다른 fixed-point 값을 binary-point alignment 없이 더하지 않는다.
- Variable shift의 out-of-range input을 “일어나지 않음”으로만 남기지 않는다.
- Interface width 변경을 local implementation detail로 취급하지 않는다. Downstream storage, compare, serialization과 software-visible format에 영향을 줄 수 있다.

## 13. Common Mistakes

### Destination만 넓히면 carry가 보존된다고 믿는다

Operator width와 context rule을 확인하지 않고 wider LHS를 full-precision contract로 사용한다.

### `$signed`를 sign-extension 연산으로 사용한다

Cast가 interpretation만 바꾸고 range bit를 추가하지 않는다는 점을 놓친다.

### Slice 뒤 signedness를 잊는다

Signed parent의 part-select를 signed arithmetic에 바로 넣어 unsigned compare나 zero-extension을 만든다.

### Product는 destination 크기만 맞추면 된다고 생각한다

Operand normalization과 full product width를 명시하지 않아 refactoring이나 intermediate에서 truncation된다.

### Arithmetic right shift를 zero 방향 나눗셈으로 본다

Negative odd value의 `>>>`는 floor 방향이므로 truncate-toward-zero와 다르다. 자세한 rounding 의미는 다음 문서에서 다룬다.

## 14. Verification Strategy

```systemverilog
localparam logic signed [W:0] DELTA_MAX_ASSERT =
    $signed({1'b0, {W{1'b1}}});
localparam logic signed [W:0] DELTA_MIN_ASSERT = -DELTA_MAX_ASSERT;

default clocking cb @(posedge clk); endclocking
default disable iff (!rst_n);

ap_valid_alignment:
  assert property (in_valid |=> out_valid);

ap_bubble_alignment:
  assert property (!in_valid |=> !out_valid);

ap_delta_matches_accepted_input:
  assert property (
    in_valid |=>
      out_valid &&
      out_delta == ($signed({1'b0, $past(in_a)}) -
                    $signed({1'b0, $past(in_b)}))
  );

ap_delta_range:
  assert property (out_valid |->
                   out_delta >= DELTA_MIN_ASSERT &&
                   out_delta <= DELTA_MAX_ASSERT);
```

기능 검증은 wider software/reference model과 bit-exact 비교하고, lint의 implicit conversion/truncation warning을 instance별로 disposition한다.

- W=1과 최대 지원 parameter를 compile/elaborate한다.
- Zero, unsigned max, signed min/max와 sign transition을 directed test한다.
- Mixed signed/unsigned compare를 exhaustive 또는 constrained-random으로 비교한다.
- Multiply와 accumulator는 arbitrary-precision reference로 upper bits까지 확인한다.
- Shift amount 0, width-1, width와 width보다 큰 값을 포함한다.
- `out_valid=0`일 때 payload를 observer가 사용하지 않는 assertion을 integration boundary에 둔다.

## 15. Design Review Checklist

- [ ] 각 interface에 representation, legal range, scale, width와 result policy가 있는가?
- [ ] Storage, operand, expression과 destination width를 구분했는가?
- [ ] Unsigned add operand를 W+1로 zero-extend해 carry를 보존하는가?
- [ ] Signed add/sub operand를 필요한 폭으로 sign-extend했는가?
- [ ] `$signed`/`$unsigned`가 width를 자동 증가시키지 않음을 반영했는가?
- [ ] Mixed signed/unsigned operand를 공통 range와 signedness로 정규화했는가?
- [ ] Concatenation/part-select 뒤 representation을 다시 명시했는가?
- [ ] Multiply full precision과 accumulator guard bits를 range로 계산했는가?
- [ ] Left shift 전에 필요한 result width를 확보했는가?
- [ ] Logical/arithmetic right shift와 amount ≥ width 동작이 정의됐는가?
- [ ] Narrowing이 explicit slice, policy와 assertion으로 보이는가?
- [ ] Valid와 resetless payload의 observation contract가 완전한가?
- [ ] W=1, min/max, carry/borrow, sign change와 shift boundary를 검증했는가?
- [ ] Synthesis report에서 실제 operator/register width를 확인했는가?

## 관련 문서

- [Width and Signedness](../01_fundamentals/width_and_signedness.md)
- [Bit-Width Minimization](../05_area/bit_width_minimization.md)
- [Overflow, Saturation, and Rounding](overflow_saturation_rounding.md)
- [Counter Boundary Design](../09_control_logic/counter_boundary.md)
- [Pipeline Design](../03_timing/pipeline.md)
- [RTL Design Review Checklist](../15_checklist/rtl_design_review_checklist.md)
