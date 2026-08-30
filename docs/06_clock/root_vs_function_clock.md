# Root Clock vs Function Clock

Function-level clock gating에서 가장 중요한 architecture 질문은 “어떤 FF를 gated clock 아래에 둘 것인가?”다. Function이 꺼져도 clock을 다시 켜기 위해 필요한 logic은 살아 있어야 한다.

> Function clock을 enable하는 state를 같은 function clock 아래에 넣으면 block은 스스로 깨어날 수 없다.

이 문서의 root/function clock은 architecture 용어이며 특정 STA tool의 object class를 뜻하지 않는다. 공통 정의는 [Canonical RTL Design Terminology](../01_fundamentals/terminology.md)를 참고한다.

## 1. Architecture View

```text
ROOT CLOCK
    │
    ├───────────────> Always-on controller
    │                    ├─ wake request capture
    │                    ├─ clock enable state
    │                    └─ reset/power handshake
    │
    └─> ICG ─────────> FUNCTION CLOCK
                         ├─ local FSM
                         ├─ counter
                         ├─ datapath
                         └─ pipeline state
```

Always-on은 반드시 chip 전체에서 물리적으로 항상 켜진 전원 영역이라는 뜻이 아니라, **해당 function clock이 off인 동안에도 필요한 state transition을 할 수 있는 clock/control 경로**를 뜻한다.

## 2. Self-Deadlock

잘못된 dependency:

```text
function clock off
       ↓
wake state FF cannot update
       ↓
clock enable remains 0
       ↓
function clock stays off
```

예를 들어 다음 state가 function clock 아래에 있으면 위험하다.

- synchronized wake request의 final state
- `function_enable`을 set하는 FSM state
- clock-off acknowledgement를 해제하는 state
- reset release를 진행하는 state

Wake request가 combinationally ICG enable에 연결된다고 자동으로 안전해지는 것도 아니다. CDC, glitch, safe-phase와 gating timing requirement를 만족해야 한다.

## 3. Partition Questions

각 register에 대해 다음을 묻는다.

1. Function off 중 이 값이 바뀌어야 하는가?
2. Clock을 다시 켜기 위해 이 값이 필요한가?
3. Reset/interrupt/error를 function off 중 기억해야 하는가?
4. 값이 유지돼야 하는가, 재초기화해도 되는가?
5. Source가 다른 clock/power domain인가?

| Register 역할 | 일반적인 후보 |
|---|---|
| Wake request capture | root/always-on side |
| Clock enable state | root/always-on side |
| Function datapath payload | function clock side |
| Local counter/FSM | off 동안 불필요하면 function side |
| Error/interrupt sticky state | off 중 event 보존 요구에 따라 결정 |
| Output isolation/valid | system interface contract에 따라 결정 |

## 4. Safe Sleep Entry

Clock을 끄기 전에 function이 idle임을 증명해야 한다.

```text
stop request
     ↓
block stops accepting work
     ↓
in-flight transaction drains or aborts
     ↓
outputs/status become safe
     ↓
idle acknowledgement
     ↓
clock enable deasserted safely
```

Busy operation 중 clock을 끄면 partial state가 무기한 남거나 interface handshake가 deadlock될 수 있다.

## 5. Safe Wake-up

```text
wake event captured by always-on logic
     ↓
clock enable asserted through approved gating control
     ↓
function clock edges resume
     ↓
local reset/state becomes usable
     ↓
ready acknowledgement
     ↓
new transaction accepted
```

첫 edge 직후 function이 즉시 ready라고 가정하지 않는다. Clock stabilization, synchronizer fill, local state initialization과 pipeline flush가 필요할 수 있다.

## 6. Reset Interaction

### Synchronous reset

Function clock이 off이면 reset을 적용할 edge가 없다. 가능한 architecture:

- Reset 요구 시 먼저 function clock을 켠다.
- Reset은 pending 상태로 기록하고 clock resume 후 적용한다.
- Functional requirement가 허용하면 function state를 유지한다.
- Approved asynchronous reset strategy를 사용한다.

### Asynchronous reset

Assertion은 clock 없이 가능할 수 있지만 deassertion의 recovery/removal와 domain-local synchronization이 필요하다. Clock이 멈춘 상태에서는 synchronous release sequence가 진행되지 않는다.

## 7. CDC and Event Retention

Function clock이 멈춰 있으면 destination synchronizer도 진행하지 않는다. 짧은 wake pulse는 사라질 수 있다.

적합한 후보:

- always-on side에서 level로 latch
- request/acknowledge handshake
- sticky event bit
- toggle/queued event with reset protocol

Wake event delivery는 [Pulse Crossing](../08_cdc/pulse_crossing.md)과 [2FF Synchronizer](../08_cdc/synchronizer.md)의 조건을 함께 적용한다.

## 8. Output and State Semantics While Off

Clock off 상태에서 output은 다음 중 하나로 정의한다.

- 마지막 값 유지
- valid deassert와 stale payload 유지
- explicit safe value/isolation
- interface unavailable response

무엇을 선택하든 consumer가 off 상태를 해석할 수 있어야 한다. “Clock이 꺼졌으므로 아무도 안 본다”는 숨은 assumption은 피한다.

## 9. Physical and PPA Trade-offs

Function clock 아래로 더 많은 FF를 옮기면 clock power 절감 가능성이 커진다. 하지만 다음 비용도 커진다.

- function clock tree load와 physical region
- clock boundary crossing
- root-side status mirror
- wake/ack latency
- isolation/retention 필요성
- reset/test routing

Always-on logic을 지나치게 크게 남기면 gating 이익이 줄고, 지나치게 작게 만들면 wake-up correctness가 깨진다.

## 10. Verification Scenarios

| Scenario | 확인할 내용 |
|---|---|
| Idle에서 sleep | ack 후에만 clock이 멈추는가 |
| Busy에서 sleep request | drain/reject/abort 정책이 동작하는가 |
| Clock off 중 wake pulse | event가 보존되는가 |
| Clock off 중 reset | assertion과 release sequence가 정의됐는가 |
| Wake와 reset 동시 | priority와 ready timing이 명확한가 |
| Back-to-back sleep/wake | enable state가 lock되지 않는가 |
| Test mode | branch clock이 controllable한가 |

Self-deadlock은 liveness property로 검증할 수 있다. Environment가 root clock과 wake request를 제공한다는 assumption 아래, accepted wake는 eventually function ready로 이어져야 한다.

## 11. Common Mistakes

- Function enable FF를 function clock 아래에 둔다.
- Wake pulse가 stopped destination synchronizer를 통과할 것이라 가정한다.
- Clock off 중 synchronous reset이 즉시 적용된다고 가정한다.
- Busy transaction을 drain하지 않고 clock을 끈다.
- Output valid/isolation semantics를 정의하지 않는다.
- Clock resume 첫 edge에서 모든 local state가 ready라고 가정한다.
- Power 절감만 보고 root-side control/CDC/DFT overhead를 제외한다.

## 12. Design Review Checklist

- [ ] Function clock boundary diagram이 있는가?
- [ ] Clock enable과 wake request state가 root/always-on side에 있는가?
- [ ] Sleep entry 전에 in-flight transaction 처리 정책이 있는가?
- [ ] Wake event가 clock off 동안 보존되는가?
- [ ] Reset assertion/deassertion과 clock resume 순서가 정의됐는가?
- [ ] Function output의 off-state semantics가 정의됐는가?
- [ ] Interrupt/error sticky state의 위치가 requirement와 맞는가?
- [ ] Self-deadlock을 liveness/property로 검증했는가?
- [ ] Clock partition의 PPA 이익과 boundary overhead를 함께 측정했는가?

## 관련 문서

- [Clock Design Overview](overview.md)
- [Clock Gating](clock_gating.md)
- [Inferred vs Explicit Clock Gating](inferred_vs_explicit.md)
- [CDC Overview](../08_cdc/overview.md)
