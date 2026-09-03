# Width and Signedness

## 1. Overview

Bit width와 signedness는 단순한 type annotation이 아니다. 이 둘은 register bit 수, arithmetic range, extension/truncation, comparator semantics와 합성되는 operator 크기를 결정한다.

같은 `+`, `<`, `>>`도 operand width와 signedness가 달라지면 다른 결과와 hardware가 될 수 있다. Simulation에서 작은 test value만 사용하면 overflow, negative comparison과 implicit conversion 오류가 드러나지 않을 수 있다.

> Width는 저장할 수 있는 정보의 범위를 정하고, signedness는 그 bit pattern을 어떤 수로 해석할지 정한다.

공통 용어는 [Canonical RTL Design Terminology](terminology.md), operator를 hardware로 해석하는 방법은 [Think Hardware, Not Code](think_hardware_not_code.md)를 따른다.

## 2. Why It Matters

Width가 필요 이상으로 크면 다음 hardware도 함께 커질 수 있다.

- FF와 reset/enable MUX
- Adder, subtractor, comparator와 shifter
- Data MUX와 bus routing
- Fanout buffer와 clock/reset load
- Switching capacitance와 physical congestion

반대로 width가 부족하면 overflow, wrap, truncation과 address alias가 생긴다. Signedness가 잘못되면 같은 bit pattern을 전혀 다른 값으로 비교하거나 확장할 수 있다.

```text
8'b1111_1111

unsigned interpretation: 255
signed two's-complement interpretation: -1
```

RTL review에서는 “몇 bit인가?”뿐 아니라 다음을 묻는다.

- 가능한 최소값과 최대값은 무엇인가?
- Intermediate operation에서 몇 bit가 증가하는가?
- Overflow는 불가능한가, wrap하는가, saturate하는가?
- Negative 값이 가능한가?
- Mixed signed/unsigned expression이 있는가?
- Truncation이 의도라면 어느 bit를 버리며 어떤 error를 허용하는가?

## 3. Range First, Declaration Second

Width는 관성적으로 `int` 또는 32-bit를 선택하지 말고 requirement range에서 계산한다.

| Type | W-bit range |
|---|---|
| Unsigned | `0` to `2^W - 1` |
| Signed two's complement | `-2^(W-1)` to `2^(W-1) - 1` |

예를 들어 `0`부터 `100`까지 포함해야 하는 unsigned counter에는 7 bit가 필요하다.

```text
2^6 - 1 = 63    → insufficient
2^7 - 1 = 127   → sufficient
```

Parameter로 표현할 때는 maximum value와 number of entries를 혼동하지 않는다.

```systemverilog
parameter int unsigned MAX_COUNT = 100;

localparam int unsigned COUNT_W =
    (MAX_COUNT < 1) ? 1 : $clog2(MAX_COUNT + 1);

logic [COUNT_W-1:0] count_q;
```

`MAX_COUNT`가 inclusive maximum이면 `MAX_COUNT + 1`개의 값을 표현해야 한다. 또한 `$clog2(1)`은 0이므로 parameter가 0 또는 1이 될 수 있는 generic design에서는 최소 width guard가 필요하다.

Range 분석에는 정상 동작뿐 아니라 다음 조건도 포함한다.

- Maximum transaction/window length
- Back-to-back event의 최대 rate
- Accumulation 횟수
- Protocol error 중 임시 범위
- Parameter minimum/maximum
- Future configuration을 실제 requirement에 포함할지 여부

## 4. Arithmetic Growth

### 4.1 Addition

두 W-bit unsigned 값을 loss 없이 더하려면 최대 W+1 bit가 필요하다.

```systemverilog
logic [7:0] a;
logic [7:0] b;
logic [8:0] sum_full;

assign sum_full = {1'b0, a} + {1'b0, b};
```

Operand를 명시적으로 확장하면 carry 보존 의도가 분명하다. 다음처럼 destination이 8-bit이면 overflow carry는 저장할 수 없다.

```systemverilog
logic [7:0] sum_wrapped;

assign sum_wrapped = a + b;
```

Wrap이 protocol 정의라면 올바를 수 있다. 그렇지 않다면 overflow flag, wider result 또는 saturation이 필요하다.

### 4.2 Subtraction

Unsigned input의 차이는 음수가 될 수 있다. 결과를 signed로 보존하려면 operand를 양의 signed 값으로 확장한 뒤 계산한다.

```systemverilog
logic signed [8:0] delta;

assign delta = $signed({1'b0, a}) -
               $signed({1'b0, b});
```

단순히 8-bit unsigned subtraction 후 wider signed destination에 넣는 방식에 의존하면 underflow bit pattern과 extension 의미를 오해하기 쉽다.

### 4.3 Accumulation

최대 N개의 W-bit unsigned 값을 합한다면 worst-case range를 계산한다.

```text
maximum sum = N × (2^W - 1)
required width = ceil(log2(maximum sum + 1))
```

`W + ceil(log2(N))`는 널리 쓰는 안전한 upper bound지만 exact range와 parameter edge를 확인한다. Saturation, early termination 또는 input range 제한이 있다면 requirement에 근거해 줄일 수 있다.

### 4.4 Multiplication

W_A-bit와 W_B-bit unsigned operand의 full-precision product에는 최대 `W_A + W_B` bit가 필요하다. Expression sizing rule을 암묵적으로 기대하기보다 operand/result width를 의도적으로 만든다.

```systemverilog
logic [7:0]  multiplicand;
logic [7:0]  multiplier;
logic [15:0] multiplicand_ext;
logic [15:0] multiplier_ext;
logic [15:0] product_full;

assign multiplicand_ext = {8'b0, multiplicand};
assign multiplier_ext   = {8'b0, multiplier};
assign product_full     = multiplicand_ext * multiplier_ext;
```

Extended upper bits가 항상 0이라는 사실을 tool이 이용할 수 있으므로 이 표현이 반드시 16×16 physical multiplier를 강제한다는 뜻은 아니다. 실제 mapping은 synthesis report로 확인한다.

### 4.5 Shift

Left shift로 precision을 보존하려면 shift amount만큼 result width가 더 필요할 수 있다. 기존 width 안에서 shift하면 위쪽 bit는 버려진다.

Right shift는 signedness에 따라 의미가 달라진다.

```systemverilog
logic signed [15:0] signed_data;
logic        [3:0]  shift_amount;
logic signed [15:0] arithmetic_result;

assign arithmetic_result = signed_data >>> shift_amount;
```

`>>>`는 arithmetic right shift를 표현하지만 left operand가 올바르게 signed로 해석되는지 확인해야 한다. `>>`는 logical right shift이며 upper bit를 0으로 채운다.

## 5. Signed and Unsigned Expressions

### 5.1 Declare intent at the boundary

```systemverilog
logic signed [7:0] temperature;
logic        [7:0] threshold;
```

Mixed signed/unsigned comparison은 language conversion rule에 따라 예상과 다른 unsigned interpretation을 만들 수 있다. 비교 전에 같은 width와 signed interpretation으로 정규화한다.

```systemverilog
logic signed [8:0] temperature_ext;
logic signed [8:0] threshold_ext;
logic              below_threshold;

assign temperature_ext = $signed({temperature[7], temperature});
assign threshold_ext   = $signed({1'b0, threshold});
assign below_threshold = (temperature_ext < threshold_ext);
```

여기서 `threshold`는 0부터 255까지를 9-bit signed positive range로 표현하고, `temperature`는 sign-extension한다.

### 5.2 Cast changes interpretation; it may not add range

`$signed(expression)`과 `$unsigned(expression)`는 expression의 signed interpretation을 바꾸는 데 사용한다. Cast만 추가했다고 자동으로 필요한 result width가 생기는 것은 아니다. 먼저 range에 맞는 bit 수를 확보한 뒤 signedness를 명확히 한다.

### 5.3 Concatenation and part-select

Concatenation result와 part-select는 원래 vector가 signed였더라도 unsigned expression으로 다뤄질 수 있다. Signed arithmetic에 사용할 slice는 의도를 다시 표현한다.

```systemverilog
logic signed [15:0] packed_value;
logic signed [7:0]  low_signed;

assign low_signed = $signed(packed_value[7:0]);
```

다만 lower 8 bit를 signed로 재해석하는 것이 원래 16-bit 수의 값을 보존한다는 뜻은 아니다. 이 코드는 명시적인 truncation과 reinterpretation이다.

### 5.4 Literal sizing

Unsized literal은 expression width와 signedness에 예상하지 않은 영향을 줄 수 있다. Hardware width가 중요한 arithmetic에서는 sized literal이나 width가 명확한 localparam을 사용한다.

```systemverilog
count_q <= count_q + 1'b1;
mask    = 16'h00FF;
value   = '0;
```

`'0`는 assignment context의 width에 맞춰 모든 bit를 0으로 채우는 unbased unsized literal이므로 register clear에 유용하다. 반면 일반 unsized decimal literal은 `int` 계열의 signedness와 최소 크기가 expression에 섞일 수 있으므로 lint warning을 확인한다.

Negative sized literal은 sign 위치도 주의한다.

```systemverilog
logic signed [7:0] minus_one;

assign minus_one = -8'sd1;
```

## 6. Expression Sizing: Avoid Clever Assumptions

SystemVerilog에는 self-determined expression과 surrounding assignment/operator context에 영향을 받는 context-determined expression이 모두 있다. Operator별 sizing과 conversion rule을 한 문장으로 단순화하면 corner case를 만들기 쉽다.

실무에서는 다음 원칙이 더 안전하다.

1. Interface와 state declaration에 range intent를 명시한다.
2. Carry, sign과 full precision이 필요한 operand를 연산 전에 확장한다.
3. Mixed signed/unsigned operand를 같은 width와 signedness로 정규화한다.
4. Truncation은 named intermediate 또는 explicit slice로 review 가능하게 만든다.
5. Unsized literal과 implicit cast warning을 lint에서 확인한다.
6. Parameter minimum/maximum configuration을 compile하고 검증한다.

Wider destination을 선언했다는 사실만으로 carry/sign intent가 충분히 문서화됐다고 보지 않는다. 명시적 extension은 reader, simulator, lint와 synthesis가 같은 의도를 보도록 돕는다.

## 7. Truncation, Wrap and Saturation

Truncation이 항상 오류는 아니다. Protocol이 modulo arithmetic을 요구하거나 fixed-point format에서 특정 bit를 선택할 수 있다. 중요한 것은 behavior가 우연이 아니라 specification이어야 한다는 점이다.

| Policy | Behavior | Hardware cost |
|---|---|---|
| Wrap | Upper carry를 버리고 modulo range로 돌아감 | 가장 단순할 수 있음 |
| Flag | Result와 overflow/underflow flag 제공 | Detection logic 추가 |
| Saturate | 최대/최소값에 고정 | Compare와 selection logic 추가 |
| Wider result | Full range 보존 | Datapath/register/routing width 증가 |

Saturation은 overflow를 없애는 무료 기능이 아니다. Comparator, detect logic와 MUX가 timing, area와 switching에 영향을 줄 수 있다.

## 8. Four-State Simulation Basics

SystemVerilog `logic`은 simulation에서 `0`, `1`, `X`, `Z`를 표현할 수 있다. 실제 digital cell의 정상 logic state는 0/1이지만 X는 다음 문제를 발견하는 modeling 도구다.

- Reset되지 않은 state 사용
- Multiple driver 또는 contention
- Incomplete assignment
- Illegal state와 unknown control
- Testbench initialization 누락

`X`를 실제 metastability 값처럼 해석해서는 안 된다. CDC metastability는 analog phenomenon이며 RTL simulation만으로 직접 표현하거나 증명할 수 없다.

### Equality operators

- `==`, `!=`는 X/Z가 포함되면 결과가 X가 될 수 있다.
- `===`, `!==`는 X/Z bit까지 포함해 0 또는 1을 반환한다.

Case equality는 testbench와 diagnostic에 유용하지만 silicon에서 X를 감지하는 hardware를 뜻하지 않는다. Synthesizable control에 사용할 때는 tool support와 실제 0/1 hardware 의미를 명확히 확인한다.

### Wildcard decode

`casex`는 X와 Z를 wildcard로 취급해 uninitialized control이나 illegal state를 숨길 수 있으므로 일반적인 synthesizable control decode에서 피한다. `casez`와 `?`를 사용하는 경우에도 어떤 bit가 don't-care인지 명시하고 overlap을 검증한다.

## 9. Synthesis View

| RTL observation | Synthesis에서 확인할 항목 |
|---|---|
| Counter width | FF 수, incrementer와 compare width |
| Extended addition | Carry bit와 adder result width |
| Mixed signed comparison | Sign/zero extension과 comparator interpretation |
| Multiplication | Effective operand width, macro/inferred structure |
| Variable shift | Shifter width와 MUX levels |
| Explicit truncation | Removed bits와 downstream range assumption |
| Saturation | Overflow detect, compare와 selection logic |

Synthesis warning에서 width mismatch, signed conversion, truncated value와 constant out-of-range를 확인한다. Warning을 일괄 suppress하기보다 각 instance가 의도인지 기록한다.

## 10. Timing Impact

Width가 넓어질수록 arithmetic carry path, compare reduction, MUX data width와 routing capacitance가 증가할 수 있다. 영향 정도는 operator architecture와 library에 따라 달라진다.

- Wide adder/subtractor: carry propagation 또는 prefix network 증가
- Wide comparator: equality/ordering reduction logic 증가
- Variable shifter: width × shift-control MUX network 증가
- Wide counter enable: incrementer, MUX와 fanout 증가
- Unnecessary extension: downstream operator와 register까지 폭이 전파됨

Width 축소는 [Critical Path](../03_timing/critical_path.md)의 simplify 단계에서 검토하지만, range proof 없이 timing을 위해 bit를 버리면 functional bug다.

## 11. Power Impact

- Toggle하는 bit와 internal operator node가 줄면 dynamic activity와 capacitance가 감소할 수 있다.
- Counter LSB는 자주 toggle하고 upper bit는 드물게 toggle하지만, clock pin은 모든 FF에 edge를 전달할 수 있다.
- Wide bus는 driver, MUX와 routing capacitance를 늘린다.
- Sign/zero-extension 자체는 wiring일 수 있지만 확장된 width가 큰 operator와 register에 들어가면 비용이 생긴다.
- Saturation과 overflow detection은 추가 switching을 만든다.

실제 power 효과는 activity workload와 physical capacitance로 측정한다.

## 12. Area Impact

Width 축소는 FF 수뿐 아니라 연결된 adder, comparator, MUX, reset/enable network와 routing을 줄일 가능성이 있다. 그러나 parameter guard, saturation 또는 narrow storage를 위한 pack/unpack logic이 추가될 수도 있다.

또한 interface width를 바꾸면 여러 downstream block과 memory layout에 영향을 줄 수 있다. Local saving만 보지 말고 conversion boundary와 integration cost를 포함한다.

## 13. Common Mistakes

### 최대값이 100인데 6 bit를 사용한다

6 bit maximum은 63이다. 값의 개수가 아니라 inclusive maximum을 실제 range로 확인한다.

### Destination만 넓히면 carry가 명확하다고 생각한다

Expression sizing rule과 reader 해석에 의존하지 말고 carry가 필요한 operand를 연산 전에 명시적으로 확장한다.

### Signed signal과 unsigned constant를 직접 비교한다

Mixed comparison은 예상과 다른 unsigned conversion을 만들 수 있다. 같은 width/signedness로 정규화한다.

### `$signed`가 width까지 늘린다고 생각한다

Cast는 interpretation을 명확히 하지만 필요한 range를 자동으로 제공하지 않는다.

### `$clog2(N)`을 모든 N에 그대로 vector width로 사용한다

N=0/1, inclusive maximum과 number of entries를 구분하고 minimum width를 guard한다.

### Truncation warning을 무조건 제거하거나 무시한다

의도된 truncation은 source range, selected bits와 numerical error를 문서화하고 검증한다.

### X를 convenient don't-care로 남발한다

Simulation과 synthesis가 X를 다르게 활용하면 mismatch 위험이 있다. Don't-care는 proof, constraints와 verification policy 안에서 사용한다.

## 14. Recommended Pattern

1. 각 interface/state의 physical 또는 protocol range를 기록한다.
2. Min/max와 signed requirement에서 width를 계산한다.
3. Arithmetic 단계별 full-precision intermediate range를 계산한다.
4. Overflow policy를 wrap/flag/saturate/widen 중에서 정한다.
5. Mixed operand를 연산 전에 동일한 width와 signedness로 정규화한다.
6. Extension과 truncation을 명시적으로 작성한다.
7. Parameter boundary configuration과 negative/maximum value를 검증한다.
8. Lint와 synthesis report에서 실제 inferred width와 warning을 확인한다.
9. Timing/area/power 변화는 report로 측정한다.

## 15. Verification Strategy

- Minimum, maximum, zero, one, negative와 sign-boundary 값을 test한다.
- Addition carry, subtraction underflow와 multiplication maximum을 확인한다.
- Wrap, saturation과 overflow flag policy를 assertion/reference model과 비교한다.
- Signed/unsigned mixed input의 ordering을 exhaustive 또는 constrained-random으로 확인한다.
- Parameter 0/1/min/max configuration이 elaboration되는지 확인한다.
- Truncation 전후의 numerical error와 discarded bit condition을 검증한다.
- Lint warning의 intentional waiver에는 range 근거와 owner를 남긴다.

## 16. Design Review Checklist

- [ ] 모든 register와 interface의 min/max range가 정의되어 있는가?
- [ ] Inclusive maximum과 number of entries를 구분했는가?
- [ ] `$clog2`의 0/1 parameter edge를 처리했는가?
- [ ] Addition, subtraction, accumulation과 multiplication의 growth를 계산했는가?
- [ ] Overflow policy가 wrap/flag/saturate/wider result 중 명확한가?
- [ ] Signed/unsigned operand가 같은 width와 interpretation으로 정규화되는가?
- [ ] Carry와 sign extension이 RTL에 명시적으로 보이는가?
- [ ] Truncation되는 bit와 허용 error가 specification에 있는가?
- [ ] Shift operator와 left operand signedness가 의도와 일치하는가?
- [ ] Unsized literal과 implicit cast warning을 검토했는가?
- [ ] X/Z behavior가 simulation policy와 일치하는가?
- [ ] Synthesis operator/register width가 예상과 일치하는가?
- [ ] Width 축소의 integration, timing, power와 area 영향을 측정했는가?

Range-driven area optimization, parameter guard와 FIFO occupancy/pointer width 적용은 [Bit-Width Minimization](../05_area/bit_width_minimization.md)을 참고한다. 실제 datapath boundary의 operand normalization과 resize는 [Datapath Width and Signedness](../10_datapath/width_signedness.md), overflow와 fixed-point 정책은 [Overflow, Saturation, and Rounding](../10_datapath/overflow_saturation_rounding.md)을 참고한다. 전체 검토에는 [RTL Design Review Checklist](../15_checklist/rtl_design_review_checklist.md)를 함께 사용한다.
