# 2FF Synchronizer

2FF synchronizer(two-flip-flop synchronizer)는 asynchronous single-bit signal을 destination clock domain으로 가져올 때 metastability가 functional logic까지 전파될 확률을 낮추는 기본 CDC 구조다.

```text
                       destination clock domain

async_level ─────> [FF1] ─────> [FF2] ─────> destination logic
                    │            │
                 may become    use only this
                 metastable     synchronized output
```

> 2FF synchronizer는 **metastability containment structure**다. Short pulse 보존, multi-bit coherency, event counting과 protocol ordering까지 자동으로 해결하지는 않는다.

CDC 구조의 전체 선택 기준은 [CDC Overview](overview.md)를 먼저 참고한다.

## 1. Why It Matters

Asynchronous input은 destination clock edge와 고정된 관계가 없다. Input transition이 destination flip-flop의 setup/hold aperture 근처에 오면 첫 flip-flop은 metastable state에 들어갈 수 있다.

Metastability가 바로 combinational control, FSM transition 또는 여러 fanout으로 전달되면 다음과 같은 문제가 생길 수 있다.

- 서로 다른 downstream flip-flop이 0과 1을 다르게 해석한다.
- control condition이 한 cycle 동안 불일치한다.
- FSM이 의도하지 않은 transition을 한다.
- pulse 또는 enable이 중복되거나 누락된다.
- simulation에서는 재현되지 않는 낮은 확률의 silicon failure가 된다.

2FF 구조는 첫 stage가 metastability를 해소할 시간을 제공하고, 두 번째 stage만 functional logic에 노출하여 failure probability를 크게 낮춘다.

## 2. Hardware View

두 flip-flop은 같은 destination clock으로 구동한다.

```text
                                  resolving time
                            <---------------------->

dst_clk             ↑ edge N                       ↑ edge N+1
                    │                              │
async_level ───────>[ FF1 ]──── possibly meta ───>[ FF2 ]──> sync_level
                        │                              │
                        └─ only FF1 may directly       └─ functional output
                           sample the async input
```

동작을 단계별로 보면 다음과 같다.

1. `FF1`이 asynchronous input을 sampling한다.
2. Input이 setup/hold aperture 밖에서 안정적이었다면 `FF1`은 정상적인 0 또는 1을 출력한다.
3. Input transition이 aperture에 걸리면 `FF1` output이 metastable할 수 있다.
4. 다음 destination edge까지 `FF1`이 stable value로 resolve할 시간이 주어진다.
5. `FF2`가 resolve된 값을 sampling한다.

`FF1`이 다음 edge까지 resolve되지 않을 가능성은 0이 아니지만, 적절한 cell과 충분한 resolution time을 사용할 때 매우 작게 만들 수 있다. 필요한 reliability에 따라 third stage 또는 별도의 hardened synchronizer cell을 검토할 수 있으나, stage를 무조건 늘리기 전에 MTBF requirement와 latency cost를 정량적으로 확인한다.

### The first stage is not a usable signal

```text
Bad:

async ─> FF1 ─> FF2 ─> logic A
           └─────────> logic B   // metastable first-stage fanout
```

`FF1` output은 synchronizer 내부에서 `FF2`만 구동하는 것이 원칙이다. 첫 stage를 debug, status 또는 다른 logic에 사용하면 metastability를 다시 functional fanout에 노출한다.

### No combinational logic between stages

```text
Bad:

async ─> FF1 ─> combinational logic ─> FF2
```

Stage 사이의 combinational delay는 available resolution time을 줄인다. 또한 tool이 synchronizer chain으로 인식하지 못하게 만들 수 있다. 두 stage 사이에는 기능 논리를 두지 않고, implementation에서도 불필요한 route delay를 최소화한다.

## 3. Generic SystemVerilog Pattern

Reset requirement가 없는 stable level crossing의 가장 단순한 형태는 다음과 같다.

```systemverilog
module cdc_level_sync (
    input  logic dst_clk,
    input  logic async_level,
    output logic sync_level
);
    logic sync_meta;

    // Mark sync_meta and sync_level as one synchronizer chain using the
    // identification mechanism supported by the implementation flow.
    always_ff @(posedge dst_clk) begin
        sync_meta  <= async_level;
        sync_level <= sync_meta;
    end
endmodule
```

이 코드는 구조를 간결하게 보여 주지만 다음 사실을 함께 이해해야 한다.

- Simulation 시작 직후 `sync_level`이 unknown일 수 있다.
- Destination은 initialization이 끝날 때까지 output을 사용하지 않거나 별도의 valid 조건으로 mask해야 할 수 있다. 이 mask는 destination-local known state여야 하며, source가 known 상태라는 contract 아래 synchronizer chain을 채울 만큼의 active destination edge가 지난 뒤 해제한다.
- Target flow가 synchronizer chain을 보존하고 물리적으로 적절히 구현하도록 metadata/constraint가 필요할 수 있다.

### Pattern with reset

정의된 reset value가 기능적으로 필요하고 destination reset policy가 정해져 있다면 다음과 같은 형태를 사용할 수 있다.

```systemverilog
module cdc_level_sync_with_reset (
    input  logic dst_clk,
    input  logic dst_rst_n,
    input  logic async_level,
    output logic sync_level
);
    logic sync_meta;

    // Assumption: dst_rst_n assertion/deassertion follows the project's
    // destination-domain reset strategy; deassertion is safe to dst_clk.
    always_ff @(posedge dst_clk or negedge dst_rst_n) begin
        if (!dst_rst_n) begin
            sync_meta  <= 1'b0;
            sync_level <= 1'b0;
        end else begin
            sync_meta  <= async_level;
            sync_level <= sync_meta;
        end
    end
endmodule
```

이 예제의 reset style이 모든 프로젝트에 대한 권장 답은 아니다. Reset pin이 있는 cell 선택, reset-tree cost, asynchronous deassertion risk와 RDC methodology가 target마다 다르기 때문이다. “초기값을 보기 좋게 만들기 위해” synchronizer에 reset을 추가하지 말고 functional requirement와 reset architecture로 결정한다.

## 4. Synchronizer Identification Metadata

많은 implementation flow는 synchronizer register를 일반 pipeline register와 구분하는 mechanism을 제공한다. 흔히 `ASYNC_REG` 개념으로 불리지만 attribute 문법과 의미는 tool마다 다를 수 있다.

그 목적은 일반적으로 다음과 같다.

- CDC tool이 2FF chain을 recognized structure로 분류한다.
- synthesis가 stage를 retime, merge 또는 부적절하게 optimize하지 않도록 돕는다.
- P&R이 stage를 가깝게 배치해 resolution time을 확보하도록 돕는다.
- metastability-aware report 또는 MTBF analysis 대상임을 표시한다.

중요한 점:

- Attribute는 잘못된 protocol을 안전하게 바꾸지 않는다.
- 이름만 붙였다고 실제 placement나 MTBF가 자동으로 보장되는 것은 아니다.
- Attribute spelling을 generic RTL에 추측해서 하드코딩하지 말고 project flow가 정의한 wrapper, macro 또는 constraint를 사용한다.
- Synchronizer input에서 첫 stage까지의 asynchronous path 처리와 stage-to-stage timing은 sign-off methodology에 맞게 구성한다.

특히 broad false-path exception이 `FF1 → FF2` 경로까지 timing 분석에서 제거하지 않도록 주의한다. 첫 stage까지의 asynchronous arrival를 일반 setup timing으로 분석할 수 없다는 것과, 두 stage 사이 resolution time을 최대화해야 한다는 것은 서로 다른 문제다.

## 5. When 2FF Is Appropriate

2FF synchronizer는 다음 조건을 만족하는 crossing에 적합하다.

- **Single-bit** signal이다.
- Destination이 현재 **level**만 알면 된다.
- Source가 destination이 sampling할 수 있을 만큼 level을 유지한다.
- Nominal synchronization latency와 cycle uncertainty를 허용한다.
- Related signals과 exact-cycle coherency가 필요하지 않다.
- Transition rate와 reliability target에 대해 2-stage MTBF가 충분하다.

대표 예:

- asynchronous mode strap의 runtime sample
- 오래 유지되는 interrupt level
- 다른 domain의 idle/busy status level
- low-rate enable level
- handshake의 request 또는 acknowledge level

여기서 “오래 유지”는 막연한 표현이면 안 된다. 최소 assertion/deassertion duration, source event rate, destination clock의 minimum frequency와 stop 가능성을 interface contract에 기록한다.

## 6. When 2FF Is Not Enough

### 6.1 Short source pulse

```text
async_pulse     ______/‾‾\________
dst_clk         ↑              ↑
                no sampling edge while high
```

Pulse가 destination edge 사이에 완전히 들어가면 `FF1`은 pulse를 보지 못한다. 두 번째 flip-flop을 추가하는 것은 metastability propagation probability를 낮추지만 missed sampling을 고치지 않는다.

대안:

- pulse stretch
- event toggle + synchronization + destination edge detect
- request/acknowledge handshake
- event stream이라면 asynchronous FIFO 또는 counter-based protocol

### 6.2 Multi-bit bus

```text
async_bus[0] ─> 2FF ─┐
async_bus[1] ─> 2FF ─┤
async_bus[2] ─> 2FF ─┼─> may form an incoherent word
async_bus[3] ─> 2FF ─┘
```

Bit마다 capture와 resolution cycle이 다를 수 있으므로 independent 2FF는 일반적인 bus transfer 해법이 아니다. Bundled-data handshake, Gray-encoded pointer 또는 asynchronous FIFO처럼 coherency를 보장하는 protocol을 선택한다.

### 6.3 Event count or high-rate activity

`sync_level`이 한 번 high가 되었다고 source에서 event가 한 번만 일어났다는 뜻은 아니다. Destination이 관찰하기 전에 source level이 여러 번 바뀌면 event가 merge되거나 누락된다.

### 6.4 Cycle-related controls

두 related source control을 각각 synchronize해 destination에서 AND/OR하면 서로 다른 latency 때문에 source에 없던 combination이 생길 수 있다. 이것을 reconvergence라고 한다.

### 6.5 Data that changes continuously

Free-running binary counter나 rapidly changing payload를 그대로 2FF에 넣어 특정 snapshot을 얻으려 하면 coherency를 보장할 수 없다. Counter pointer라면 Gray code, snapshot data라면 capture handshake를 검토한다.

## 7. Fast-to-Slow and Slow-to-Fast Crossings

### Slow-to-fast level

Source level이 여러 destination cycle 유지된다면 faster destination이 sampling할 기회가 충분하므로 2FF level synchronizer가 자연스럽다. 그래도 transition이 destination edge 근처에 올 수 있으므로 metastability protection은 필요하다.

### Fast-to-slow level

Fast source의 signal이라도 assertion이 acknowledge까지 유지되는 true level이면 2FF로 전달할 수 있다. 그러나 source가 1 source cycle만 high로 만드는 signal은 destination 관점에서 pulse다.

```text
Incorrect reasoning:
“It is one bit, so two flops are enough.”

Correct questions:
“Can it assert and deassert between two destination edges?”
“Must every assertion be observed?”
```

Destination clock이 dynamic frequency scaling으로 느려지거나 완전히 멈출 수 있다면, minimum level width를 고정된 cycle 수로만 정의해서는 부족할 수 있다. Clock-availability contract나 handshake가 필요하다.

## 8. Latency and Cycle Uncertainty

Asynchronous transition은 destination edge에 대해 임의의 phase로 발생한다.

```text
Case A: transition just before a safely captured edge
        FF1 captures at edge N, FF2 updates at edge N+1

Case B: transition just after edge N
        FF1 captures at edge N+1, FF2 updates at edge N+2
```

따라서 source transition부터 **FF2의 Q가 edge 뒤에 갱신되는 시점**까지 nominal delay는 대략 1–2 destination periods 범위가 될 수 있다. Downstream register나 SVA가 `sync_level`을 다시 sampling한다면 그 관찰 convention 때문에 한 edge가 더해질 수 있으므로 interface latency를 어느 지점에서 정의하는지 명시한다. 흔히 “2-cycle synchronizer”라고 부르지만, asynchronous event 기준으로 fixed two-cycle response라고 가정해서는 안 된다.

Metastability가 보통의 resolution time보다 오래 지속되면 결과를 단순히 “한 cycle 늦는다”로만 설명할 수 없다.

- `FF1`이 old value로 resolve해 level transition이 다음 sample로 미뤄질 수 있다.
- 더 드물게 resolution budget을 넘으면 `FF2`가 잘못된 값을 capture하거나 metastability가 functional side로 전파될 수 있다. 이것이 MTBF가 다루는 synchronization failure다.

그러므로 2FF 자체가 deterministic bounded delivery를 보장한다고 주장하지 않는다. Protocol은 nominal latency uncertainty를 허용하고, event delivery가 반드시 필요하면 handshake 같은 acknowledgement 구조를 사용하며, 남는 probabilistic failure가 system reliability target을 만족하는지는 MTBF 분석으로 확인한다.

Latency가 더 중요하다는 이유로 `FF1` output을 직접 사용하는 것은 허용 가능한 최적화가 아니다. 낮은 latency가 필수라면 source/destination architecture, clock relationship 또는 protocol 자체를 다시 설계한다.

## 9. MTBF: Qualitative Design Factors

Mean Time Between Failures(MTBF)는 synchronizer output에 metastability-related failure가 나타날 평균 시간에 대한 reliability metric이다. 실제 계산은 characterized cell parameters와 implementation condition을 사용해야 하며 generic 상수로 추정하면 안 된다.

정성적 관계는 다음과 같다.

| Factor | MTBF에 대한 일반적 영향 | 이유 |
|---|---|---|
| Asynchronous transition rate 증가 | 감소 | setup/hold aperture 근처에 transition이 올 기회 증가 |
| Destination clock frequency 증가 | 감소 가능 | sampling 기회 증가, stage 간 resolution time 감소 가능 |
| FF1→FF2 available resolution time 증가 | 크게 증가 | metastability가 resolve될 시간 증가 |
| Stage 추가 | 증가 가능 | 추가 resolution interval 제공 |
| Stage 사이 logic/routing delay 증가 | 감소 | 실제 resolution time 잠식 |
| PVT가 cell resolution에 불리한 방향으로 변화 | 감소 가능 | metastability decay 특성 변화 |
| Synchronizer-optimized cell 사용 | 증가 가능 | 더 빠른 resolution을 목표로 characterization된 경우 |

MTBF는 resolution time에 대해 강한, 흔히 exponential한 민감도를 보이므로 stage placement와 stage-to-stage delay가 중요하다. 반면 stage를 하나 늘리면 latency, area와 destination clock power도 늘어난다.

Reliability 검토 시 다음을 명시한다.

- system이 요구하는 failure rate
- 이 crossing의 실제 transition rate upper bound
- destination clock의 operating range
- PVT corner와 available resolution time
- 같은 design에 있는 synchronizer 수를 고려한 aggregate risk
- safety/redundancy requirement

2FF라는 이름만으로 목표 MTBF가 자동 보장되지는 않는다.

## 10. Reset and Deassertion Cautions

Reset은 synchronizer 설계에서 자주 간과되는 또 하나의 asynchronous signal이다.

### 10.1 Asynchronous deassertion

Asynchronous reset이 destination edge 근처에서 deassert되면 recovery/removal requirement를 위반해 synchronizer register 자체가 metastable하거나 stage들이 서로 다른 cycle에 reset에서 풀릴 수 있다. 일반적인 방향은 reset을 asynchronously assert할 수 있더라도 destination domain에 대해 synchronously deassert하는 것이다.

구체적인 reset synchronizer 구조와 cell 사용은 project의 RDC methodology와 [Reset Deassertion and RDC](../07_reset/reset_deassertion.md)를 따른다.

### 10.2 Resetting both stages

두 stage를 같은 값으로 reset하면 simulation startup과 functional initialization이 명확해질 수 있다. 그러나 다음 cost가 있다.

- reset pin이 있는 cell 사용과 reset routing
- asynchronous reset deassertion 분석
- synchronizer stage placement에 reset network가 주는 제약
- reset tree의 area, fanout과 timing

Output이 valid되기 전 사용되지 않는다면 synchronizer data flops를 reset하지 않고 valid/control로 mask하는 architecture가 더 적합할 수도 있다. 반대로 safety/control requirement상 known reset state가 반드시 필요할 수 있다. 기능 요구로 결정한다.

### 10.3 Independent source/destination reset

Stable level crossing은 reset 후 몇 destination cycle 내 현재 source level로 수렴할 수 있다. 하지만 event/toggle/handshake는 한쪽만 reset될 때 다음 문제가 생길 수 있다.

- old toggle phase를 새 event로 오인
- reset 중 발생한 event loss
- request만 남고 acknowledge state가 사라져 deadlock
- synchronized status가 stale한 동안 잘못된 decision

Event protocol에는 reset alignment, initialization handshake 또는 epoch/version semantics가 필요할 수 있다.

### 10.4 Clock stopped during reset release

Destination clock이 멈춰 있으면 synchronous deassertion을 완료할 edge가 없다. Clock start, reset release와 functional enable 순서를 함께 정의한다.

## 11. Reconvergence and Related Signals

### Independent related levels

```text
Source                         Destination

mode_a ─────> 2FF ─────┐
                        ├─> decode
mode_b ─────> 2FF ─────┘
```

Source에서 `mode_a`와 `mode_b`가 같은 edge에 바뀌어도 각 synchronizer는 destination에서 다른 cycle에 반영될 수 있다. Decode가 illegal intermediate state를 보게 된다.

대안:

- source에서 mutually exclusive state를 하나의 safely encoded event로 전달한다.
- mode change request/acknowledge handshake를 사용한다.
- destination이 모든 intermediate state를 benign하게 처리하도록 protocol을 바꾼다.
- payload는 bundled-data capture로 atomic하게 전달한다.

### Synchronized level used in multiple destinations

`FF2` output은 destination domain 내부에서 일반 synchronous signal로 fanout할 수 있다. 다만 매우 high fanout이면 functional 복제나 buffering이 필요할 수 있다. Synthesis가 synchronizer stage 자체를 복제하지 않도록 chain 식별과 implementation review가 중요하다.

## 12. Source-Side Design Matters

Synchronizer 앞의 source signal도 품질에 영향을 준다.

### Register the source when practical

Combinational decode output은 source inputs가 바뀔 때 glitch가 여러 번 발생할 수 있다. 이 glitch들은 functional event가 아니어도 asynchronous transition rate를 높여 MTBF를 악화시키거나 destination에서 잘못된 level로 포착될 수 있다.

```systemverilog
// Prefer a source-domain registered level when the protocol allows it.
always_ff @(posedge src_clk or negedge src_rst_n) begin
    if (!src_rst_n)
        src_status <= 1'b0;
    else
        src_status <= next_status;
end
```

Source registering이 protocol latency나 reset semantics를 바꾼다면 그 trade-off도 검토한다.

### Hold the level long enough

Handshake request라면 acknowledge가 돌아올 때까지 유지하는 형태가 명확하다.

```systemverilog
always_ff @(posedge src_clk or negedge src_rst_n) begin
    if (!src_rst_n)
        src_req <= 1'b0;
    else if (new_request)
        src_req <= 1'b1;
    else if (ack_sync)
        src_req <= 1'b0;
end
```

이 `src_req`는 destination에서 2FF로 동기화할 수 있는 persistent level이다. 단, 전체 handshake에는 destination acknowledge 생성과 return synchronizer, data stability와 reset recovery가 추가로 필요하다.

## 13. Synthesis and Physical Implementation View

좋은 RTL pattern만으로 synchronizer quality가 끝나지 않는다.

### Synthesis

- `FF1`과 `FF2`가 제거, merge 또는 retime되지 않는지 확인한다.
- 다른 logic이 stage 사이에 들어가지 않는지 확인한다.
- 첫 stage output이 다른 fanout으로 복제되지 않는지 확인한다.
- Intended synchronizer chain이 report에서 recognized되는지 확인한다.

### Static timing and constraints

- Source clock과 destination clock relationship을 정확히 선언한다.
- Asynchronous source-to-FF1 path exception은 flow methodology에 맞춘다.
- `FF1 → FF2`는 resolution time 확보를 위해 실제 delay를 분석·관리한다.
- Broad exception으로 synchronizer 내부 timing까지 무시하지 않는다.

### Placement and routing

- 두 stage를 가깝게 배치해 data path delay를 줄인다.
- FF1 output의 capacitance와 fanout을 최소화한다.
- Aggressive buffering이나 detour route가 resolution time을 잠식하지 않는지 확인한다.
- Required MTBF analysis에 post-route delay와 PVT data를 사용한다.

Synchronizer는 timing violation을 고치기 위한 pipeline이 아니다. Stage 사이가 일반 setup timing을 만족해도 async input의 metastability risk가 사라지는 것은 아니며, 반대로 input path를 false 처리했다고 CDC가 안전해지는 것도 아니다.

## 14. Verification Strategy

RTL simulation은 analog metastability를 직접 증명하지 못한다. 대신 synchronizer를 둘러싼 protocol을 검증한다.

### Structural checks

- 정확히 의도한 stage 수가 있는가?
- 같은 destination clock을 사용하는가?
- stage 사이 combinational logic이 없는가?
- 첫 stage fanout이 두 번째 stage 하나로 제한되는가?
- CDC tool이 stable-level synchronizer로 인식하는가?

### Dynamic tests

- Source transition phase를 destination edge에 대해 변화시킨다.
- Destination frequency의 min/max와 clock stop/restart를 검증한다.
- Assertion과 deassertion을 모두 fast-to-slow 조건에서 검증한다.
- Reset 직전/도중/직후 transition을 검증한다.
- Related controls이 reconverge하는 모든 intermediate cycle을 검증한다.

### Useful assertions

다음 assertion은 protocol 예시이며 metastability MTBF 자체를 증명하지는 않는다.

Synchronizer output을 사용하기 시작한 뒤 unknown이 아닌지 확인한다.

아래의 `dst_init_done`은 다른 domain에서 그대로 건너온 signal이 아니라 destination에서 known reset state로 시작해, clock이 실제로 동작하고 synchronizer chain을 채울 시간이 지난 뒤 assert되는 local condition이어야 한다.

```systemverilog
property p_sync_output_known;
    @(posedge dst_clk) disable iff (!dst_init_done)
        !$isunknown(sync_level);
endproperty

assert property (p_sync_output_known);
```

Request-level handshake에서 acknowledge 전까지 source request가 유지되는지 확인한다.

```systemverilog
property p_request_held_until_ack;
    @(posedge src_clk) disable iff (!src_rst_n)
        src_req && !ack_sync |=> src_req;
endproperty

assert property (p_request_held_until_ack);
```

구조적 2-stage delay를 RTL simulation에서 확인하는 assertion도 작성할 수 있지만, 그것은 analog resolution을 모델링하지 않는다. 더 중요한 end-to-end property는 다음과 같다.

- 환경 assumption을 만족하는 source level은 destination에서 eventually 관찰되는가?
- 하나의 source event가 destination에서 정확히 한 번 처리되는가?
- Reset 중 event 처리 정책이 specification과 일치하는가?
- 관련 data가 capture될 때 stable한가?

Formal verification에서는 destination clock이 eventually toggle한다는 조건과 source가 level을 충분히 유지한다는 assumption을 명시해야 한다. 그렇지 않으면 liveness proof가 의미 없거나 성립하지 않을 수 있다.

## 15. Common Mistakes

### Using FF1 output

첫 stage output을 latency 절감 목적으로 사용한다. Metastability가 functional logic으로 직접 전파될 수 있다.

### Two flops on every bit of a bus

개별 bit의 metastability probability는 낮출 수 있어도 word coherency를 보장하지 못한다.

### Sending a one-cycle source pulse

Fast source의 one-cycle pulse는 slow destination이 완전히 놓칠 수 있다.

### Adding combinational logic before or between stages

Source-side glitch는 transition rate를 높이고, stage-between logic은 resolution time을 줄인다.

### Assuming exactly two cycles of latency

Asynchronous phase 때문에 observation cycle은 불확정적이다. Exact-cycle comparison이나 simultaneous reconvergence가 깨질 수 있다.

### Resetting for simulation convenience

Functional requirement 없이 reset을 추가하면 reset routing과 deassertion 위험만 늘 수 있다.

### Applying an attribute and stopping the review

Synchronizer metadata는 implementation aid이지 pulse width, coherency, event rate와 reset protocol의 증명이 아니다.

### Ignoring aggregate reliability

한 synchronizer의 MTBF만 충분해 보여도 design 전체에 매우 많은 crossing이 있으면 aggregate failure rate를 별도로 평가해야 한다.

## 16. Recommended Decision Flow

```text
Single-bit crossing found
        ↓
Is it a persistent level?
   NO ──> pulse/toggle/handshake/FIFO analysis
   YES
        ↓
Can it remain stable long enough for the destination?
   NO ──> add an acknowledge or change the protocol
   YES
        ↓
Can 1–2+ destination-cycle latency be tolerated?
   NO ──> revisit clock/architecture; do not use FF1
   YES
        ↓
Implement destination 2FF chain
        ↓
Keep FF1 internal; no logic between stages
        ↓
Define reset + clock-stop behavior
        ↓
Run CDC structural checks and protocol assertions
        ↓
Verify placement, resolution time, and required MTBF
```

## 17. Design Review Checklist

### Signal semantics

- [ ] Crossing이 정말 single-bit level인가?
- [ ] Source가 assertion과 deassertion을 충분히 오래 유지하는가?
- [ ] 모든 event를 보존해야 한다면 level sync 대신 handshake가 필요한가?
- [ ] Fast-to-slow에서 pulse miss 가능성을 계산했는가?
- [ ] Destination clock이 멈추거나 frequency가 바뀔 수 있는가?

### RTL structure

- [ ] 두 stage가 같은 destination clock을 사용하는가?
- [ ] FF1 output은 FF2만 구동하는가?
- [ ] Stage 사이 combinational logic이 없는가?
- [ ] Source signal을 register해 glitch를 줄일 수 있는가?
- [ ] Synchronizer identification metadata가 project flow와 일치하는가?

### Protocol and reconvergence

- [ ] 1–2+ destination-cycle latency uncertainty를 허용하는가?
- [ ] 독립적으로 synchronized된 related signal이 reconverge하지 않는가?
- [ ] Multi-bit data는 별도 coherency protocol을 사용하는가?
- [ ] Event rate가 synchronization 구조의 처리 한계를 넘지 않는가?

### Reset

- [ ] Synchronizer register에 reset이 기능적으로 필요한가?
- [ ] Reset deassertion이 destination clock에 안전한가?
- [ ] Source/destination one-sided reset behavior가 정의되어 있는가?
- [ ] Destination clock이 정지한 상태의 reset release sequence가 정의되어 있는가?

### Implementation and reliability

- [ ] CDC tool이 chain을 올바르게 인식하는가?
- [ ] Synthesis가 stage를 merge/retime/duplicate하지 않는가?
- [ ] FF1→FF2 path가 timing 분석에서 실수로 제외되지 않았는가?
- [ ] 두 stage가 물리적으로 가깝고 FF1 fanout이 작은가?
- [ ] 실제 transition rate, clock range, PVT와 stage 수로 MTBF target을 확인했는가?

### Verification

- [ ] Variable phase와 frequency ratio를 사용해 검증했는가?
- [ ] Source transition과 reset overlap을 검증했는가?
- [ ] Protocol assertion이 hold/no-loss/no-duplicate requirement를 확인하는가?
- [ ] RTL simulation 결과를 metastability sign-off로 오해하지 않았는가?

## 18. Key Takeaways

1. FF1은 metastability를 받아들일 수 있는 containment stage이며 functional logic은 FF2 이후만 사용한다.
2. Stage 사이에는 logic을 두지 않고, implementation에서 resolution time을 최대화한다.
3. 2FF는 persistent single-bit level에 적합하다. Short pulse, multi-bit bus와 high-rate event에는 다른 protocol이 필요하다.
4. Synchronizer latency는 asynchronous phase 때문에 exact two-cycle response가 아니다. Nominal 1–2 destination periods, old-value resolution에 따른 추가 관찰 지연, MTBF로 평가할 rare synchronization failure를 구분한다.
5. Reset deassertion, clock stop와 independent domain reset은 synchronizer protocol의 일부다.
6. Attribute, lint-clean 결과와 RTL simulation만으로 MTBF와 functional delivery가 증명되지는 않는다. 구조, protocol, physical implementation과 reliability target을 함께 검증한다.

## 관련 문서

- [Metastability](metastability.md): 2FF가 containment해야 하는 physical failure mechanism
- [Pulse Crossing](pulse_crossing.md): plain 2FF가 short event를 놓칠 수 있는 이유와 대안
- [Multi-Bit CDC](multi_bit_cdc.md): independent synchronizer가 coherency를 보장하지 못하는 이유
- [Bundled Data](bundled_data.md): multi-bit snapshot의 payload/control protocol
- [Reset Deassertion and RDC](../07_reset/reset_deassertion.md): data synchronizer와 구분되는 reset release structure
