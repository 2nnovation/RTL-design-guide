# Canonical RTL Design Terminology

이 문서는 여러 Chapter에서 반복해서 사용하는 용어의 **canonical definition**을 관리한다. 각 주제 문서는 이 정의를 다시 길게 복사하지 않고, 해당 주제에서 필요한 해석과 예외를 설명한 뒤 이 문서로 연결한다.

> 용어를 통일하는 목적은 표현을 예쁘게 만드는 것이 아니라, requirement·RTL·constraint·report가 같은 hardware behavior를 가리키게 만드는 것이다.

## 1. RTL과 Hardware

| 용어 | 이 가이드에서의 의미 | 혼동하지 말아야 할 것 |
|---|---|---|
| RTL | clock edge 사이의 조합 동작과 edge에서의 state update를 기술하는 설계 표현 | 순차적으로 실행되는 software procedure |
| Combinational logic | 현재 입력의 함수로 출력이 결정되는 logic | clock cycle을 스스로 세는 계산 장치 |
| Sequential logic | clock/event에 의해 state를 저장하는 FF, latch 또는 memory 구조 | 단순히 코드가 여러 줄인 logic |
| Register / FF | clock edge에서 값을 capture해 state를 유지하는 hardware | SystemVerilog 변수 이름 자체 |
| State | 이후 동작에 영향을 주기 위해 hardware가 보존하는 정보 | simulation에서 잠시 계산한 intermediate variable |
| Datapath | arithmetic, compare, shift, select 등 data transformation을 담당하는 구조 | control과 완전히 독립된 블록이라는 뜻 |
| Control logic | state, enable, valid, select와 protocol sequencing을 결정하는 구조 | 작거나 timing에 중요하지 않은 logic이라는 뜻 |

`if`, `case`, loop와 function은 문법 이름이다. 합성 후 hardware는 MUX, decoder, comparator, arithmetic logic, FF와 wiring의 조합으로 구현될 수 있다. 문법만 보고 구조를 단정하지 말고 synthesis result를 확인한다.

문법을 실제 구조와 cycle behavior로 번역하는 방법은 [Think Hardware, Not Code](think_hardware_not_code.md)를 참고한다. State와 combinational cone의 구분은 [Combinational vs Sequential Logic](combinational_vs_sequential.md), simultaneous selection은 [Priority and MUX](priority_and_mux.md), numeric range와 conversion은 [Width and Signedness](width_and_signedness.md)에서 canonical하게 다룬다.

## 2. Clock와 Cycle

### Clock edge

Clock edge는 sequential element가 state를 capture할 수 있는 사건이다. Clock은 단순한 Boolean data가 아니므로 combinational logic으로 임의 생성하거나 glitch가 전달되게 해서는 안 된다.

### Clock cycle

같은 종류의 연속된 active edge 사이의 간격을 말한다. “3 cycle latency”라는 표현은 다음을 함께 명시해야 의미가 분명하다.

- 어느 interface의 accept edge에서 시작하는가?
- 어느 interface의 valid/capture edge에서 끝나는가?
- clock이 멈추거나 frequency가 변할 수 있는가?
- reset, stall과 backpressure가 cycle count에 포함되는가?

### Clock domain

동일하거나 STA가 정의된 edge relationship을 분석할 수 있는 clock 체계에서 동작하는 sequential logic의 집합이다. Frequency가 같다는 사실만으로 synchronous domain은 아니다. 반대로 root clock에서 안전하게 파생된 gated clock이라고 해서 항상 asynchronous domain인 것도 아니다.

Clock domain 판단에는 waveform, phase, divider/mux/gating 구조, mode별 관계와 STA/CDC modeling이 필요하다.

### Root clock과 function clock

- **Root clock:** gating 또는 function-level 분기 이전의 기준 clock을 가리키는 architecture 용어다.
- **Function clock:** 특정 기능 block을 켜고 끄기 위해 ICG 등을 통과한 clock branch를 가리키는 이 가이드의 용어다.

이는 특정 tool의 고유 clock object 분류가 아니다. 자세한 구조는 [Root Clock vs Function Clock](../06_clock/root_vs_function_clock.md)을 참고한다.

## 3. Latency, Throughput, Initiation Interval

| 용어 | 정의 | Review 질문 |
|---|---|---|
| Latency | input transaction을 accept한 시점부터 대응하는 output이 유효해지는 시점까지의 지연 | fixed인가, variable인가? |
| Throughput | 단위 시간 또는 cycle당 완료할 수 있는 transaction 수 | steady state에서 매 cycle 결과가 가능한가? |
| Initiation interval, II | 연속된 두 input transaction을 accept할 수 있는 최소 cycle 간격 | latency와 독립적으로 정의됐는가? |

Latency가 4 cycle인 pipeline도 II가 1이면 매 cycle 새 input을 받을 수 있다. 반대로 latency가 2 cycle인 공유 연산기가 완료될 때까지 busy라면 II도 2 이상일 수 있다.

```text
Four-stage pipeline

cycle        0    1    2    3    4    5
input A      A
input B           B
output A                         A
output B                              B

Latency = 4 cycles, initiation interval = 1 cycle
```

“빠르다”는 표현 대신 latency, throughput, clock frequency와 response deadline 중 무엇을 뜻하는지 명시한다.

## 4. Launch, Capture, Timing Path

### Launch

Source sequential element가 active edge에서 새 data를 Q 쪽으로 내보내기 시작하는 사건이다. Register-to-register path에서는 source FF가 일반적인 launch point다.

### Capture

Destination sequential element가 active edge에서 D 값을 state로 받아들이는 사건이다.

### Timing path

STA가 delay requirement를 분석하는 startpoint에서 endpoint까지의 경로다. Register-to-register setup path의 단순 model은 다음과 같다.

```text
launch edge
    ↓
[Source FF] -- clock-to-Q --> [Combinational logic + routing] --> [Capture FF]
                                                                       ↑
                                                                  capture edge
```

실제 required/arrival time에는 clock waveform, latency, skew, uncertainty, derating, library setup/hold 값과 analysis mode가 반영될 수 있다.

### Critical path

주어진 analysis scenario에서 slack이 가장 나쁜 path다. RTL에 영구히 고정된 한 줄이 아니며 corner, mode, constraint, placement와 routing이 바뀌면 달라질 수 있다. 자세한 내용은 [Critical Path](../03_timing/critical_path.md)를 참고한다.

## 5. Setup, Hold, Slack

### Setup requirement

Capture edge 전에 data가 충분히 일찍 도착해 안정되어야 한다는 max-delay requirement다.

개념적으로:

```text
data arrival time <= data required time
setup slack = required time - arrival time
```

Setup slack이 음수면 분석 조건에서 data가 늦게 도착한 것이다.

### Hold requirement

Capture edge 뒤 일정 시간 동안 이전 data가 너무 빨리 바뀌지 않아야 한다는 min-delay requirement다.

Hold는 clock frequency를 낮춘다고 일반적으로 해결되는 문제가 아니다. Data path minimum delay, clock skew, library hold requirement와 variation을 함께 본다.

### Slack

Requirement와 실제 분석 결과 사이의 margin이다. Slack 값만 보지 말고 다음을 함께 기록한다.

- analysis corner와 mode
- startpoint와 endpoint
- launch/capture edge
- path group과 exception
- cell delay와 net delay 비중
- pre-layout인지 post-route인지

## 6. Pipeline과 Multi-Cycle Path

| 항목 | Pipeline | Multi-Cycle Path |
|---|---|---|
| 본질 | combinational path를 register stage로 분할하는 hardware architecture | 이미 여러 edge 뒤 capture하는 functional contract를 STA에 표현하는 constraint |
| Hardware 변경 | 있음 | constraint 자체로는 없음 |
| Throughput | II=1로 유지·개선할 수 있음 | 단순 source-hold 구조에서는 낮아질 수 있음 |
| 주요 비용 | FF, clock power, latency, control alignment | constraint scope, hold 관계, assumption 유지보수 |

Pipeline과 MCP는 negative slack을 없애기 위한 동등한 명령이 아니다. 먼저 latency/throughput requirement와 실제 capture schedule을 결정한 뒤 선택한다.

- [Pipeline Design](../03_timing/pipeline.md)
- [Multi-Cycle Path](../03_timing/multi_cycle_path.md)

## 7. Enable과 Clock Gating

### Register enable

Register가 특정 edge에서 새 data를 capture할지 기존 값을 유지할지 결정하는 **data update condition**이다.

```systemverilog
always_ff @(posedge clk) begin
    if (en)
        q <= d;
end
```

합성 결과는 feedback MUX, enable-capable cell 또는 clock-gating flow의 입력이 될 수 있다. RTL enable만 보고 실제 clock activity가 줄었다고 단정하지 않는다.

### Clock gating

검증된 clock-gating structure를 사용해 clock edge가 sequential load에 도달하지 않도록 하는 방법이다. 일반 data enable과 raw combinational gated clock을 구분한다.

```systemverilog
// Data enable: synchronous functional condition
if (count_active && event_c)
    count <= count + 1'b1;

// Raw clock generation: 일반적인 RTL에서 피해야 하는 구조
assign gclk = clk & en;
```

자세한 내용:

- [Register Enable](../04_low_power/register_enable.md)
- [Clock Gating](../06_clock/clock_gating.md)

## 8. CDC 용어

### Asynchronous crossing

Source transition과 destination sampling edge 사이에 STA가 보장할 수 있는 고정된 관계가 없는 crossing이다.

### Metastability

Sequential element가 setup/hold aperture 근처의 transition을 sampling할 때 output이 일정 시간 유효한 0/1로 해석되기 어려운 analog 상태에 머물 수 있는 현상이다. RTL simulation은 이 analog behavior를 직접 증명하지 못한다.

### Synchronizer

Metastability-related failure가 functional logic으로 전파될 확률을 낮추기 위한 destination-domain structure다. 2FF synchronizer는 persistent single-bit level에 적합하지만 pulse 보존, multi-bit coherency와 transaction delivery를 자동 보장하지 않는다.

### Coherency

여러 bit 또는 관련 signal이 하나의 의도된 transaction/state에 해당하는 조합으로 관찰되는 성질이다. 각 bit에 independent 2FF를 두는 것만으로 word coherency를 보장할 수 없다.

### Bundled data

Payload data는 충분히 안정적으로 유지하고, 별도로 안전하게 전달한 control event가 destination capture를 지시하는 protocol 계열이다. Data와 control 사이의 stability/order assumption이 명시되어야 한다.

자세한 내용은 [CDC Overview](../08_cdc/overview.md)를 참고한다.

## 9. Constraint와 Exception

### Constraint

Clock, I/O delay, operating relationship와 timing requirement를 분석 tool에 제공하는 설계 계약이다. Constraint는 hardware를 만들지 않지만 sign-off 결과의 의미를 결정한다.

### Timing exception

Default timing relationship이 functional architecture와 다를 때 분석 범위를 조정하는 constraint다. 대표적으로 MCP와 false path가 있다.

Exception은 “timing을 통과시키기 위한 예외”가 아니라 default analysis가 실제 기능 계약과 다른 이유를 증명하는 문서화된 설계 요소여야 한다.

## 10. PPA와 Robustness

### Power

RTL 수준에서는 주로 switching activity, clock activity와 driven capacitance에 영향을 준다. 실제 power는 workload, vector quality, voltage, frequency, library와 physical implementation에 의존한다.

### Performance

이 가이드에서 performance는 문맥에 따라 frequency, latency, throughput 또는 response deadline을 뜻할 수 있다. 가능한 한 구체적인 metric으로 바꿔 쓴다.

### Area

Cell count나 physical footprint만이 아니라 buffering, routing, congestion과 clock/reset distribution overhead까지 포함해 판단한다.

### Robustness

Nominal simulation뿐 아니라 reset, boundary, simultaneous event, CDC/RDC, PVT, protocol violation과 implementation variation에서 요구 기능을 유지하는 성질이다.

## 11. 용어 사용 Checklist

- [ ] “cycle”의 시작과 끝 edge가 명확한가?
- [ ] “빠르다”를 latency, throughput 또는 frequency로 구체화했는가?
- [ ] Register enable과 clock gating을 구분했는가?
- [ ] MCP를 hardware 구조처럼 설명하지 않았는가?
- [ ] Critical path의 mode/corner/implementation 조건을 명시했는가?
- [ ] 2FF를 pulse 또는 multi-bit coherency 해법으로 일반화하지 않았는가?
- [ ] Tool-dependent constraint나 attribute를 generic rule로 단정하지 않았는가?
- [ ] PPA 효과를 measurement 없이 절대적인 수치로 표현하지 않았는가?
