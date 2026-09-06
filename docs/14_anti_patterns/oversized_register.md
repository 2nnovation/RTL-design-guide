# Oversized Register

필요한 범위보다 넓은 register는 “여유 있게 잡은 것”처럼 보이지만, 그 width가 adder, comparator, MUX, routing과 fanout cone 전체로 전파될 수 있다. 반대로 width를 무작정 줄이면 terminal off-by-one, overflow, signed conversion, protocol encoding과 parameter corner에서 기능이 깨진다.

이 문서는 [Bit-Width Minimization](../05_area/bit_width_minimization.md)과 [Width and Signedness](../01_fundamentals/width_and_signedness.md)를 정본으로 두고, review에서 **reachable range와 encoding 근거가 없는 oversized state**를 찾고 수정의 증거를 정의한다.

## 1. 문제: 습관적으로 32비트 선언

최댓값이 12인 saturating retry counter를 다음처럼 선언했다고 하자.

```systemverilog
logic [31:0] retry_count_q;

always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n)
        retry_count_q <= 32'd0;
    else if (retry_event && (retry_count_q != 32'd12))
        retry_count_q <= retry_count_q + 32'd1;
end
```

13개 값 `0..12`를 표현하는 데 4비트면 충분하다. 32비트 선언은 최대 32개의 FF만의 문제가 아니다. 합성과 constant/range proof가 상위 bit를 제거하지 못하면 32비트 incrementer, equality compare, feedback MUX와 배선이 생긴다.

다음 신호는 width 근거가 특히 자주 빠진다.

- Counter, timeout, retry와 occupancy
- FIFO pointer와 index
- FSM encoding 또는 one-hot vector
- Shift amount와 address offset
- Accumulator, intermediate arithmetic와 packet length
- Parameter로 크기가 달라지는 array selector

## 2. 먼저 range와 encoding을 정의한다

“최댓값 12”와 “13개 entry”는 같은 width 결과를 낼 수 있지만 의미는 다르다. Review record에는 적어도 다음을 구분한다.

- **Reachable minimum/maximum**: reset, increment/decrement, load를 포함해 실제 도달 가능한 범위
- **Encoding**: binary, one-hot, Gray, sign-magnitude 등 값 외의 bit 의미
- **Boundary policy**: wrap, saturate, block, error 또는 truncate
- **Intermediate range**: addition carry, multiply product, shift와 rounding 이전 값
- **Protocol bits**: FIFO wrap/version, ECC/parity, sign, tag와 reserved field
- **Illegal values**: 도달 불가로 가정하는지, detect/recover해야 하는지

Unsigned inclusive maximum `MAX_VALUE`를 표현하는 최소 width는 수학적으로 다음과 같다.

```text
W = max(1, ceil(log2(MAX_VALUE + 1)))
```

최소 1비트를 강제하는 이유는 SystemVerilog의 zero-width vector를 피하기 위해서다. 그러나 이 식만으로 pointer나 arithmetic width가 결정되는 것은 아니다. 예를 들어 depth가 power-of-two인 FIFO pointer에는 full/empty 구분용 wrap bit가 추가될 수 있다.

## 3. Oversize가 hardware에 미치는 영향

### 3.1 FF와 control

불필요한 bit가 보존되면 sequential cell 수, clock pin capacitance와 reset/enable load가 늘어난다. Resettable/enable 조합에 따라 cell 선택 또는 feedback MUX 비용도 달라질 수 있다.

### 3.2 Arithmetic와 compare

Register width가 incrementer, subtractor, comparator로 전파되면 carry chain과 compare reduction tree가 넓어진다. Critical path가 width에 정확히 선형 비례한다고 단정할 수는 없지만, target mapping과 placement에 따라 logic depth, cell size와 route length가 증가할 수 있다.

### 3.3 MUX, routing와 fanout

Wide state가 여러 consumer와 MUX branch로 복제되면 data pin, wire capacitance와 congestion이 증가한다. Equality compare 결과 같은 1-bit control도 high fanout이면 별도의 physical cost를 만든다. 따라서 FF count만 보고 최적화 효과를 평가하지 않는다.

### 3.4 Power

상위 bit가 실제로 toggle하지 않으면 data activity는 낮을 수 있지만 clocked FF 자체의 internal/clock power와 routing capacitance는 남을 수 있다. 반대로 arithmetic carry나 uninitialized/stale upper bit가 움직이면 downstream activity도 생긴다. 정확한 영향은 representative activity와 mapped/post-route power로 확인한다.

## 4. `$clog2`를 맹목적으로 쓰지 않는다

다음 선언은 자주 보이지만 parameter 의미와 corner에 따라 틀릴 수 있다.

```systemverilog
logic [$clog2(MAX_VALUE)-1:0] count_q;
```

문제는 다음과 같다.

- Inclusive max가 아니라 `MAX_VALUE`개의 entry를 표현하는 식처럼 해석될 수 있다.
- `MAX_VALUE=0` 또는 `1`이면 zero/negative range가 될 수 있다.
- `MAX_VALUE+1` 계산이 parameter type width에서 overflow할 수 있다.
- Signed parameter나 unsized literal이 예상치 못한 signedness/width를 만들 수 있다.
- Pointer extra bit, illegal encoding과 intermediate carry를 설명하지 못한다.

`$clog2`는 잘못된 함수가 아니라 **operand 의미가 명시돼야 하는 함수**다. Entry count라면 index range가 `0..DEPTH-1`인지, inclusive max라면 `0..MAX_VALUE`인지 이름과 check로 구분한다.

## 5. Parameter-safe helper와 W=1 처리

다음 helper는 unsigned inclusive maximum을 표현할 bit 수를 계산하며 `MAX_VALUE=0`과 `1`에도 1을 반환한다. `longint unsigned` 범위 안의 parameter를 대상으로 한다.

```systemverilog
package width_util_pkg;
    function automatic int unsigned bits_for_max(
        input longint unsigned max_value
    );
        longint unsigned remaining;
        int unsigned     width;

        remaining = max_value;
        width     = 1;

        while (remaining > 1) begin
            remaining = remaining >> 1;
            width++;
        end

        return width;
    endfunction
endpackage
```

이를 사용한 saturating counter는 다음과 같다.

```systemverilog
module saturating_event_counter #(
    parameter longint unsigned MAX_VALUE = 12,
    localparam int unsigned COUNT_W =
        width_util_pkg::bits_for_max(MAX_VALUE)
) (
    input  logic               clk,
    input  logic               rst_n,
    input  logic               event_i,
    output logic [COUNT_W-1:0] count_q
);

    localparam logic [COUNT_W-1:0] MAX_COUNT = COUNT_W'(MAX_VALUE);

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n)
            count_q <= '0;
        else if (event_i && (count_q != MAX_COUNT))
            count_q <= count_q + COUNT_W'(1);
    end

endmodule
```

이 예의 policy는 `0..MAX_VALUE`에서 saturate이며 priority는 `reset > event increment > hold`다. `MAX_VALUE=0`이면 `COUNT_W=1`, `MAX_COUNT=0`이고 counter는 계속 0을 유지한다. `MAX_VALUE=1`도 1비트로 0과 1을 표현한다.

실제 project에서는 helper를 package에 두거나 localparam 식을 사용할 수 있다. Tool의 supported SystemVerilog subset, function visibility와 parameter override 규칙을 compile/elaboration으로 확인한다. `MAX_VALUE`보다 넓은 arbitrary-precision parameter가 필요하다면 `longint` helper를 그대로 확장하지 말고 명시적인 supported range와 elaboration check를 둔다.

## 6. Off-by-one과 boundary 실패

Width 축소에서 가장 흔한 bug는 수학식보다 **값의 의미**를 잘못 정의하는 것이다.

### Terminal value를 저장하는가

`0..N-1`을 저장하고 N번째 event에서 wrap하는 counter와 `0..N`을 저장한 뒤 다음 event에서 wrap하는 counter는 width와 terminal compare가 다르다. “N cycles”라는 자연어만으로 결정하지 않는다.

### Wrap인가 saturate인가

Narrow vector의 overflow는 modulo wrap이다. Saturation이 필요하면 terminal condition에서 update를 막거나 max를 선택해야 한다. Error policy라면 overflow attempt를 별도 flag로 관찰할 수 있어야 한다.

### Load path가 범위를 넓히는가

Increment 경로만 보면 max가 작아도 software/configuration load가 더 큰 값을 쓸 수 있다. Illegal load를 clamp, reject, truncate 또는 accept할지 정의한다.

### Signed인가 unsigned인가

Negative value가 가능한 delta/accumulator에는 sign bit와 intermediate growth가 필요하다. Unsigned range 공식으로 signed arithmetic register를 줄이지 않는다. Mixed signedness와 literal 규칙은 [Width and Signedness](../01_fundamentals/width_and_signedness.md)를 따른다.

### Parameter가 극단값인가

`N=0`, `N=1`, power-of-two, one-below/one-above power-of-two와 최대 supported value에서 elaboration, compare와 cast를 검증한다. Boundary 설계는 [Counter Boundary Design](../09_control_logic/counter_boundary.md)을 참고한다.

## 7. 합성이 알아서 제거할 수 있는 경우와 한계

상위 bit가 constant이고 어떤 observer에도 영향을 주지 않는다는 것을 tool이 증명하면 constant propagation과 unused logic removal로 제거될 수 있다. 예를 들어 Yosys의 공식 최적화 문서도 unused signal/cell과 일부 unused bit 정리를 설명한다. Commercial tool도 유사한 최적화를 수행할 수 있지만 이름, 범위와 결과는 flow마다 다르다.

다음 조건은 제거를 방해하거나 상위 bit를 observable하게 만들 수 있다.

- Top-level output, debug/trace, scan 또는 `keep`/`dont_touch` 속성
- Wide equality/range compare, reduction operation와 case statement
- Reset/load가 상위 bit에 nonconstant 값을 씀
- Black box, DPI, memory/interface boundary 또는 separate compilation
- Formal/equivalence의 unknown/initial-state model
- Parameter/configuration이 compile time constant가 아님

따라서 “어차피 합성이 줄인다”는 review 답변은 report/netlist evidence가 있을 때만 유효하다. RTL width를 의도에 맞추면 lint, review와 downstream tool이 같은 range contract를 이해하기도 쉽다.

## 8. 의도적으로 넓게 유지하는 예외

다음에는 reachable numeric range보다 넓은 encoding이 정당할 수 있다.

- External interface/protocol이 고정 width field를 요구한다.
- Memory macro byte/word granularity 또는 bus beat alignment를 맞춘다.
- ECC/parity, sign, wrap/version, poison와 metadata bit를 포함한다.
- One-hot/Gray/redundant encoding이 timing, CDC 또는 safety goal에 필요하다.
- Stable register map과 검증된 future configurability를 위해 reserved bit를 유지한다.
- Datapath의 full precision을 유지한 뒤 명시적 rounding/saturation을 적용한다.

“나중에 쓸 수도 있다”만으로는 충분하지 않다. Future configurability가 requirement라면 supported future range, interface compatibility, current PPA cost와 재검토 trigger를 decision record에 남긴다. Macro granularity 예외도 RTL 전체 arithmetic를 같은 폭으로 유지해야 한다는 뜻은 아니다. Storage boundary와 compute width를 분리할 수 있다.

## 9. Verification과 evidence

### 범위와 boundary test

- Minimum, maximum, maximum-1와 one-past-maximum attempt
- Zero/one event, back-to-back event와 simultaneous clear/load
- Wrap/saturate/block/error 동작
- `MAX_VALUE=0`, `1`, power-of-two 경계와 representative large value
- Signed minimum/maximum과 sign transition
- Illegal load 및 unreachable encoding recovery

### Property와 reference model

Wider mathematical reference model에서 exact value를 계산한 뒤 selected boundary policy로 RTL width에 map한다. Reachability property는 environment assumption을 과도하게 사용하지 않도록 negative test와 cover를 함께 둔다.

```systemverilog
ap_count_in_range:
    assert property (@(posedge clk) disable iff (!rst_n)
        count_q <= MAX_COUNT);

ap_saturates_at_max:
    assert property (@(posedge clk) disable iff (!rst_n)
        (event_i && (count_q == MAX_COUNT)) |=> (count_q == MAX_COUNT));
```

Second property의 antecedent가 실제로 도달하는지 cover하고, sampling/NBA semantics를 project convention에 맞게 확인한다.

### Implementation evidence

- Lint/elaboration: implicit truncation, signedness, zero-width와 unsupported parameter
- Synthesis: generic register bits와 mapped FF, adder/comparator/MUX width
- Netlist cone: 상위 bit가 제거됐는지, debug/reset/compare가 보존했는지
- STA: arithmetic/compare와 high-fanout terminal path
- Power/physical: clock load, data activity, route length와 congestion
- Equivalence: width change 전후 reset, illegal/unreachable state와 X semantics

Evidence는 같은 top, parameter/define, constraint, library와 physical stage에서 비교한다. [Reading Synthesis Reports](../11_synthesis/read_synthesis_reports.md)와 [Lint, Formal, and Equivalence](../13_verification/lint_formal_equivalence.md)가 provenance와 proof 해석의 정본이다.

## 10. Design Review Checklist

- [ ] Register마다 reachable min/max와 그 근거가 있는가?
- [ ] Entry count, inclusive max와 state count를 구분했는가?
- [ ] Terminal value를 저장하는지와 off-by-one policy가 명확한가?
- [ ] Wrap/saturate/block/error/truncate가 specification에 있는가?
- [ ] Intermediate carry/product/shift와 signed range를 보존했는가?
- [ ] `$clog2` operand 의미와 `N=0/1` corner를 검토했는가?
- [ ] Parameter arithmetic overflow와 explicit cast를 확인했는가?
- [ ] Pointer wrap/version, ECC/parity와 protocol bit를 숫자 범위와 구분했는가?
- [ ] FF뿐 아니라 adder/comparator/MUX/routing/fanout width를 확인했는가?
- [ ] Tool이 제거할 것이라는 주장을 synthesis report와 netlist로 증명했는가?
- [ ] Interface/macro/safety/future-config 예외의 requirement와 cost가 기록됐는가?
- [ ] Boundary regression, range assertion와 equivalence evidence가 있는가?

## 관련 문서

- [Bit-Width Minimization](../05_area/bit_width_minimization.md): range, arithmetic growth와 parameter corner
- [Width and Signedness](../01_fundamentals/width_and_signedness.md): SystemVerilog expression과 conversion 규칙
- [Canonical RTL Design Terminology](../01_fundamentals/terminology.md): PPA와 공통 용어
- [Counter Boundary Design](../09_control_logic/counter_boundary.md): terminal level/event와 wrap/saturate/block
- [Datapath Width and Signedness](../10_datapath/width_signedness.md): arithmetic width와 explicit resize
- [Constant and Dead Logic](../11_synthesis/constant_dead_logic.md): constant propagation과 removal evidence
- [Reading Synthesis Reports](../11_synthesis/read_synthesis_reports.md): generic/mapped object와 provenance

## 참고 자료

- [Yosys, Optimization passes](https://yosyshq.readthedocs.io/projects/yosys/en/v0.56/using_yosys/synthesis/opt.html): unused signal·cell·bit 제거를 포함한 공개 합성 최적화 예시
