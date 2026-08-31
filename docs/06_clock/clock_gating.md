# Clock Gating

Clock gating은 사용하지 않는 sequential logic에 clock edge가 전달되지 않도록 하여 clock network와 flip-flop의 불필요한 switching을 줄이는 기법이다. 잘 적용하면 dynamic power를 크게 줄일 수 있지만, clock은 일반 data signal과 다르기 때문에 단순한 Boolean 최적화처럼 다루어서는 안 된다.

> Clock gating의 출발점은 `clk`에 AND gate를 붙이는 것이 아니라, **어떤 state가 언제 멈춰도 기능적으로 안전한지 정의하는 것**이다.

이 문서는 positive-edge-triggered flip-flop을 기준으로 설명한다. 실제 구현과 sign-off 방식은 target technology, library, synthesis·DFT·STA·P&R flow에 따라 달라질 수 있다.

## 1. Why It Matters

CMOS dynamic power의 1차 근사는 다음과 같다.

```text
Pdynamic ∝ α C V² f
```

- `α`: switching activity
- `C`: 충·방전되는 capacitance
- `V`: supply voltage
- `f`: switching frequency

Clock은 매 cycle 전환되고 많은 sequential cell과 clock buffer를 구동한다. 따라서 clock tree와 flip-flop의 clock pin은 대표적인 high-activity load다. Data가 바뀌지 않는 cycle에도 clock pin과 clock distribution network는 계속 움직인다. Clock gating은 이 활동을 멈춰 다음 항목의 power를 줄일 수 있다.

- gated branch의 clock buffer와 wire
- flip-flop clock pin 내부 switching
- state update가 멈춤으로써 감소하는 downstream data switching

하지만 gating cell, enable generation logic, test bypass, extra routing도 capacitance와 leakage를 추가한다. 작은 register 한두 개를 위해 복잡한 enable을 만들면 절감보다 overhead가 클 수 있다. 따라서 “gating 가능”과 “PPA상 유리”는 별개의 판단이다.

## 2. Clock Is Not Ordinary Data

일반 data path에서 짧은 glitch가 발생하더라도 capture edge 전에 값이 안정되면 기능적으로 문제가 없을 수 있다. 반면 clock waveform의 edge 자체가 state transition을 일으킨다. Clock에 의도하지 않은 edge가 하나 추가되면 그 순간 state가 실제로 한 번 더 업데이트될 수 있다.

다음과 같은 raw combinational clock gating은 synthesizable하게 보이더라도 일반적인 clock 생성 방법으로 사용하지 않는다.

```systemverilog
// Bad: raw combinational clock gating
assign gclk = clk & en;

always_ff @(posedge gclk) begin
    q <= d;
end
```

`clk`가 high인 동안 `en`이 바뀌면 다음 문제가 생길 수 있다.

- **Glitch**: enable 경로의 조합 지연 때문에 짧은 pulse가 발생할 수 있다.
- **Runt pulse**: 정상 clock high/low width보다 훨씬 짧은 pulse가 만들어질 수 있다.
- **Extra edge**: `clk`가 이미 high인 상태에서 `en`이 0→1로 바뀌면 `gclk`에 새로운 rising edge처럼 보이는 전환이 생길 수 있다.
- **Minimum pulse-width violation**: sequential cell이 요구하는 최소 high/low time을 만족하지 못할 수 있다.
- **Uncontrolled skew**: 일반 data logic과 routing을 거친 clock은 clock tree가 전제로 하는 품질과 균형을 잃을 수 있다.

RTL simulation에서 문제가 보이지 않는다고 안전한 것은 아니다. Zero-delay simulation은 analog pulse shape, minimum pulse width, clock-tree skew를 충실히 나타내지 않는다.

## 3. Integrated Clock-Gating Cell

일반적인 integrated clock-gating cell(ICG)의 개념은 다음과 같다.

```text
                    enable held stable
EN ──> [safe-phase storage] ──┐
                              AND ──> GCLK
CLK ──────────────────────────┘
```

Positive-edge clock을 gate한다고 가정하면, enable은 보통 clock의 inactive phase, 즉 low phase에서 받아들이고 active high phase 동안 고정한다. 개념적으로는 low-level-sensitive latch와 AND gate의 조합으로 생각할 수 있다.

```text
CLK low  : enable may update
CLK high : stored enable must not change
```

이렇게 하면 `clk`가 high인 도중 enable이 바뀌어 새로운 edge나 잘린 pulse를 만드는 것을 막을 수 있다. 실제 standard-cell ICG는 다음과 같은 구현 및 sign-off 요구를 지원하도록 characterization된 전용 cell인 경우가 많다.

- clock-gating setup/hold check
- minimum pulse-width check
- test/scan enable 경로
- clock-tree synthesis와 timing 분석에서의 clock-cell 인식

ICG가 glitch risk를 줄여 주더라도 enable이 아무 때나 바뀌어도 된다는 뜻은 아니다. Enable은 여전히 ICG의 clock-gating timing check를 만족해야 하며, enable 생성 logic 자체도 분석 대상이다.

## 4. Inferred Clock Gating

RTL designer가 가장 먼저 표현해야 하는 것은 “clock을 어떻게 만들 것인가”보다 “register가 언제 update되는가”다.

```systemverilog
always_ff @(posedge clk) begin
    if (en) begin
        q <= d;
    end
end
```

이 RTL은 기능적으로 `en == 0`일 때 `q`를 유지한다. 합성 결과는 flow와 target에 따라 다음 중 하나가 될 수 있다.

```text
Implementation A: feedback MUX / clock-enable-capable register

                ┌───────────┐
       d ──────>│           │
       q ──────>│  2:1 MUX  ├──> D of FF
       en ─────>│           │
                └───────────┘
                     FF receives every clock edge
```

```text
Implementation B: inferred ICG shared by a register group

       en ──> ICG enable
       clk ─> ICG ──> gated clock ──> FF group
```

Clock-gating inference가 실제로 일어나는지는 다음 조건에 영향을 받을 수 있다.

- synthesis setting과 library에 적합한 ICG가 있는가
- 같은 enable을 공유하는 register가 충분한가
- enable의 polarity와 priority가 인식 가능한가
- reset, scan, test requirement와 양립하는가
- gating overhead보다 예상 power 절감이 큰가
- hierarchy와 optimization boundary가 inference를 방해하지 않는가

따라서 `if (en)`을 썼다는 이유만으로 ICG가 생겼다고 가정하지 않는다. Synthesis log, clock-gating report, netlist와 power estimate로 확인한다.

### Enable condition은 공짜가 아니다

```systemverilog
logic update_en;
assign update_en = mode_active && input_valid && !stall && !flush;

always_ff @(posedge clk) begin
    if (update_en) begin
        q <= d;
    end
end
```

`update_en`은 명확한 기능 조건일 수 있지만, 조건이 깊고 늦게 도착하면 다음 cost가 생긴다.

- ICG enable pin까지의 timing pressure
- enable logic의 area와 switching
- high-fanout enable routing
- 여러 조건이 공유될 때의 congestion

기존 state나 protocol signal로 충분하다면 그것을 재사용할 수 있는지 먼저 본다. 단, 의미가 비슷해 보인다는 이유로 다른 functional condition을 억지로 합치면 안 된다.

## 5. Explicit Clock Gating and Manual ICG Insertion

Function-level power architecture처럼 clock boundary가 microarchitecture의 일부인 경우에는 explicit clock gating 또는 manual ICG insertion을 검토할 수 있다. Public/generic RTL에서는 technology-specific cell을 여러 곳에서 직접 부르기보다, project가 관리하는 clock-gate wrapper나 정해진 clocking abstraction을 사용하는 편이 유지보수에 유리하다.

다음은 **interface를 설명하기 위한 개념적 예시**다. `clock_gate`의 구현은 target flow가 제공하는 안전한 ICG mapping으로 대체되어야 하며, raw `clk & en`으로 구현해서는 안 된다.

```systemverilog
module function_block (
    input  logic clk,
    input  logic rst_n,
    input  logic function_en,
    input  logic test_en,
    input  logic d,
    output logic q
);
    logic function_clk;

    // Generic abstraction. Implementation must map to a characterized
    // clock-gating resource supported by the implementation flow.
    clock_gate u_function_clock_gate (
        .clk_in  (clk),
        .enable  (function_en),
        .test_en (test_en),
        .clk_out (function_clk)
    );

    always_ff @(posedge function_clk or negedge rst_n) begin
        if (!rst_n)
            q <= 1'b0;
        else
            q <= d;
    end
endmodule
```

이 wrapper는 안전성을 자동으로 만들어 주는 black box가 아니다. `function_en`과 `test_en`은 선택한 ICG의 clock-gating timing/CDC contract를 만족해야 하며, asynchronous wake-up request라면 always-on domain에서 필요한 synchronization과 state holding을 먼저 구현해야 한다. ICG는 asynchronous request를 자동으로 동기화하지 않는다.

Explicit insertion은 boundary를 명확하게 만들 수 있지만 다음 책임도 함께 만든다.

- enable의 functional correctness와 wake-up sequence
- clock-gating timing check
- DFT/scan controllability
- reset과 initialization
- generated/gated clock의 STA modeling
- CDC/RDC analysis에서의 clock relationship
- CTS, placement와 power sign-off

“ICG를 직접 넣으면 tool이 알아서 해결한다”는 접근은 충분하지 않다.

## 6. Fine-Grain vs Coarse-Grain Gating

### Fine-grain clock gating

작은 register group마다 local enable을 적용하는 방식이다.

```text
ROOT CLK
   ├── ICG(en_a) ──> FF group A
   ├── ICG(en_b) ──> FF group B
   └── ICG(en_c) ──> FF group C
```

장점:

- activity 특성에 맞춰 정밀하게 clock을 멈출 수 있다.
- 서로 다른 update condition을 독립적으로 활용할 수 있다.

비용과 위험:

- ICG 수, enable network와 clock-tree branch가 늘어난다.
- 작은 group은 gating overhead를 상쇄할 만큼 절감하지 못할 수 있다.
- clock-gating timing path와 physical constraint가 많아진다.

### Coarse-grain or function-level clock gating

하나의 function block이나 큰 sequential island를 함께 멈추는 방식이다.

```text
ROOT CLK
    │
  ICG(function_en)
    │
FUNCTION CLK
    ├── FSM
    ├── Counter
    └── Datapath registers
```

장점:

- 한 ICG로 큰 clock load를 차단할 수 있어 break-even이 유리할 수 있다.
- power state와 architecture boundary가 명확해질 수 있다.

비용과 위험:

- block 전체가 같은 시간에 안전하게 멈출 수 있어야 한다.
- wake-up latency와 state retention requirement가 생긴다.
- 일부 always-on control까지 같이 멈추면 restart가 불가능할 수 있다.

Fine과 coarse 중 하나가 항상 우수한 것은 아니다. Activity profile, enable correlation, group size, clock-tree capacitance, timing과 placement를 함께 보고 결정한다.

## 7. Root Clock, Function Clock, and Always-On Logic

Function이 idle일 때 register가 정말 살아 있어야 하는지 분류한다.

```text
ROOT CLOCK DOMAIN

  Always-on island
  ├── wake-up detector
  ├── clock-enable state
  └── interface state needed while function is off
             │ function_en
             v
           [ICG]
             │
  Gated function island
  ├── datapath
  ├── local counters
  └── state unnecessary while stopped
```

다음 항목은 root clock 또는 별도의 always-on clock 아래에 남아야 할 가능성이 높다.

- function clock을 다시 켜는 조건을 관찰하는 logic
- clock enable을 저장하거나 해제하는 state
- clock이 꺼진 동안에도 응답해야 하는 interface control
- wake-up request synchronizer
- test/debug 또는 safety requirement상 항상 동작해야 하는 state

### Self-deadlock

Function clock을 enable하는 state를 그 same function clock 아래에 넣으면 다음 순환 의존성이 생길 수 있다.

```text
function clock is off
        ↓
enable state cannot update
        ↓
function clock cannot turn on
```

```systemverilog
// Conceptually unsafe architecture:
// wakeup_pending is updated only by function_clk,
// but wakeup_pending is also needed to turn function_clk on.
```

해결은 단순히 signal 하나를 OR하는 것이 아니라 clock ownership을 다시 나누는 것이다. Wake-up path가 어느 clock에서 관찰되고, ICG enable이 어느 state로 유지되며, function block이 몇 cycle 뒤부터 유효한지를 protocol로 정의한다.

## 8. Register Enable Is Not Raw Clock Gating

다음 두 RTL은 목적과 위험이 다르다.

### Data enable

```systemverilog
always_ff @(posedge clk) begin
    if (count_active && event_c)
        count <= count + 1'b1;
end
```

- 모든 register는 원래의 `clk`를 받는다.
- `count_active && event_c`는 D input update condition이다.
- Feedback MUX나 clock-enable register로 구현되면 enable/data는 FF의 D-path setup/hold 분석 대상이다.
- ICG로 inference되면 enable은 ICG의 clock-gating setup/hold check를 만족해야 하며, gated clock waveform과 downstream clock path도 분석해야 한다.
- 합성 flow가 적절하다고 판단하면 feedback MUX 또는 inferred clock gating으로 구현할 수 있다.

### Raw combinational gated clock

```systemverilog
assign count_clk = clk & count_active & event_c; // Avoid

always_ff @(posedge count_clk)
    count <= count + 1'b1;
```

- Boolean logic의 전환이 직접 clock edge가 된다.
- `count_active`나 `event_c`의 glitch, skew와 timing이 clock waveform 품질에 영향을 준다.
- 일반 data path timing만으로 안전성을 보장할 수 없다.

동일 clock domain의 synchronous 조건들을 data enable로 결합하는 것은 흔한 설계 방식이다. 그것을 clock net에 직접 AND하는 것과 혼동하지 않는다.

## 9. Functional Semantics Before PPA

Clock gating을 적용하기 전에 gated register의 hold 동작이 specification과 일치하는지 확인한다.

```systemverilog
always_ff @(posedge clk) begin
    if (clear)
        q <= '0;
    else if (update_en)
        q <= d;
end
```

이 코드에서 `clear`와 `update_en`의 priority는 hardware다. `clear`가 asserted된 동안 clock을 완전히 막아 버리면 `q`가 clear되지 않을 수 있다. 다음 질문이 먼저 정의되어야 한다.

- idle 중 state는 보존해야 하는가, discard해도 되는가?
- clear/reset request는 clock이 꺼져 있을 때도 효력이 있어야 하는가?
- enable과 clear가 동시에 발생하면 무엇이 우선인가?
- clock을 끄기 전에 outstanding transaction이 모두 종료되었는가?
- clock을 다시 켠 뒤 output은 즉시 유효한가, warm-up cycle이 필요한가?

Power optimization은 functional state machine과 protocol을 변경할 수 있다. “값이 바뀌지 않으니 안전하다”는 가정은 downstream observer와 mode transition까지 확인한 뒤에만 성립한다.

## 10. Reset Considerations

Gated clock과 reset을 함께 설계할 때는 reset style에 따라 문제가 달라진다.

### Synchronous reset

Synchronous reset은 active clock edge가 있어야 register에 반영된다. Function clock이 멈춘 상태에서 synchronous reset만 assertion하면 gated register는 reset되지 않는다.

가능한 architecture는 requirement에 따라 달라진다.

- reset 동안 flow가 지원하는 characterized ICG override/test-enable 경로나 검증된 safe sequence로 clock gate를 연다. Raw OR/AND로 clock을 우회하지 않는다.
- function island는 reset할 필요가 없도록 valid protocol을 사용한다.
- reset이 필요한 control만 always-on island로 옮긴다.
- 지원되는 reset strategy를 별도로 정의한다.

### Asynchronous reset

Asynchronous assertion은 clock이 멈춰 있어도 cell state를 reset할 수 있지만, deassertion은 recovery/removal와 reset-domain-crossing 문제를 만든다. 일반적으로 deassertion은 해당 destination clock에 대해 안전하게 동기화되어야 한다. Clock이 멈춰 있으면 deassertion을 소비할 edge가 없으므로, clock-start sequence와 reset-release sequence를 함께 정의해야 한다.

Reset solution을 고를 때는 library support, DFT, RDC analysis와 physical reset network까지 함께 검토한다.

Reset source, per-domain deassertion과 `reset_done`은 [Reset Architecture Overview](../07_reset/overview.md), clock force-on부터 regating까지의 sequence는 [Reset with Clock Gating](../07_reset/reset_with_clock_gating.md)을 따른다.

## 11. DFT and Test Considerations

Functional mode에서 clock을 잘 멈추는 설계도 scan shift, ATPG, memory test 또는 debug mode에서는 clock controllability를 방해할 수 있다. 일반적인 ICG interface가 test enable 또는 scan enable을 제공하는 이유다.

검토 항목:

- test mode에서 필요한 모든 clock branch를 제어할 수 있는가?
- test bypass가 ICG의 안전한 경로를 사용하며 raw combinational bypass가 아닌가?
- scan enable과 functional enable의 priority가 명확한가?
- at-speed test가 functional clock relationship을 보존하는가?
- test signal이 functional mode에서 불필요하게 toggle하거나 timing을 악화하지 않는가?

DFT requirement는 RTL 완료 후 덧붙이는 옵션이 아니라 clock architecture의 입력 조건이다.

## 12. STA and CDC Considerations

### Static Timing Analysis

Clock gating은 data path 외에 clock-specific timing check를 추가한다.

- functional enable에서 ICG enable pin까지의 clock-gating setup/hold
- ICG output의 waveform와 minimum pulse width
- root clock과 gated/generated clock의 relationship
- insertion delay, skew, uncertainty
- clock gate를 통과하는 reset/test mode의 timing

Gated clock을 false path로 광범위하게 제외해서 문제를 숨기면 안 된다. Implementation flow가 ICG를 clock element로 인식하도록 하고, clock relationship과 operating modes를 정확히 모델링한다.

### CDC implications

ICG output은 root clock에서 파생되었다고 해서 언제나 별도 asynchronous clock domain인 것은 아니다. 그러나 clock이 멈추거나 다시 시작하고, divider/mux를 통과하거나 mode별 relationship이 달라지면 crossing protocol과 analysis model이 복잡해진다.

다음을 명시한다.

- 두 clock이 synchronous/related인지, asynchronous인지
- gated domain이 멈춘 동안 source data가 어떻게 유지되는지
- wake-up request가 어떤 clock에서 안전하게 전달되는지
- domain이 멈췄을 때 handshake가 deadlock되지 않는지
- CDC tool이 gated/generated clock relationship을 올바르게 인식하는지

CDC의 기본 분류와 구조는 [CDC Overview](../08_cdc/overview.md)를 참고한다.

## 13. Physical Design Considerations

RTL에서 ICG 하나를 표현했다고 해서 physical implementation이 자동으로 최적이라는 뜻은 아니다.

- **Placement**: ICG와 sink cluster가 너무 멀면 clock route와 enable route cost가 커질 수 있다.
- **Fanout**: 하나의 coarse gate가 지나치게 많은 sink를 구동하면 buffering과 skew 관리가 필요하다.
- **Clustering**: 같은 enable을 공유해도 sink가 물리적으로 멀리 흩어져 있으면 하나의 gate 공유가 불리할 수 있다.
- **Congestion**: enable, test, clock routing이 특정 영역에 집중될 수 있다.
- **CTS interaction**: ICG 위치는 clock-tree topology, latency와 skew에 영향을 준다.
- **Activity locality**: 함께 켜지고 꺼지는 register가 논리적·물리적으로 얼마나 가까운지가 break-even에 영향을 준다.

따라서 post-synthesis뿐 아니라 post-placement/CTS power와 timing feedback을 RTL·architecture로 되돌려야 한다.

```text
Activity intent
      ↓
RTL enable / clock architecture
      ↓
Clock-gating synthesis
      ↓
STA + power estimate
      ↓
Placement / CTS feedback
      ↓
Regroup, simplify, or remove gating
```

## 14. PPA Trade-offs

| 관점 | 기대 효과 | 가능한 비용 |
|---|---|---|
| Power | clock-tree 및 FF clock-pin activity 감소, downstream switching 감소 | ICG·enable logic·test routing의 dynamic/leakage 증가 |
| Area | large group에서 별도 data feedback MUX가 줄 수 있음 | ICG cell, enable logic, buffering, test logic 증가 |
| Timing | 일부 D-path feedback MUX가 사라질 가능성 | gating enable timing, clock latency/skew, high-fanout enable 부담 |
| Physical | idle branch activity 감소 | placement 제약, clock/enable routing과 congestion 증가 |
| Verification | explicit power state를 검증 가능 | off/on transition, reset, DFT, CDC mode 검증 공간 증가 |

Break-even은 register 개수만으로 결정되지 않는다. Clock pin capacitance, activity duty cycle, enable toggle rate, enable logic cost, physical grouping과 library cell 특성을 함께 사용해 측정한다.

## 15. Common Mistakes

### 15.1 Raw AND/OR clock generation

```systemverilog
assign gclk = clk & en; // Bad for synthesizable clock architecture
```

**Better:** clock enable을 RTL state-update condition으로 표현해 inference를 검토하거나, implementation flow가 지원하는 ICG abstraction을 사용한다.

### 15.2 Enable added everywhere

모든 register에 서로 다른 enable을 넣으면 gating opportunity가 많아 보이지만 enable logic, MUX, ICG와 verification cost가 더 커질 수 있다.

**Better:** activity report에서 hotspot을 찾고, 같은 functional lifetime을 가진 state를 group으로 묶는다.

### 15.3 Wake-up controller under its own gated clock

Clock을 켜야 하는 state가 clock과 함께 멈춰 self-deadlock이 생긴다.

**Better:** minimal wake-up path를 root/always-on clock 아래에 둔다.

### 15.4 Ignoring reset while clock is off

특히 synchronous reset은 edge 없이 적용되지 않는다.

**Better:** clock-open/reset-release sequence와 state validity를 specification으로 만든다.

### 15.5 Assuming inference happened

`if (en)`만 보고 clock power가 줄었다고 판단한다.

**Better:** netlist, gating report와 power result에서 실제 mapping과 절감을 확인한다.

### 15.6 Treating a gated clock as “just another domain”

무조건 async로 처리하거나, 반대로 root와 related하다는 이유로 crossing 문제를 전부 무시한다.

**Better:** 각 operating mode에서 clock relationship, stop/resume behavior와 data stability protocol을 정의한다.

## 16. Recommended Decision Flow

```text
Power hotspot identified
        ↓
Is the logic itself unnecessary?
   YES ──> Remove it
   NO
        ↓
Can state/data updates simply be disabled?
   YES ──> Express a clear register enable
   NO / large idle function
        ↓
Can the whole function safely stop together?
        ↓
Define always-on state and wake-up protocol
        ↓
Choose inferred or explicit ICG strategy
        ↓
Verify function + reset + DFT + STA + CDC
        ↓
Measure post-synthesis and physical PPA
```

`Remove → Disable → Gate`의 순서가 유용하다. Logic을 제거할 수 있다면 가장 큰 절감이고, 단순 register enable만으로 충분하다면 clock architecture의 복잡성을 늘리지 않을 수 있다.

## 17. Design Review Checklist

### Functional intent

- [ ] Gated state는 idle 동안 hold해야 하는가, discard해도 되는가?
- [ ] Clock을 끄기 전에 outstanding transaction이 종료되는가?
- [ ] Clock off/on 전환의 latency와 output-valid 시점이 정의되어 있는가?
- [ ] Enable, clear, load, reset이 동시에 발생할 때 priority가 정의되어 있는가?

### Clock architecture

- [ ] Raw combinational gated clock이 없는가?
- [ ] 지원되는 ICG 또는 clocking abstraction을 사용하는가?
- [ ] Fine-grain과 coarse-grain 선택에 activity와 physical 근거가 있는가?
- [ ] Root clock logic과 function clock logic의 경계가 명확한가?
- [ ] Wake-up과 enable state가 always-on인가?
- [ ] Self-deadlock 가능성이 없는가?

### PPA

- [ ] Gating 대상의 clock load와 idle duty cycle이 충분한가?
- [ ] Enable generation logic의 area/timing/power cost를 포함했는가?
- [ ] 합성 후 실제 ICG mapping과 group size를 확인했는가?
- [ ] Placement/CTS 이후 power, skew, congestion을 다시 확인했는가?

### Reset and test

- [ ] Clock이 꺼진 동안 reset assertion과 deassertion 동작이 정의되어 있는가?
- [ ] Synchronous reset을 적용할 active edge가 보장되는가?
- [ ] Test/scan mode에서 gated branch를 제어할 수 있는가?
- [ ] Functional enable과 test enable의 priority가 검증되었는가?

### Timing and CDC

- [ ] ICG enable의 clock-gating setup/hold가 분석되는가?
- [ ] Root/gated/generated clock relationship이 mode별로 정의되어 있는가?
- [ ] Gated domain이 멈췄을 때 crossing data와 handshake가 안전한가?
- [ ] Wake-up request와 reset crossing 구조를 CDC/RDC tool이 인식하는가?

### Verification

- [ ] Enable이 active clock phase 근처에서 바뀌는 case를 clock-gating check가 다루는가?
- [ ] Clock off 중 input 변화, reset, interrupt를 검증했는가?
- [ ] Back-to-back sleep/wake request를 검증했는가?
- [ ] RTL simulation뿐 아니라 synthesis, STA, CDC, power report로 확인했는가?

## 18. Key Takeaways

1. Clock edge는 state transition을 일으키므로 clock을 일반 data처럼 조합 논리로 만들지 않는다.
2. 먼저 logic 제거와 register enable을 검토하고, 큰 clock load가 실제로 오래 idle일 때 gating을 평가한다.
3. Inferred gating은 `if (en)`의 기능적 의도를 합성 flow가 ICG로 mapping하는 방식이며, 실제 inference 여부를 report로 확인해야 한다.
4. Explicit gating은 architecture boundary를 선명하게 하지만 always-on, reset, DFT, STA, CDC와 physical 책임을 함께 만든다.
5. 가장 위험한 구조 중 하나는 function clock을 켜는 logic을 같은 gated clock 아래에 넣는 self-deadlock이다.
6. Clock gating의 가치는 RTL의 모양이 아니라 최종 functional correctness와 measured PPA로 판단한다.

## 관련 문서

- [Clock Design Overview](overview.md): clock architecture의 전체 decision flow
- [Inferred vs Explicit Clock Gating](inferred_vs_explicit.md): insertion 책임과 fine/coarse-grain 선택
- [Root Clock vs Function Clock](root_vs_function_clock.md): always-on partition과 sleep/wake protocol
- [Register Enable](../04_low_power/register_enable.md): data update condition과 feedback MUX
- [Reset with Clock Gating](../07_reset/reset_with_clock_gating.md): clock force-on, local release와 reset-done protocol
