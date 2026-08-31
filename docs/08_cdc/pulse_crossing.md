# Pulse Crossing

Pulse crossing은 source domain의 event를 limited-width pulse로 표현해 다른 clock domain으로 전달하는 문제다. Plain 2FF synchronizer는 metastability containment에는 도움이 되지만, destination edge가 pulse를 한 번도 sampling하지 않으면 event 자체를 잃는다.

> Pulse CDC의 핵심 질문은 “동기화했는가?”뿐 아니라 “모든 event를 정확히 한 번 전달해야 하는가?”다.

## 1. Why a Pulse Can Be Missed

```text
src_pulse   ____/‾‾\________________

dst_clk     ______/‾\____/‾\____/‾\__
                   no edge inside pulse
```

Source pulse width가 destination sampling interval보다 짧고 phase가 불리하면 FF1이 한 번도 `1`을 capture하지 못한다. 이는 metastability가 resolve되는 문제와 별개다.

## 2. Requirements to Define First

- 모든 event를 보존해야 하는가?
- 여러 event가 합쳐져도 되는가?
- 최대 event rate와 최소 event 간격은 얼마인가?
- Destination clock이 멈출 수 있는가?
- Backpressure/acknowledge를 허용할 수 있는가?
- Latency bound가 필요한가?
- Source와 destination reset이 독립적인가?

이 답에 따라 pulse stretch, toggle, handshake, counter 또는 FIFO를 선택한다.

## 3. Pulse Stretch

Source pulse를 destination이 sampling할 수 있을 만큼 level로 늘린다.

```text
short event ──> source-side stretcher ──> 2FF level sync ──> edge detect
```

적합한 조건:

- destination clock의 최소 frequency와 stop behavior를 알고 있다.
- event 사이 최소 간격이 충분하다.
- stretch interval 동안 새 event가 합쳐져도 된다거나 금지된다.

단점:

- 충분한 width 계산이 clock ratio/phase/uncertainty에 의존
- back-to-back event가 하나의 level로 합쳐질 수 있음
- destination clock stop 시 delivery 보장 어려움

Source와 destination clock이 완전히 asynchronous하면 “destination 두 cycle 길이”를 source cycle만으로 단순 계산하지 않는다. Frequency range와 protocol margin을 사용한다.

## 4. Toggle Synchronizer

Source event마다 bit를 toggle하고, destination에서 synchronized toggle의 변화를 검출한다.

```text
source event
     ↓
toggle bit ──> 2FF sync ──> delayed copy XOR ──> dst pulse
```

### Generic source

```systemverilog
always_ff @(posedge src_clk or negedge src_rst_n) begin
    if (!src_rst_n)
        src_toggle <= 1'b0;
    else if (src_event)
        src_toggle <= ~src_toggle;
end
```

### Generic destination

```systemverilog
always_ff @(posedge dst_clk or negedge dst_rst_n) begin
    if (!dst_rst_n) begin
        sync_meta    <= 1'b0;
        sync_toggle  <= 1'b0;
        sync_delayed <= 1'b0;
    end else begin
        sync_meta    <= src_toggle;
        sync_toggle  <= sync_meta;
        sync_delayed <= sync_toggle;
    end
end

assign dst_pulse = sync_toggle ^ sync_delayed;
```

이 구조는 event width를 toggle state에 보존하지만, destination이 변화를 관찰하기 전에 source가 두 번 toggle하면 원래 값으로 돌아와 두 event를 모두 놓칠 수 있다.

따라서 최대 event rate와 minimum spacing이 필요하다.

## 5. Request/Acknowledge Handshake

Event loss가 허용되지 않고 source가 다음 event를 기다릴 수 있다면 handshake가 더 명확하다.

```text
Source                          Destination
event → request level ──sync──> detect/process
       hold request <──sync──── acknowledge
       clear request            clear acknowledge
```

Four-phase 또는 two-phase protocol 등 여러 방식이 있다. 중요한 contract:

- Source는 acknowledge까지 request를 유지한다.
- Destination은 request를 한 번만 처리한다.
- 다음 event를 받기 전에 protocol이 idle로 돌아오는가?
- Reset mismatch에서 request/ack state가 deadlock하지 않는가?

Handshake는 latency와 throughput 비용이 있지만 event delivery를 protocol로 증명하기 쉽다.

## 6. Event Counter or Async FIFO

Event rate가 높거나 여러 outstanding event를 보존해야 하면 1-bit pulse protocol보다 queue/counter가 필요할 수 있다.

- Gray counter crossing: 누적 event count/snapshot semantics
- Async FIFO: event payload와 ordering 보존
- Credit/queue: bounded burst 흡수

Counter wrap, sampling lag와 overflow를 정의한다. 단순 binary counter bit별 2FF는 coherent count를 보장하지 않는다.

## 7. Destination Edge Detection

Persistent synchronized level을 pulse로 바꾸려면 destination-local delayed copy를 사용한다.

```systemverilog
always_ff @(posedge dst_clk or negedge dst_rst_n) begin
    if (!dst_rst_n)
        level_d <= 1'b0;
    else
        level_d <= sync_level;
end

assign rise_pulse = sync_level & ~level_d;
```

Combinational XOR/edge detect output을 destination FF가 어떻게 사용하는지 timing과 glitch를 확인한다. Synchronizer first stage에서 edge detect하지 않는다.

## 8. Reset and Initialization

Toggle protocol은 source/destination phase가 같다는 초기 assumption을 가진다. Independent reset은 다음 문제를 만든다.

- 한쪽 toggle만 reset되어 false event 생성
- reset 중 event loss
- destination delayed copy와 sync state 불일치
- handshake request/ack deadlock

정책 후보:

- simultaneous reset contract
- initialization handshake
- reset 후 첫 synchronized state를 baseline으로 채택
- epoch/version bit
- reset 중 event 금지 또는 queue 보존

어떤 정책이든 문서와 assertion으로 명시한다.

## 9. Clock Stop and Variable Frequency

Destination clock이 멈추면 synchronizer와 edge detector도 멈춘다.

- Pulse stretch는 clock resume 전에 deassert되면 손실될 수 있다.
- Toggle은 state가 유지되면 resume 후 관찰 가능하지만, stop 중 두 번 이상 toggle하면 손실될 수 있다.
- Handshake는 source가 request를 유지한다면 보존 가능하지만 source가 block될 수 있다.
- FIFO는 capacity 범위에서 burst를 저장할 수 있다.

Clock stop duration과 source event policy가 protocol 선택의 일부다.

## 10. Structure Comparison

| 구조 | Event 보존 | Throughput | Backpressure | 주요 assumption |
|---|---|---|---|---|
| Plain 2FF pulse | 보장 안 됨 | 낮음 | 없음 | pulse가 충분히 넓음 |
| Pulse stretch | 조건부 | 낮음 | 보통 없음 | min width와 event spacing |
| Toggle | 조건부 | 중간 | 없음 | 두 toggle 사이 destination 관찰 |
| Handshake | 보장 가능 | round-trip 제한 | 있음 | protocol/reset correctness |
| Counter/FIFO | 여러 event 보존 가능 | 높음 | 구조에 따라 | coherency, depth/overflow |

## 11. Verification Strategy

Event transfer는 end-to-end count로 검증하는 것이 유용하다.

- Accepted source event 수
- Delivered destination event 수
- Reset/abort 정책으로 제거된 event 수
- Outstanding event 수

필수 scenario:

- Source event phase sweep
- Fast-to-slow와 slow-to-fast ratio
- Minimum event spacing
- Back-to-back events
- Destination clock stop/resume
- Independent reset과 event overlap
- Counter/FIFO overflow condition

Assertion은 no-loss, no-duplicate, ordering과 bounded response를 protocol assumption 아래 확인한다.

## 12. Common Mistakes

- One-cycle source pulse에 2FF만 붙인다.
- Pulse stretch width를 nominal frequency만으로 정한다.
- Toggle event rate limit를 문서화하지 않는다.
- Toggle source가 두 번 바뀌면 원래 상태로 돌아온다는 점을 놓친다.
- Handshake reset asymmetry를 검증하지 않는다.
- Destination clock stop을 무시한다.
- Edge detector를 synchronizer first stage에 연결한다.
- Event loss 검증 없이 CDC tool의 recognized structure만 확인한다.

## 13. Design Review Checklist

- [ ] Crossing이 level이 아니라 event/pulse임을 식별했는가?
- [ ] 모든 event를 보존해야 하는가, 합쳐져도 되는가?
- [ ] 최대 event rate와 최소 spacing이 정의됐는가?
- [ ] Destination clock min frequency와 stop behavior가 정의됐는가?
- [ ] Pulse stretch/toggle/handshake/FIFO 선택 근거가 있는가?
- [ ] Toggle의 double-transition loss를 방지하는 rate contract가 있는가?
- [ ] Handshake request/ack priority와 reset sequence가 정의됐는가?
- [ ] Destination pulse가 정확히 한 cycle이며 중복되지 않는가?
- [ ] End-to-end event count와 ordering을 검증했는가?

## 관련 문서

- [CDC Overview](overview.md)
- [Metastability](metastability.md)
- [2FF Synchronizer](synchronizer.md)
- [Multi-Bit CDC](multi_bit_cdc.md)
- [Pulse, Level, and Event](../09_control_logic/pulse_level_event.md)
