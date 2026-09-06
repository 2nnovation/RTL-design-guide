# Bit-Width Minimization

Bit width는 requirement의 numeric range와 protocol state를 표현할 만큼 충분해야 하고, 그보다 넓다면 FF뿐 아니라 arithmetic, compare, MUX와 routing hardware가 불필요하게 커질 수 있다. 그러나 MSB를 삭제하는 것은 overflow policy와 protocol meaning을 바꾸는 기능 변경이 될 수 있다.

> Width를 줄이기 전에 legal range, intermediate growth, boundary behavior와 observer를 증명한다. Synthesis area 감소는 그 다음에 확인한다.

Width, signedness와 SystemVerilog expression semantics의 canonical 설명은 [Width and Signedness](../01_fundamentals/width_and_signedness.md)가 담당한다. 이 문서는 그 원칙을 **range-driven area optimization workflow, parameter corner와 protocol widths**에 적용한다.

## 1. Range에서 시작한다

Signal마다 다음을 기록한다.

| 항목 | 질문 |
|---|---|
| Legal minimum/maximum | 정상 동작에서 가능한 범위는? |
| Transient/intermediate | arithmetic 중 더 넓은 값이 필요한가? |
| Invalid/error input | one-past-boundary를 detect해야 하는가? |
| Numeric policy | wrap, saturate, clamp, error 중 무엇인가? |
| Protocol meaning | extra wrap/version/full bit인가? |
| Observation | external interface/debug/status가 width를 고정하는가? |
| Signedness | 음수와 ordering 의미가 있는가? |

Range evidence는 requirement, maximum event rate × window, queue capacity, address count 또는 formal invariant에서 나온다. “보통 작다”는 width proof가 아니다.

## 2. Unsigned Maximum과 필요한 Width

Unsigned `W` bit는 `0..2^W-1`을 표현한다. Inclusive maximum `MAX_VALUE=N`을 저장하려면 개념적으로 다음 width가 필요하다.

```text
minimum mathematical width = ceil(log2(N + 1))
hardware vector width       = max(1, minimum mathematical width)
```

Hardware vector guard가 필요한 이유:

- `N=0`: 한 값만 필요하지만 zero-width vector는 피해야 한다.
- `N=1`: `$clog2(2)=1`로 1 bit.
- `$clog2(1)=0`: count-of-values가 1인 parameter에서 그대로 vector width로 쓰면 illegal range를 만들 수 있다.

| Inclusive max N | Values | Minimum practical vector width |
|---:|---:|---:|
| 0 | 1 | 1 |
| 1 | 2 | 1 |
| 2 | 3 | 2 |
| 3 | 4 | 2 |
| 100 | 101 | 7 |

`N+1` 계산 자체가 parameter type range를 overflow하지 않는다는 elaboration constraint도 필요하다. Extremely large generic parameters를 지원해야 하면 wider constant type 또는 guarded function을 사용한다.

## 3. `$clog2`: Values, Index와 Maximum을 구분한다

### COUNT개의 entry index

Legal index가 `0..COUNT-1`이면:

```systemverilog
localparam int unsigned INDEX_W =
    (COUNT <= 1) ? 1 : $clog2(COUNT);
```

### Inclusive maximum MAX

Legal value가 `0..MAX`이면:

```systemverilog
localparam int unsigned VALUE_W =
    (MAX < 1) ? 1 : $clog2(MAX + 1);
```

### Occupancy of DEPTH entries

Occupancy는 empty `0`부터 full `DEPTH`까지 `DEPTH+1`개 상태를 표현한다.

```systemverilog
localparam int unsigned OCC_W =
    (DEPTH < 1) ? 1 : $clog2(DEPTH + 1);
```

`INDEX_W`와 `OCC_W`는 같은 FIFO에서도 다를 수 있다. Depth 8의 entry index는 3 bits지만 occupancy `0..8`은 4 bits다.

### Parameter legality

- `COUNT=0`이 legal한 configuration인가, elaboration error인가?
- Empty array/zero-depth FIFO를 지원하지 않는다면 assertion으로 거부한다.
- `COUNT=1`은 index bit가 논리적으로 불필요해도 SystemVerilog port/vector legality를 위해 1 bit guard를 둘 수 있다.
- Non-power-of-two depth는 unused binary encodings와 explicit wrap logic이 필요할 수 있다.

## 4. Signed Two's-Complement Range

Signed `W` bit two's-complement range는 다음과 같다.

```text
-2^(W-1) .. 2^(W-1)-1
```

Required minimum/maximum이 모두 이 범위에 들어가는 가장 작은 `W`를 선택한다. Positive maximum만 보고 width를 고르면 most-negative value를 놓칠 수 있고, negative minimum만 보면 positive side가 부족할 수 있다.

예:

| Required range | Minimum signed width |
|---|---:|
| -1..0 | 1 |
| -2..1 | 2 |
| -4..3 | 3 |
| -5..5 | 4 |

Signed/unsigned를 섞으면 extension과 comparison semantics가 바뀔 수 있다. Port, state와 intermediate signedness를 명시하고 conversion point에서 explicit cast/extension을 사용한다.

## 5. Arithmetic Intermediate Width

Destination width만 넓힌다고 carry가 자동 보존되지 않을 수 있다. Operands를 먼저 원하는 width로 확장한다.

### Unsigned addition

두 `W`-bit unsigned operands의 full-precision sum은 일반적으로 `W+1` bits가 필요하다.

```systemverilog
logic [7:0] a;
logic [7:0] b;
logic [8:0] sum_full;

assign sum_full = {1'b0, a} + {1'b0, b};
```

### Subtraction

Unsigned modulo subtraction이면 `W` bits로 wrap할 수 있다. Negative mathematical result를 보존하려면 signed result range와 extra sign/growth bit를 별도로 설계한다.

```systemverilog
logic signed [8:0] diff_full;

assign diff_full = $signed({1'b0, a}) - $signed({1'b0, b});
```

### Multiplication

Unsigned `A_W × B_W` full-precision product는 일반적으로 `A_W+B_W` bits가 필요하다. 필요한 result range가 더 작다는 proof가 있으면 truncate할 수 있지만 discarded bits와 rounding/overflow policy를 정의한다.

### Shift

Left shift expression width는 left operand width의 영향을 받는다. Shift 뒤 넓은 destination에 대입하는 것만으로 shifted-out bits가 복원되지 않는다.

```systemverilog
logic [7:0]  x;
logic [11:0] shifted;

assign shifted = {4'b0000, x} << 4;
```

Variable shift amount width와 maximum shift도 barrel structure와 output range에 영향을 준다.

### Accumulation

`K`개의 non-negative values, 각 maximum `V_MAX`를 모두 더한다면 exact maximum은 `K * V_MAX`다. 이를 저장할 width를 계산한다. 단순히 input width에 `$clog2(K)`를 더하는 rule은 convenient upper bound일 수 있지만 exact range, signedness와 parameter overflow를 확인한다.

## 6. Compare와 Constant Sizing

Comparator width와 signedness는 operands의 effective type에서 나온다.

피해야 할 모호성:

```systemverilog
if (count_q == 100)  // unsized constant/context interpretation 검토 필요
```

Width를 맞춘 constant/localparam을 사용한다.

```systemverilog
localparam logic [6:0] MAX_COUNT_VALUE = 7'd100;

if (count_q == MAX_COUNT_VALUE)
    // terminal action
```

Parameterized width에서는 sized cast를 사용할 수 있다.

```systemverilog
localparam logic [COUNT_W-1:0] MAX_VALUE = COUNT_W'(MAX_COUNT);
```

Sized cast와 parameter expression support는 사용하는 SystemVerilog toolchain에서 확인한다. Implicit truncation warning을 무시하지 않는다.

## 7. Parameterized Counter Example

Requirement:

- Count range is inclusive `0..MAX_COUNT`.
- Reset/clear set count to zero.
- Enable at `MAX_COUNT` wraps to zero.
- Event priority: reset → clear → enable → hold.
- `MAX_COUNT=0` and `1` are legal; zero-width vectors are forbidden.

```systemverilog
module bounded_counter #(
    parameter int unsigned MAX_COUNT = 100
) (
    input  logic clk,
    input  logic rst_n,
    input  logic clear,
    input  logic enable,
    output logic terminal
);
    localparam int unsigned COUNT_W =
        (MAX_COUNT < 1) ? 1 : $clog2(MAX_COUNT + 1);
    localparam logic [COUNT_W-1:0] MAX_VALUE = COUNT_W'(MAX_COUNT);

    logic [COUNT_W-1:0] count_q;

    assign terminal = (count_q == MAX_VALUE);

    // Event priority: reset > clear > enable > hold.
    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            count_q <= '0;
        end else if (clear) begin
            count_q <= '0;
        end else if (enable) begin
            if (count_q == MAX_VALUE)
                count_q <= '0;
            else
                count_q <= count_q + COUNT_W'(1);
        end
    end
endmodule
```

### Boundary cycle audit for MAX_COUNT=100

```text
edge               E0        E1        E2
count before        99        100       0
clear/enable       0/1       0/1       1/1
count after         100       0         0
winning event       enable    enable    clear
terminal after      1         0         0
```

E2에서 clear와 enable이 동시에 high이면 clear가 우선한다. `MAX_COUNT=0`이면 `COUNT_W=1`, `MAX_VALUE=0`이고 enable마다 zero를 유지한다. `MAX_COUNT=1`이면 1-bit counter가 `0↔1`로 wrap한다.

Parameter가 implementation tool의 `int unsigned` 범위 끝까지 갈 수 있다면 `MAX_COUNT+1` overflow를 별도로 guard해야 한다. 이 example은 그 범위 끝 값을 configuration으로 허용하지 않는다는 elaboration assumption을 가진다.

## 8. Width 축소가 Counter Cone에 미치는 영향

Maximum 100 counter를 32 bits에서 7 bits로 줄이면 줄 가능성이 있는 구조:

- 25 count FF bits
- Incrementer carry chain width
- Terminal comparator inputs
- Enable/clear MUX data width
- Clock/reset loads
- Fanout buffers와 routing capacitance

하지만 actual reduction은 다음에 따라 달라진다.

- Counter output이 wider interface로 확장되는가?
- Tool이 constant/terminal compare를 특수 mapping하는가?
- Enable/reset cell variants
- Count fanout와 placement
- Target library and constraints

Synthesis cell breakdown과 physical reports로 확인한다.

## 9. Modulo, Wrap, Saturation와 Error는 별도 Requirement다

### Modulo/wrap

Natural binary truncation 또는 explicit terminal wrap으로 range가 순환한다. Wrap이 protocol sequence 일부라면 MSB 제거가 behavior를 바꿀 수 있다.

### Saturation

Maximum/minimum에서 hold한다. Comparator와 MUX/control이 추가될 수 있다.

### Overflow/error

Mathematical result가 storage range 밖이면 flag, exception 또는 retry가 필요할 수 있다. Overflow bit를 제거하고 “발생하지 않는다”고 말하려면 input/rate/window bound proof가 필요하다.

### Clamp/truncate

Discarded bits의 의미와 rounding policy를 정의한다. Arithmetic intermediate를 일찍 truncate하면 final result가 달라질 수 있다.

Width 최적화는 이 정책을 조용히 modulo로 바꾸는 작업이 아니다.

## 10. Address, Pointer와 Occupancy

### Address/index

`DEPTH` entries index는 `0..DEPTH-1`을 표현한다. Non-power-of-two depth에서는 invalid codes와 wrap-at-DEPTH logic이 필요할 수 있다.

### Occupancy

`0..DEPTH`를 표현하므로 index보다 한 state가 더 필요하다. Full을 표현하지 못하는 width는 overflow detection을 깨뜨린다.

### Circular pointer extra bit

Power-of-two circular FIFO에서 read/write address bits가 같아도 wrap phase가 다를 수 있다. Extra wrap bit는 empty/full 구분 또는 version 의미를 가진다. “Address에 사용되지 않는다”는 이유로 제거하지 않는다.

### Async FIFO pointer

Gray-encoded pointer와 synchronized copies는 CDC protocol state다. Generic area optimization으로 bit를 줄이면 full/empty와 coherency를 깨뜨릴 수 있다. [Multi-Bit CDC](../08_cdc/multi_bit_cdc.md)의 async FIFO guidance를 따른다.

## 11. Implicit Signed/Unsigned Conversion

Width가 같아도 signedness가 다르면 compare와 extension 결과가 달라진다.

```systemverilog
logic signed   [7:0] signed_value;
logic unsigned [7:0] unsigned_limit;
```

직접 비교 전에 intended numeric domain으로 변환한다. Negative signed value를 unsigned로 cast하면 큰 positive pattern으로 해석될 수 있다.

권장 review:

- Port/state/intermediate declaration에 signedness 명시
- Mixed expression마다 result type 확인
- Sign/zero extension을 concatenation 또는 explicit cast로 표현
- Unsized literal과 ternary branch type 확인
- Lint warning을 suppression하기 전에 numeric proof 기록

## 12. Synthesis, STA와 Physical View

### Synthesis

Width 감소로 FF/operator/comparator/MUX cells가 줄 가능성이 있다. Constant range proof를 tool이 자동으로 항상 찾아주는 것은 아니며, external observability와 parameterization이 optimization을 제한할 수 있다.

### STA

Narrower add/compare/select path는 logic/capacitance를 줄여 setup을 개선할 가능성이 있지만 carry architecture, cell mapping와 net delay에 따라 효과가 다르다. Width conversion 또는 new saturation logic이 critical path를 만들 수도 있다.

### Physical

Bus width 감소는 routing tracks, clock/reset loads와 buffering을 줄 가능성이 있다. Fixed macro/floorplan 또는 low utilization block에서는 footprint 변화가 작을 수 있다. Post-placement evidence로 확인한다.

## 13. Timing, Power, Area Trade-off

| Width action | Timing | Power | Area | Functional risk |
|---|---|---|---|---|
| Register/bus 축소 | load/route 감소 가능 | switched capacitance 감소 가능 | FF/routing 감소 가능 | range truncation |
| Operator 축소 | carry/tree depth 감소 가능 | internal activity 감소 가능 | arithmetic cells 감소 가능 | intermediate overflow |
| Saturation 추가 | compare/MUX path 증가 | overflow activity | logic 증가 | policy 명시 |
| Extra protocol bit 유지 | control compare 영향 | toggle activity | state 증가 | full/empty/version correctness |
| Explicit extension | conversion logic 명확 | activity 조건부 | wiring/logic 조건부 | signedness correctness |

PPA benefit은 hypothesis다. Same constraints/workload에서 synthesis와 physical reports로 확인한다.

## 14. 적용하면 안 되는 경우

- Maximum이 관찰 workload에서만 작고 specification bound가 없는 경우
- Intermediate carry/product를 final destination width만 보고 자르는 경우
- Saturation/error requirement를 modulo wrap으로 바꾸는 경우
- FIFO occupancy와 wrap/version bit를 address width로만 계산하는 경우
- Signed negative range를 unsigned maximum 공식으로 계산하는 경우
- `$clog2(1)=0`을 vector width에 그대로 사용하는 경우
- Parameter `N+1` overflow 가능성을 무시하는 경우
- External interface/ABI width를 내부 area만 보고 변경하는 경우

## 15. Common Mistakes

### `$clog2(N)`에서 N의 의미를 쓰지 않는다

Entry count, inclusive maximum과 number of states를 혼동한다.

### Destination이 넓으므로 carry가 보존된다고 생각한다

Expression이 좁은 operand width에서 이미 truncate될 수 있다.

### 모든 counters에 `integer` 또는 32-bit를 사용한다

Range보다 넓은 state와 arithmetic cone을 만든다.

### Extra pointer bit를 unused로 본다

Wrap/full-empty protocol 의미를 잃는다.

### Width 축소 뒤 boundary verification을 하지 않는다

Nominal values는 통과하지만 max, one-past, wrap에서 실패한다.

### Area 감소율을 일반화한다

Library, mapping, fanout와 physical implementation 조건을 빼고 특정 수치를 rule로 만든다.

## 16. Verification Strategy

### Boundary values

- Minimum and maximum legal values
- Maximum-1, maximum, wrap/saturate edge
- One-past-maximum input 또는 event count
- Most-negative and most-positive signed values
- Zero/one parameter configurations
- Power-of-two and non-power-of-two depth

### Formal/range assertions

```systemverilog
ap_count_in_range:
    assert property (@(posedge clk) disable iff (!rst_n)
        count_q <= MAX_VALUE
    );

ap_clear_priority:
    assert property (@(posedge clk) disable iff (!rst_n)
        clear |=> (count_q == '0)
    );
```

Internal signals를 property에서 참조하는 방식과 assertion sampling은 project methodology에 맞춘다.

### Equivalence

Wider reference model에서 exact mathematical result를 계산한 뒤 selected policy에 따라 RTL width로 map한다.

- Wrap: low bits와 expected wrap compare
- Saturate: clamp before comparison
- Error: overflow flag and retained result
- Signed: sign extension and ordering

Parameterized regression에는 legal minimum parameter와 representative large/non-power-of-two cases를 포함한다. Unsupported parameter는 elaboration assertion으로 명시적으로 거부한다.

## 17. Design Review Checklist

### Range와 arithmetic

- [ ] Legal min/max와 intermediate max/min의 근거가 있는가?
- [ ] Unsigned, signed와 mixed conversion을 구분했는가?
- [ ] Addition carry, subtraction sign, product와 shift growth를 보존했는가?
- [ ] Wrap/saturate/error/truncate policy가 requirement에 있는가?

### Parameters와 protocol

- [ ] `$clog2` operand가 entry count, max value 또는 state count 중 무엇인지 명확한가?
- [ ] N=0/1과 zero-width vector를 처리했는가?
- [ ] `N+1`, multiplication과 shift parameter expression overflow를 검토했는가?
- [ ] Index, occupancy, pointer와 extra wrap/version bit를 구분했는가?
- [ ] Unsupported zero/non-power-of-two configuration을 명시했는가?

### Evidence

- [ ] Min/max/one-past/wrap/signed boundary tests가 있는가?
- [ ] Range assertion 또는 wider reference model이 있는가?
- [ ] Lint implicit-width/signedness warning을 검토했는가?
- [ ] Mapped FF/operator/comparator/MUX width를 확인했는가?
- [ ] Timing/power/area와 physical routing 변화를 같은 조건에서 비교했는가?

## 관련 문서

- [Oversized Register](../14_anti_patterns/oversized_register.md): reachable range가 없는 wide state의 탐지와 증거
- [Area Design & Optimization](overview.md)
- [FSM and Counter Encoding](fsm_counter_encoding.md)
- [Width and Signedness](../01_fundamentals/width_and_signedness.md)
- [Buffering and Backpressure](../02_architecture/buffering_and_backpressure.md)
- [Counter Optimization](../04_low_power/counter_optimization.md)
- [Counter Boundary Design](../09_control_logic/counter_boundary.md)
- [Datapath Width and Signedness](../10_datapath/width_signedness.md)
- [Multi-Bit CDC](../08_cdc/multi_bit_cdc.md)
- [RTL Design Review Checklist](../15_checklist/rtl_design_review_checklist.md)
