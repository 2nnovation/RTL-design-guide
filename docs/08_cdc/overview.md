# Clock Domain Crossing Overview

Clock Domain Crossing(CDC)은 한 clock domain에서 생성된 signal이나 state가 서로 다른 clock relationship을 가진 destination domain으로 전달되는 문제다. CDC 설계의 목표는 단순히 lint warning을 없애는 것이 아니라 다음 두 가지를 보장하는 것이다.

1. destination sequential logic이 metastability로 인해 허용할 수 없는 확률로 실패하지 않는다.
2. destination이 source가 의도한 event와 data를 빠뜨리거나 중복하거나 조합이 깨진 상태로 해석하지 않는다.

> CDC 구조는 signal의 bit 수만 보고 고르는 것이 아니다. **level인지 pulse인지, event를 모두 보존해야 하는지, data가 얼마나 오래 안정적인지, source와 destination의 처리율이 얼마인지**를 먼저 정의해야 한다.

## 1. What Is a Clock Domain?

두 sequential block의 clock이 다음 중 하나라면 crossing 분석이 필요할 수 있다.

- frequency가 다르다.
- frequency가 같아도 phase relationship이 보장되지 않는다.
- 서로 독립된 clock source에서 온다.
- clock mux/divider/gating/mode 변경 때문에 일부 mode에서 relationship이 달라진다.
- 한 clock이 멈추거나 재시작한다.

Frequency가 같다는 사실만으로 synchronous한 것은 아니다. 반대로 gated clock이 root clock에서 파생되었다고 해서 무조건 asynchronous domain인 것도 아니다. 중요한 것은 implementation과 STA/CDC flow가 사용할 수 있는 **정의된 edge relationship**이 있는가다. Gated clock의 stop/resume 문제는 [Clock Gating](../06_clock/clock_gating.md)도 함께 참고한다.

```text
Source domain                       Destination domain

src_clk                             dst_clk
   │                                   │
 [FF] ───── crossing signal ─────────> [FF]
   │                                   │
known to source clock               sampled by a different edge set
```

Clock뿐 아니라 asynchronous reset deassertion도 유사한 위험을 만들 수 있다. 이것은 Reset Domain Crossing(RDC) 관점에서 별도로 분석해야 하며, CDC synchronizer 하나로 모든 reset 문제가 해결되는 것은 아니다.

## 2. Metastability

Destination flip-flop의 input이 active edge 근처 setup/hold window에서 변하면 flip-flop 내부 node가 일정 시간 논리 0 또는 1로 결정되지 못하는 metastable state에 들어갈 수 있다.

```text
async input transition
          │
          v
----- setup/hold aperture -----
             ^
          dst clock edge
```

Metastability는 digital RTL simulation에서 analog 현상 그대로 나타나지 않는다. Simulation에서 0/1이 깨끗하게 보이는 것은 silicon에서 안전하다는 증거가 아니다.

중요한 사실:

- metastability 발생 가능성을 완전히 0으로 만드는 digital circuit은 일반적으로 없다.
- 올바른 synchronizer는 metastable value가 functional logic에 도달할 확률을 요구 reliability 수준까지 낮춘다.
- probability는 clock frequency, asynchronous transition rate, available resolution time, cell 특성과 PVT 조건 등에 영향을 받는다.
- 첫 synchronizer stage의 output을 functional logic이 직접 사용하면 보호 효과를 잃는다.

자세한 2FF 구조와 제한은 [2FF Synchronizer](synchronizer.md)에서 다룬다.

## 3. Classify the Crossing First

CDC 구조 선택을 위한 첫 질문은 “몇 bit인가?”보다 “무슨 의미를 전달하는가?”다.

| Crossing 종류 | 핵심 위험 | 흔히 검토하는 구조 |
|---|---|---|
| Single-bit level | metastability, 짧은 level miss | 2FF/다단 synchronizer, 필요 시 handshake |
| Single-bit pulse/event | pulse miss, event merge/duplicate | pulse stretch, toggle synchronizer, handshake |
| Multi-bit control/state | bit별 capture cycle 차이, illegal combination | handshake/bundled control; 제한된 counter에는 Gray 검토 |
| Multi-bit payload | incoherent word, overwrite | bundled-data handshake, asynchronous FIFO |
| Continuous counter/pointer | bit transition 조합 오류 | Gray encoding + per-bit synchronization + skew control |
| Data + valid/control | data stability와 control ordering | bundled-data protocol, handshake, FIFO |

다음 항목도 함께 기록한다.

- source와 destination clock의 frequency 범위와 stop 가능성
- source signal의 최소/최대 유지 시간
- event를 하나도 잃으면 안 되는가
- back-to-back event의 최대 rate
- source가 destination의 수신 여부를 알아야 하는가
- destination이 처리하지 못할 때 backpressure가 필요한가
- reset 순서와 한쪽 domain만 reset되는 경우
- 허용 latency와 throughput

이 정보가 없으면 CDC primitive를 선택해도 protocol correctness를 증명할 수 없다.

## 4. Why a 2FF Synchronizer Is Not a Universal Solution

2FF synchronizer는 **충분히 오래 유지되는 single-bit asynchronous level**을 destination clock으로 가져올 때 대표적으로 사용한다. 그러나 다음 문제는 해결하지 않는다.

### 4.1 Short pulse

Source pulse가 destination의 두 sampling edge 사이에서 assertion과 deassertion을 모두 끝내면 첫 synchronizer stage가 한 번도 1을 보지 못한다.

```text
src pulse       ____/‾‾\____
dst edges       ↑          ↑
                no edge inside pulse
```

### 4.2 Multi-bit coherency

Bus 각 bit에 독립적인 2FF를 붙이면 bit별 metastability resolution과 capture cycle이 달라질 수 있다.

```text
Source changes  4'b0111 -> 4'b1000
Destination may observe an unintended mixture
```

각 bit가 “언젠가 안정된다”는 것과 word 전체가 “같은 transaction의 값이다”는 것은 다르다.

### 4.3 Event accounting

Level이 1로 보였다는 사실만으로 source event가 몇 번 발생했는지 알 수 없다. Source가 destination보다 빠르게 여러 event를 만들면 event가 합쳐질 수 있다.

### 4.4 Protocol ordering

Data와 valid를 각각 동기화해도 둘의 상대 도착 순서가 보장되지 않는다. 관련 signal은 하나의 protocol로 전달해야 한다.

따라서 “CDC warning → 2FF 추가”는 올바른 decision flow가 아니다.

## 5. Single-Bit Level Crossing

다음 조건을 만족하는 mode, enable, status 같은 signal은 2FF synchronizer의 좋은 후보다.

- signal이 single-bit다.
- destination은 현재 level만 알면 된다.
- level이 destination이 sampling할 수 있을 만큼 오래 유지된다.
- nominal 1–2 destination cycle의 synchronization latency를 허용한다.
- related signals과 cycle-exact하게 reconverge하지 않는다.

```text
async_level ──> [sync FF1] ──> [sync FF2] ──> destination logic
                       dst_clk
```

Fast-to-slow crossing에서도 signal이 “level”이라는 이유만으로 자동으로 안전하지 않다. Assertion과 deassertion이 모두 destination edge 사이에서 끝날 수 있다면 사실상 pulse crossing이다. Source가 level을 acknowledgement까지 유지하거나 최소 유지 시간을 보장해야 한다.

## 6. Pulse and Event Crossing

Pulse는 duration과 event rate가 핵심이다.

### 6.1 Pulse stretching

Source pulse를 destination이 반드시 sampling할 수 있을 만큼 길게 유지한 뒤 level synchronizer를 통과시킨다.

적합할 수 있는 경우:

- clock frequency 관계와 worst-case phase를 알고 있다.
- source pulse 간 최소 간격이 충분하다.
- stretched pulse가 여러 destination cycle high여도 기능적으로 문제없다.

주의점:

- “destination period보다 조금 길다”만으로 PVT, clock variation과 edge uncertainty까지 항상 보장되는지는 별도 검토가 필요하다.
- destination에서 edge detect를 하면 synchronized level의 rise/fall latency를 고려해야 한다.
- back-to-back pulse가 stretching 중 겹치면 event가 합쳐질 수 있다.

### 6.2 Toggle synchronizer

Source event마다 bit를 toggle하고, destination에서 동기화된 toggle의 변화를 검출한다.

```text
source event ─> toggle bit ─> 2FF sync ─> XOR with delayed value ─> dst pulse
```

장점:

- source pulse width에 직접 의존하지 않는다.
- destination에서 one-cycle event를 재생성하기 쉽다.

제약:

- destination이 관찰하기 전에 source가 두 번 toggle하면 두 event가 상쇄되어 보일 수 있다.
- event rate bound가 필요하다.
- source 또는 destination만 reset될 때 toggle phase mismatch가 가짜 event를 만들 수 있다.

### 6.3 Handshake

Source가 request를 올리고 destination이 수신 후 acknowledge를 돌려줄 때까지 request/data를 유지한다.

```text
Source                         Destination

req  ─────── synchronizer ───────>
data ===== held stable ==========> capture
ack  <────── synchronizer ────────
```

장점:

- event loss를 protocol로 방지한다.
- destination backpressure와 data stability를 명확히 표현할 수 있다.

비용:

- 왕복 synchronizer latency 때문에 maximum throughput이 낮아질 수 있다.
- request/acknowledge state와 reset recovery가 필요하다.
- 양쪽 domain의 protocol assertion과 liveness 검증이 필요하다.

Event를 절대 잃으면 안 되고 rate가 낮거나 moderate하다면 handshake가 pulse stretching보다 명확한 선택인 경우가 많다.

## 7. Multi-Bit CDC

### 7.1 Why independent synchronizers are unsafe

```systemverilog
// Bad as a generic multi-bit CDC solution
for (genvar i = 0; i < WIDTH; i++) begin
    // independent 2FF synchronizer for async_bus[i]
end
```

각 bit가 서로 다른 destination cycle에 정착하면 incoherent word를 만들 수 있다. **Encoding의 이름만으로 independent bit synchronization이 안전해지지는 않는다.** One-hot transition은 보통 두 bit가 바뀌며, thermometer code도 여러 step을 건너뛰면 여러 bit가 바뀔 수 있다. Gray code도 등록된 source가 인접 값 사이를 한 step씩 이동하고, event rate와 bit-to-bit physical skew 조건을 만족하는 counter/pointer protocol에서만 그 성질을 활용할 수 있다. 그 외에는 handshake, bundled-data 또는 FIFO처럼 transaction coherency를 명시하는 구조를 사용한다.

### 7.2 Bundled-data transfer

Payload data는 source 쪽에서 안정적으로 유지하고, synchronized control이 destination capture 시점을 알리는 방식이다.

```text
Source data register ===== stable window =====> Destination data register
Source valid/req ──> control synchronizer ────> capture enable
```

핵심 assumption:

- data가 control보다 충분히 먼저 안정된다.
- destination capture가 끝날 때까지 source가 data를 바꾸지 않는다.
- control crossing과 physical data delay를 포함한 worst-case margin이 검증된다.
- 다음 transaction이 현재 transaction을 overwrite하지 않는다.

Data bus 자체에 independent 2FF를 넣지 않아도 될 수 있지만, 이것은 synchronizer를 생략한 “운”이 아니라 protocol과 timing assumption으로 coherency를 보장하는 구조다.

### 7.3 Gray code

Gray code는 인접 count가 한 bit만 바뀌도록 encoding한다. Asynchronous FIFO pointer처럼 monotonic counter state를 건널 때 simultaneous multi-bit transition 위험을 줄이는 데 유용하다.

주의점:

- arbitrary payload를 Gray code로 바꾼다고 일반 multi-bit CDC가 해결되는 것은 아니다.
- source의 binary-to-Gray combinational output 대신 등록된 Gray state를 crossing source로 사용하는 것이 glitch risk를 줄이는 데 유리할 수 있다.
- destination이 sampling하는 경로에서 bit 간 excessive skew가 one-bit-change 전제를 훼손하지 않도록 implementation constraint와 sign-off가 필요할 수 있다.
- destination은 source가 빠를 때 intermediate count를 건너뛸 수 있다. Pointer 비교 protocol은 이를 허용하도록 설계한다.

### 7.4 Asynchronous FIFO

연속적인 multi-bit transaction을 서로 독립적인 clock 사이에서 높은 throughput으로 전달할 때 asynchronous FIFO를 검토한다.

일반적인 구성 요소:

- dual-clock storage
- source/write pointer와 destination/read pointer
- 반대 domain으로 전달되는 encoded pointer
- full/empty 또는 almost-full/almost-empty status logic
- reset과 pointer initialization protocol

Async FIFO는 “CDC가 알아서 해결되는 memory”가 아니다. Pointer synchronization, full/empty correctness, depth sizing, reset asymmetry와 overflow/underflow 검증이 필요하다. 검증된 reusable FIFO implementation을 사용하는 편이 직접 새로 만드는 것보다 안전한 경우가 많다.

## 8. Reconvergence and Coherency

CDC tool이 각 signal에 2FF가 있다고 확인해도 destination에서 reconverge하면 기능적으로 위험할 수 있다.

```text
async_a ─> 2FF ─┐
                 ├─> combinational decision
async_b ─> 2FF ─┘
```

`async_a`와 `async_b`가 source에서는 같은 event에 바뀌어도 destination synchronizer latency는 서로 한 cycle 다를 수 있다. 그 결과 source에 존재하지 않았던 combination이 만들어진다.

해결 방향:

- related conditions를 source에서 하나의 control로 encode한다.
- request/data handshake로 atomic하게 전달한다.
- destination protocol이 모든 intermediate combination을 안전하게 허용하도록 한다.
- one-hot처럼 illegal transient가 위험한 encoding을 그대로 independent synchronize하지 않는다.

CDC correctness는 synchronizer cell의 개수보다 **destination에서 의미가 다시 합쳐지는 지점**에서 판단해야 한다.

## 9. Reset and Clock-Stop Scenarios

CDC protocol은 정상 clock 동작뿐 아니라 reset과 clock stop에서 닫혀야 한다.

검토할 corner case:

- source만 reset되고 destination state는 남는가?
- destination만 reset되어 이전 request를 잊는가?
- toggle synchronizer의 두 domain이 서로 다른 초기 phase를 갖는가?
- handshake 도중 한 domain이 reset되면 request/ack가 영구 대기하는가?
- destination clock이 멈춘 동안 source가 event를 여러 개 생성하는가?
- clock restart 후 stale data를 새 transaction으로 오인하는가?

가능하면 reset sequence를 system-level assumption으로만 숨기지 말고 interface contract와 assertion으로 표현한다. 한쪽 clock이 영구히 멈출 수 있다면 “eventual acknowledge” 같은 liveness property는 clock-availability assumption과 함께 작성해야 한다.

## 10. CDC Analysis Tools

Static CDC tool은 clock relationship과 structural pattern을 분석해 다음을 찾는 데 도움을 준다.

- unsynchronized crossing
- recognized 2FF/toggle/handshake/FIFO structure
- combinational logic before synchronizer
- synchronizer first-stage fanout
- multi-bit incoherency risk
- synchronized signals의 reconvergence
- missing or inconsistent clock/reset definition

하지만 tool이 “recognized”라고 표시한 것은 functional protocol이 옳다는 완전한 증명이 아니다. 예를 들어 2FF 구조를 인식해도 source pulse가 너무 짧아 miss되는 문제는 protocol 정보 없이는 판단하기 어렵다.

### Waiver principles

CDC violation waiver는 warning을 숨기는 편의 기능이 아니라 검토 결과를 기록하는 engineering artifact다. 좋은 waiver에는 다음이 포함되어야 한다.

- crossing의 source와 destination 의미
- 왜 일반 synchronizer pattern이 필요 없거나 다른 구조가 안전한지
- data stability, event rate, clock relationship 같은 functional assumption
- 그 assumption을 검증하는 assertion, constraint 또는 test
- RTL/clock/reset 변경 시 재검토할 owner와 조건

“simulation passed”, “known path”, “false warning”만 적은 waiver는 유지보수 가능한 justification이 아니다.

## 11. Verification Strategy

CDC는 한 가지 도구만으로 충분히 검증하기 어렵다.

### Structural analysis

- 모든 crossing이 inventory에 있는지 확인한다.
- synchronizer, handshake, FIFO pattern이 올바르게 인식되는지 확인한다.
- reconvergence와 combinational logic before sync를 확인한다.

### RTL simulation

- arbitrary clock ratio와 phase를 바꿔 본다.
- fast-to-slow, slow-to-fast, clock stop/restart를 검증한다.
- reset이 transaction 중간에 발생하는 case를 검증한다.
- back-to-back event와 maximum traffic를 검증한다.

RTL simulation은 metastability MTBF를 증명하지는 않지만 pulse miss, protocol ordering, overflow와 reset bug를 찾는 데 유용하다.

### Assertions and formal

- request는 acknowledge까지 유지되는가?
- bundled data는 capture까지 stable한가?
- FIFO는 overflow/underflow하지 않는가?
- source event마다 허용 latency 내 정확히 한 번 destination event가 발생하는가?
- reset 후 stale event가 생성되지 않는가?
- mutual exclusion 또는 encoding invariant가 유지되는가?

Formal proof를 사용할 때도 clocks eventually toggle, environment holds data 같은 assumption이 실제 system contract와 일치하는지 검토한다.

### Implementation sign-off

- synchronizer stage가 implementation flow에서 보존·인식되는가?
- first-to-second stage resolution time이 불필요한 logic/routing으로 줄지 않는가?
- Gray/bundled-data에 필요한 physical timing/skew constraint가 적용되는가?
- MTBF target이 product reliability requirement를 만족하는가?

## 12. CDC Decision Flow

```text
Identify a crossing
        ↓
What is the information type?
        ├─ Single-bit stable level ──> 2FF / multi-stage synchronizer
        ├─ Pulse or event
        │       ├─ minimum pulse width/gap guaranteed ─> stretch + level sync
        │       ├─ minimum inter-event spacing guaranteed ─> toggle
        │       └─ no loss / backpressure needed ─> handshake
        ├─ Multi-bit state/counter ──> encoded protocol / Gray where valid
        └─ Multi-bit payload
                ├─ occasional transfer ─> bundled-data handshake
                └─ continuous stream ──> asynchronous FIFO
        ↓
Define stability, rate, reset, and clock-stop assumptions
        ↓
Run structural CDC + assertions + simulation/formal
        ↓
Verify implementation and document waivers
```

## 13. Common Mistakes

### “Every crossing gets two flops”

2FF는 short pulse, multi-bit coherency와 event accounting을 해결하지 않는다.

### “Each bus bit is synchronized, so the bus is safe”

Bit-level metastability containment과 transaction-level coherency를 혼동한 것이다.

### “Same frequency means no CDC”

정의된 phase relationship이 없으면 같은 frequency의 두 clock도 asynchronous일 수 있다.

### “CDC tool passed, so the protocol is correct”

Tool은 source pulse width, maximum event rate, data hold contract를 자동으로 알지 못할 수 있다.

### “Waive now, document later”

숨겨진 assumption은 RTL 또는 constraint 변경 후 쉽게 깨진다.

### “Reset is separate from CDC”

Reset asymmetry가 toggle mismatch, stale request와 handshake deadlock을 만들 수 있다.

## 14. Design Review Checklist

### Inventory and classification

- [ ] 모든 source/destination clock pair를 식별했는가?
- [ ] Mode별 clock relationship과 clock stop 가능성을 정의했는가?
- [ ] Crossing을 level, pulse/event, multi-bit state, payload로 분류했는가?
- [ ] Reset domain crossing과 one-sided reset case를 식별했는가?

### Protocol

- [ ] Source signal의 최소 유지 시간과 maximum event rate가 정의되어 있는가?
- [ ] Event loss, duplication과 reordering 허용 여부가 정의되어 있는가?
- [ ] Backpressure 또는 acknowledge가 필요한가?
- [ ] Data stability window와 ownership이 명확한가?
- [ ] Destination clock이 멈춰도 deadlock/overflow가 없는가?

### Structure

- [ ] Single-bit level에 2FF synchronizer가 적합한가?
- [ ] Short pulse에 plain 2FF만 사용하지 않았는가?
- [ ] Multi-bit bus에 independent 2FF를 일반 해법으로 사용하지 않았는가?
- [ ] Reconvergence되는 related signal이 atomic하게 전달되는가?
- [ ] Toggle, handshake, Gray, FIFO의 rate/encoding assumption이 만족되는가?

### Verification and sign-off

- [ ] CDC tool이 모든 clock/reset과 crossing structure를 인식하는가?
- [ ] 각 waiver에 functional justification과 검증 방법이 있는가?
- [ ] Variable clock ratio, back-to-back event와 reset overlap을 검증했는가?
- [ ] Assertions가 stability, no-loss, no-overflow 등의 protocol invariant를 확인하는가?
- [ ] Synchronizer placement와 required MTBF를 implementation 단계에서 확인했는가?

## 15. Key Takeaways

1. CDC는 metastability containment와 protocol correctness를 함께 다루는 문제다.
2. 2FF synchronizer는 stable single-bit level에는 적합하지만 pulse, multi-bit data와 event count에는 만능이 아니다.
3. Pulse stretch, toggle, handshake, bundled-data, Gray code와 asynchronous FIFO는 서로 다른 traffic model과 requirement를 해결한다.
4. 관련 signal을 독립적으로 synchronize한 뒤 reconverge하면 source에 없던 combination이 생길 수 있다.
5. Reset, clock stop, maximum event rate와 data hold time은 CDC architecture의 일부다.
6. CDC waiver는 assumption과 검증 근거를 보존해야 하며, tool-clean 결과만으로 functional safety가 증명되지는 않는다.

## 관련 문서

- [Metastability](metastability.md): analog failure mechanism, resolution time와 MTBF
- [2FF Synchronizer](synchronizer.md): persistent single-bit level containment
- [Pulse Crossing](pulse_crossing.md): stretch, toggle, handshake와 event delivery
- [Multi-Bit CDC](multi_bit_cdc.md): coherency, Gray pointer와 async FIFO 선택
- [Bundled Data](bundled_data.md): stable payload와 synchronized capture control contract
