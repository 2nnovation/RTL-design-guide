# Metastability

Metastability는 asynchronous transition이 destination sequential element의 sampling aperture 근처에 도착할 때, output이 일정 시간 유효한 logic 0 또는 1로 해석되기 어려운 analog 상태에 머물 수 있는 현상이다.

> Metastability는 RTL coding error가 아니라 clocked storage element의 물리적 현상이다. RTL 구조의 목표는 발생 가능성을 0이라고 가정하는 것이 아니라, functional failure로 전파될 확률을 system requirement에 맞게 낮추는 것이다.

CDC 용어와 구조 선택은 [CDC Overview](overview.md), 대표 containment 구조는 [2FF Synchronizer](synchronizer.md)를 참고한다.

## 1. Why It Happens

Destination FF는 active clock edge 주변의 setup/hold aperture에서 input이 충분히 안정되기를 요구한다.

```text
data      ────────╲________________
                    transition near edge

dst_clk   __________/‾‾‾‾‾‾‾‾‾‾‾‾
                    ↑ sample edge
                 setup/hold aperture
```

Source와 destination clock이 asynchronous하면 transition phase가 destination edge에 대해 계속 변할 수 있으므로 aperture에 들어갈 확률이 존재한다.

## 2. Analog Behavior와 Digital Observation

FF 내부 노드가 metastable하면 Q가 정상 propagation delay보다 늦게 결정되거나, downstream threshold에서 모호한 전압을 가질 수 있다. 최종적으로 0 또는 1로 resolve하더라도 어느 값과 어느 시점으로 정착할지 digital model만으로 결정적으로 예측할 수 없다.

Possible digital consequences:

- 다음 stage가 old value를 한 cycle 더 유지
- 서로 다른 fanout FF가 다른 값을 capture
- combinational control이 glitch 또는 invalid combination 생성
- resolution budget을 넘겨 다음 stage까지 failure 전파

“Metastability가 발생하면 무조건 oscillation한다”거나 “항상 한 cycle 늦어진다”는 설명은 부정확하다.

## 3. RTL Simulation의 한계

일반 RTL simulator의 `0`, `1`, `X`는 analog voltage/time evolution을 직접 모델링하지 않는다.

- Setup/hold violation이 있어도 RTL FF는 0 또는 1을 deterministic하게 capture할 수 있다.
- `X` injection은 protocol robustness를 시험할 수 있지만 silicon metastability probability를 계산하지 않는다.
- CDC structural tool이 clean해도 MTBF target이 자동 보장되는 것은 아니다.

Verification은 구조, protocol과 implementation evidence를 결합한다.

```text
RTL/protocol assertions
        +
CDC structural analysis
        +
STA/placement/resolution-time analysis
        +
cell characterization + MTBF requirement
```

## 4. Containment Principle

가장 기본적인 원칙은 metastability를 받아들일 수 있는 first stage를 functional logic에서 격리하는 것이다.

```text
async input ──> [containment FF] ──> [resolution/sample FF] ──> logic
                         no functional fanout
```

Stage 사이 combinational logic과 큰 route delay는 resolution time을 줄인다. First-stage Q는 second stage 외의 logic에서 사용하지 않는다.

## 5. Resolution Time와 MTBF

Metastability-related failure probability는 일반적으로 available resolution time이 늘수록 빠르게 감소한다. 정량 계산에는 target library/technology가 제공하는 characterized parameter가 필요하다.

정성적 영향:

| 변화 | 일반적 영향 |
|---|---|
| Async transition rate 증가 | failure opportunity 증가 |
| Destination clock frequency 증가 | sampling opportunity 증가, period 감소 가능 |
| Stage-to-stage available time 증가 | MTBF 개선 가능 |
| Stage 사이 route/logic delay 증가 | resolution time 감소 |
| Synchronizer stage 추가 | reliability 개선 가능, latency 증가 |
| 불리한 PVT | cell resolution 특성 악화 가능 |

Generic constant나 인터넷 예제의 MTBF 숫자를 실제 설계에 그대로 사용하지 않는다.

## 6. Aggregate Reliability

한 synchronizer의 MTBF만 보는 것으로 충분하지 않을 수 있다. Design에 많은 crossing이 있으면 전체 failure rate는 각 crossing의 기여를 합쳐 평가해야 한다.

Review input:

- crossing별 transition rate upper bound
- destination frequency range
- stage 수와 post-route delay
- PVT/cell characterization
- synchronizer 개수
- system lifetime과 allowable failure rate
- safety redundancy/diagnostic coverage

## 7. Source Registration

Combinational source의 glitch는 asynchronous transition rate를 높일 수 있다.

```text
combinational decode with glitches ──> synchronizer
```

가능하면 source domain에서 signal을 register해 의미 있는 transition만 crossing한다.

```systemverilog
always_ff @(posedge src_clk or negedge src_rst_n) begin
    if (!src_rst_n)
        src_level <= 1'b0;
    else
        src_level <= next_level;
end
```

Source registration은 protocol delivery나 destination synchronization을 대신하지 않지만 input transition quality를 개선한다.

## 8. Reset and Metastability

Asynchronous reset deassertion도 sampling aperture와 recovery/removal requirement를 위반할 수 있다. 여러 register가 서로 다른 cycle에 reset에서 풀리면 invalid state가 생길 수 있다.

일반적인 원칙:

- asynchronous assertion이 필요하더라도 destination domain에 대해 release를 안전하게 만든다.
- reset synchronizer와 functional data synchronizer의 역할을 구분한다.
- destination clock이 stopped이면 synchronous release가 진행되지 않음을 고려한다.
- independent domain reset에서 handshake/toggle phase가 어긋날 수 있음을 정의한다.

구체적인 cell/constraint는 project RDC methodology를 따른다.

## 9. Physical Implementation

Synchronizer reliability는 RTL stage 수만으로 정해지지 않는다.

- first/second stage를 가까이 배치
- first-stage fanout 최소화
- stage 사이 logic 금지
- excessive buffering/detour 방지
- approved synchronizer cell/metadata 사용
- post-route resolution-time 또는 MTBF report 확인

Broad false-path constraint로 first-to-second stage delay까지 분석에서 제거하지 않도록 한다.

## 10. When a 2FF Is Not the Complete Answer

Metastability containment과 information transfer correctness를 구분한다.

| Crossing | Metastability 외에 필요한 것 |
|---|---|
| Short pulse | pulse preservation 또는 event protocol |
| Multi-bit word | coherency/atomic capture |
| High-rate event | queue, counter 또는 backpressure |
| Data + valid | stability/order contract |
| Reset crossing | RDC release/reset alignment |

구조 선택:

- [Pulse Crossing](pulse_crossing.md)
- [Multi-Bit CDC](multi_bit_cdc.md)
- [Bundled Data](bundled_data.md)

## 11. Common Mistakes

- RTL simulation에서 문제가 없으므로 metastability가 없다고 결론 낸다.
- First-stage Q를 다른 logic/debug에 사용한다.
- Synchronizer stage 사이에 logic을 넣는다.
- Stage 수만 보고 MTBF를 보장한다고 주장한다.
- Short pulse와 multi-bit data에 independent 2FF만 적용한다.
- Source glitch와 transition rate를 무시한다.
- Reset deassertion과 stopped clock을 별도 문제로 취급한다.
- Physical placement와 aggregate failure rate를 확인하지 않는다.

## 12. Design Review Checklist

- [ ] Source/destination clock relationship이 실제로 asynchronous한가?
- [ ] Crossing semantics가 level, pulse, event, data 중 무엇인가?
- [ ] First-stage output이 containment 내부에만 있는가?
- [ ] Stage 사이 logic과 불필요한 route delay가 없는가?
- [ ] Source signal을 register해 glitch를 줄였는가?
- [ ] Transition rate와 destination frequency range가 정의됐는가?
- [ ] Cell/PVT/post-route data로 MTBF target을 확인했는가?
- [ ] Aggregate synchronizer count를 reliability budget에 포함했는가?
- [ ] Reset deassertion과 clock stop behavior가 정의됐는가?
- [ ] RTL simulation, CDC, STA와 physical verification의 역할을 구분했는가?

## 관련 문서

- [CDC Overview](overview.md)
- [2FF Synchronizer](synchronizer.md)
- [Pulse Crossing](pulse_crossing.md)
- [Multi-Bit CDC](multi_bit_cdc.md)
