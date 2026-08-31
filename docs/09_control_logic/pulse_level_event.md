# Pulse, Level, and Event

Pulse는 보통 **한 번 처리해야 할 사건**을 나타내고, level은 **현재 유지되는 상태나 조건**을 나타낸다. 두 표현을 혼동하면 held-high level을 여러 사건으로 세거나, 짧은 pulse를 놓치거나, reset release 뒤 가짜 event를 만들 수 있다.

이 문서는 같은 clock domain 안에서 pulse, level, edge detector와 pending/acknowledge를 설계하는 방법을 다룬다. Clock domain crossing은 [Pulse Crossing](../08_cdc/pulse_crossing.md)이 정본이다.

## 1. 먼저 의미를 고정한다

Signal 이름보다 다음 contract가 중요하다.

| 표현 | 의미 | Consumer 동작 |
|---|---|---|
| One-cycle pulse | 그 edge에 사건 하나 발생 | edge당 한 번 처리 |
| Held level | 조건이 현재 참 | 참인 동안 상태/enable 유지 |
| Valid/ready | payload가 제시되고 acceptance까지 유지 | `valid && ready`인 각 edge가 transfer |
| Sticky pending | 아직 acknowledge되지 않은 사건이 있음 | acceptance까지 valid 유지 |
| Event count/queue | 복수 outstanding 사건 보존 | 순서, depth와 overflow 관리 |

한 bit의 sticky pending은 “0개 또는 1개 이상”만 표현한다. Pending 동안 새 사건이 올 수 있고 각각을 보존해야 한다면 bit 하나가 아니라 counter나 queue가 필요하다.

## 2. Same-Domain Rising-Edge Detector

Synchronous level의 low→high transition은 현재 sample과 한 cycle 전 sample을 비교해 pulse로 바꿀 수 있다.

```systemverilog
logic level_d_q;
logic rise_event;

always_ff @(posedge clk or negedge rst_n) begin
  if (!rst_n)
    level_d_q <= 1'b0;
  else
    level_d_q <= level_in;
end

assign rise_event = rst_n && level_in && !level_d_q;
```

이 구조는 `level_in`이 `clk` domain의 setup/hold requirement를 만족한다는 전제다. Asynchronous input에 delayed FF 하나를 붙여 edge detector로 쓰면 metastability containment와 event capture를 모두 보장하지 못한다.

또한 위 단순 예제는 reset 중 `level_in=1`이고 release 뒤에도 high이면 release 후 첫 active edge에 사건을 만든다. 그것이 원하는 의미인지 명세해야 한다.

## 3. Reset 중 High인 Level의 정책

대표 정책은 두 가지다.

- **Count after release**: Reset 중의 상태와 관계없이 release 뒤 high를 새 event로 본다.
- **Baseline then arm**: Release 뒤 첫 sample은 baseline만 잡고, 이후 low를 관찰한 다음 high가 되어야 event로 본다.

다음 `armed_q` 구조는 baseline-then-arm 정책을 구현한다. Release 직후 첫 cycle에는 `armed_q=0`이므로 event가 생성되지 않고, 그 edge에서 현재 level을 baseline으로 저장한다.

```systemverilog
always_ff @(posedge clk or negedge rst_n) begin
  if (!rst_n) begin
    level_d_q <= 1'b0;
    armed_q   <= 1'b0;
  end else begin
    level_d_q <= level_in;
    armed_q   <= 1'b1;
  end
end

assign rise_event = rst_n && armed_q && level_in && !level_d_q;
```

Async reset deassertion 자체가 안전한지는 별도 문제다. Release 구조와 domain별 sequencing은 [Reset Deassertion and RDC](../07_reset/reset_deassertion.md)를 따른다.

## 4. Sticky Pending과 Acknowledge

One-cycle event를 downstream이 즉시 받을 수 없다면 event를 valid state로 보존한다. 다음 예제는 capacity가 1인 pending buffer다.

```systemverilog
module level_event_pending (
  input  logic clk,
  input  logic rst_n,

  input  logic level_in,

  output logic rise_event,
  output logic pending_valid,
  input  logic pending_ready,
  output logic pending_accept,
  output logic event_overflow
);
  logic level_d_q;
  logic armed_q;

  assign rise_event = rst_n && armed_q && level_in && !level_d_q;
  assign pending_accept = rst_n && pending_valid && pending_ready;

  // Release policy: sample a baseline before edge detection is armed.
  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      level_d_q <= 1'b0;
      armed_q   <= 1'b0;
    end else begin
      level_d_q <= level_in;
      armed_q   <= 1'b1;
    end
  end

  // A pending event is consumed only by pending_accept.
  // Simultaneous consume + new event refills the one-entry buffer.
  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      pending_valid  <= 1'b0;
      event_overflow <= 1'b0;
    end else begin
      event_overflow <= rise_event && pending_valid && !pending_ready;

      unique case ({rise_event, pending_accept})
        2'b10: pending_valid <= 1'b1; // capture new event
        2'b01: pending_valid <= 1'b0; // consume old event
        2'b11: pending_valid <= 1'b1; // consume old, capture new
        default: pending_valid <= pending_valid;
      endcase
    end
  end
endmodule
```

`rst_n && pending_valid && pending_ready`인 각 edge가 accepted event다. Downstream side effect는 `pending_valid` level만이 아니라 `pending_accept`에 연결한다. Reset assertion 중에는 interface acceptance를 명시적으로 mask해 reset scheduling이나 이전 pending 값에 의존하지 않는다.

Pending event가 있고 ready가 낮은 동안 또 rising edge가 오면 one-entry storage에는 두 사건을 구분해 담을 수 없다. 예제는 `event_overflow` pulse로 capacity violation을 드러낸다. **No-loss 보장은 `event_overflow`가 절대 발생하지 않는 환경 조건에서만 성립한다.** 그 조건을 보장할 수 없다면 counter 또는 FIFO로 바꾼다.

## 5. Re-arm과 Pulse Width

Rising-edge detector가 두 사건을 구분하려면 두 high 구간 사이에 적어도 한 active sampling edge에서 low를 관찰해야 한다.

```text
level_in    0  1  1  0  1
rise_event  0  1  0  0  1
```

- Held-high는 첫 rise만 만든다.
- `1,0,1`은 두 event를 만든다.
- Clock edge 사이에서만 low였다가 다시 high가 되면 detector는 re-arm을 관찰하지 못한다.
- 한 cycle보다 짧은 pulse도 active edge와 겹치지 않으면 놓칠 수 있다.

Source와 consumer가 같은 synchronous domain이라면 source가 full-cycle pulse 또는 ready/valid를 만들도록 하는 편이 명확하다. Analog/asynchronous source는 input conditioning과 CDC 구조가 필요하다.

## 6. Cycle Audit

다음 표는 baseline-then-arm과 one-entry pending을 함께 감사한다. 각 행의 post-state는 해당 edge의 NBA update 뒤 값이다.

| Edge | Edge 직전 조건 | `rise_event` | `pending_accept` | Post `pending_valid` | 의미 |
|---|---|---:|---:|---:|---|
| E0 | reset asserted, level high | 0 | 0 | 0 | pending clear |
| E1 | release, high, `armed_q=0` | 0 | 0 | 0 | high를 baseline으로만 capture |
| E2 | high held | 0 | 0 | 0 | duplicate 없음 |
| E3 | low | 0 | 0 | 0 | detector re-arm 조건 저장 |
| E4 | high, ready low | 1 | 0 | 1 | 새 event pending |
| E5 | high held, ready low | 0 | 0 | 1 | pending 유지 |
| E6 | low, ready low | 0 | 0 | 1 | pending을 유지하며 detector re-arm |
| E7 | high, ready high | 1 | 1 | 1 | old consume + new refill |
| E8 | high held, ready high | 0 | 1 | 0 | refilled event consume |

추가로 다음 경우를 확인한다.

- Pending 중 새 rise와 ready low: overflow indication
- Reset과 pending acceptance 동시: reset 우선, acceptance 없음
- Reset release 직전/직후 high, low, toggle
- Ready가 연속 high인 동안 held input
- Clock stop 직전, 정지 중, 재개 직후 input 변화

## 7. Clock Stop과 다른 Domain

Clock이 멈추면 delayed sample, armed state와 pending state도 갱신되지 않는다. 정지 중 발생했다가 사라지는 pulse는 clock 재개 후 검출할 수 없다. 정지 중 high가 유지되더라도 재개 시 그것을 새 사건으로 볼지 baseline으로 볼지 별도 wakeup contract가 필요하다.

다른 clock domain 또는 stopped domain의 pulse에는 다음이 충분하지 않다.

- Plain edge detector
- One-cycle pulse에 2FF synchronizer만 연결
- Pulse를 몇 gate delay로 늘리는 비동기 방식

Event rate, destination clock stop, reset relation과 loss/duplication requirement에 따라 stretch, toggle, request/acknowledge, event counter 또는 async FIFO를 선택한다. 자세한 선택 기준은 [Pulse Crossing](../08_cdc/pulse_crossing.md)을 참고한다.

## 8. Pulse를 Clock으로 쓰지 않는다

다음과 같이 functional pulse를 clock pin에 연결하지 않는다.

```systemverilog
// Bad: pulse is being used as a generated clock.
always_ff @(posedge event_pulse)
  count_q <= count_q + 1'b1;
```

이 구조는 clock definition, skew, duty cycle, glitch, test/scan과 STA 문제를 만든다. Pulse는 data/control enable로 사용하고 register는 설계 clock으로 구동한다.

```systemverilog
always_ff @(posedge clk) begin
  if (event_accept)
    count_q <= count_q + 1'b1;
end
```

실제 generated/gated clock이 필요하면 clock architecture와 전용 cell/constraint flow로 다룬다.

## 9. Synthesis, STA와 PPA 관점

Rising detector는 delayed FF와 compare/XOR-equivalent logic을, sticky pending은 state FF와 set/clear decode를 만든다. Pending bit 하나는 작지만, event마다 detector와 reset을 추가하면 clock/reset load가 늘 수 있다.

`pending_ready`가 pending next-state에 들어가며, `pending_valid`가 wide downstream control로 퍼질 수 있다. High-frequency path에서는 local buffering이나 registered ready가 필요할 수 있지만 latency와 capacity가 달라진다. Power/area는 event rate, reset policy, queue depth와 physical fanout에 따라 달라지므로 mapped 결과로 판단한다.

## 10. 적용하면 안 되는 패턴

- Held condition을 매 cycle event counter enable로 사용한다.
- One-cycle event를 backpressure 가능한 consumer에 직접 연결한다.
- Pending bit 하나로 임의 개수의 outstanding event를 보존한다고 주장한다.
- Reset 중 high였던 level의 release semantics를 정의하지 않는다.
- Async pulse에 edge detector나 plain 2FF만 붙여 no-loss를 기대한다.
- Functional pulse를 clock으로 사용한다.

## 11. Verification Strategy

### Assertions

Clocked property의 antecedent는 edge 직전 값을 sampling한다. Pending register의 NBA 결과는 다음 sample에서 `|=>`로 확인한다.

```systemverilog
default clocking cb @(posedge clk); endclocking
default disable iff (!rst_n);

ap_first_rise_sets_pending:
  assert property (rise_event && !pending_valid |=> pending_valid);

ap_pending_holds_without_accept:
  assert property (pending_valid && !pending_ready |=> pending_valid);

ap_accept_clears_without_refill:
  assert property (pending_accept && !rise_event |=> !pending_valid);

ap_accept_and_rise_refill:
  assert property (pending_accept && rise_event |=> pending_valid);

ap_held_high_does_not_repeat:
  assert property (armed_q && level_in && level_d_q |-> !rise_event);

ap_capacity_violation_is_reported:
  assert property (rise_event && pending_valid && !pending_ready |=>
                   event_overflow);
```

### Event accounting

Simulation scoreboard 또는 formal ghost counter로 다음 관계를 확인한다.

```text
captured rises = accepted events + pending occupancy
```

이 equality는 overflow가 없고 reset/flush accounting이 정의된 구간에서만 적용한다. Overflow가 허용되면 dropped/coalesced count를 식에 포함한다. Cover property로 same-edge consume/refill, held-high, minimum low re-arm과 reset-release scenario를 관찰한다.

## 12. Design Review Checklist

- [ ] Signal이 pulse, level, valid 또는 accepted event 중 무엇인지 정의했는가?
- [ ] Held-high가 한 사건인지 cycle마다 새 사건인지 명확한가?
- [ ] Edge detector가 같은 synchronous domain input만 받는가?
- [ ] 두 event 사이에 필요한 low/re-arm 조건이 보장되는가?
- [ ] Reset 중 high가 release 뒤 event를 만드는지 정책이 있는가?
- [ ] Consumer stall 중 event를 pending/queue로 보존하는가?
- [ ] One-entry pending 중 새 event의 overflow/coalescing 의미가 있는가?
- [ ] Same-edge accept와 new event를 refill로 처리하는가?
- [ ] Clock stop과 CDC에서 no-loss 조건을 별도로 검토했는가?
- [ ] Pulse를 clock이 아니라 enable/event로 사용하는가?
- [ ] No-loss/no-duplicate assertion과 event accounting이 있는가?

## 관련 문서

- [Pulse Crossing](../08_cdc/pulse_crossing.md)
- [FSM Design](fsm_design.md)
- [Priority and Simultaneous Events](priority_and_simultaneous_events.md)
- [Counter Boundary Design](counter_boundary.md)
- [Reset Deassertion and RDC](../07_reset/reset_deassertion.md)
