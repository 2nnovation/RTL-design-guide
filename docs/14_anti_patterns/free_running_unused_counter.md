# Free-Running Unused Counter

Counter는 작고 익숙한 RTL이지만 매 cycle increment하면 여러 bit의 FF, adder carry chain과 downstream compare/decode가 반복해서 움직인다. 값이 관찰되지 않는 구간에도 계속 세는 counter는 기능적으로 무해해 보이면서 power와 timing 여유를 소비하는 전형적인 anti-pattern이다.

이 문서는 [Counter Optimization](../04_low_power/counter_optimization.md)의 전체 기법을 반복하지 않는다. Review 시 **live value window를 찾아 제거(Remove) 또는 비활성화(Disable)할 수 있는지**, 그리고 변경 후 event priority가 보존되는지를 판단한다.

## 1. 문제: 필요하지 않은 구간에도 계속 증가

다음 예에서는 phase A와 B의 값이 사용되지 않고, B에서 clear한 뒤 phase C에서 발생한 event 수만 결과로 사용한다고 가정한다.

```systemverilog
always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n)
        count_q <= '0;
    else if (phase_b)
        count_q <= '0;
    else
        count_q <= count_q + 1'b1;
end
```

이 코드는 A에서도 증가하고 C에서도 event 유무와 상관없이 증가한다. B가 오면 이전 값은 지워지므로 A 구간의 switching은 functional result에 기여하지 않는다. C의 요구가 “cycle 수”가 아니라 “event 수”라면 C의 무조건 increment도 잘못된 기능이다.

핵심은 counter 선언이나 이름이 아니라 **값이 살아 있는 시간(live value window)**이다.

```text
phase             A                 B                  C
                  |-----------------|------------------|-------->
required value    don't-care        clear to zero      count events
bad counter       increments        clear              increments every cycle
better counter    hold/remove       clear              increment on event only
```

## 2. 먼저 관찰 가능성을 확인한다

Counter를 멈추기 전에 모든 observer를 찾는다.

- Output, interrupt, timeout와 protocol response
- Equality/range compare, FSM transition과 address/index 생성
- Debug/status register, trace, performance monitor와 scan observation
- Assertion, coverage와 safety monitor
- 다른 clock/reset/power domain으로 건너가는 값

A–B 구간의 값이 어떤 observer에도 영향을 주지 않고 B가 C보다 먼저 반드시 clear한다면 A의 update는 제거할 수 있다. Counter 자체와 C 결과도 관찰되지 않는다면 enable을 추가하는 대신 counter 전체를 **Remove**하는 것이 우선이다. 값은 필요하지만 일부 구간에서만 변해야 한다면 **Disable**한다.

이 판단은 [Unused Logic and State Reduction](../05_area/unused_logic_and_state_reduction.md)의 observer/authoritative-state 분석과 연결된다.

## 3. Hardware failure와 PPA 메커니즘

### 3.1 Counter 자체의 switching

Binary up-counter가 매 cycle 증가하면 LSB는 매 cycle, 다음 bit는 더 낮은 빈도로 toggle한다. 정확한 activity는 reset, enable, terminal policy와 workload에 따라 달라지지만, free-running LSB와 carry propagation은 불필요한 dynamic activity의 분명한 출발점이다.

### 3.2 Downstream logic까지 움직인다

Counter output이 comparator, decode, address logic이나 large MUX select에 연결되면 count bit 변화가 그 logic cone으로 전파된다. 최종 `valid`가 0이라도 combinational input이 계속 바뀌면 내부 node는 toggle할 수 있다. Destination register enable만으로 upstream switching이 자동으로 멈추는 것은 아니다.

### 3.3 Timing과 area의 숨은 비용

- Wide incrementer의 carry 또는 terminal compare가 critical path에 들어갈 수 있다.
- Count enable은 feedback MUX, register CE 또는 gating 후보로 mapping될 수 있다.
- 새 enable decode의 logic depth와 fanout이 기존 data path보다 비쌀 수 있다.
- 작은 counter 하나를 위한 독립 ICG는 cell, test override, clock routing 비용이 절감보다 클 수 있다.
- 여러 register가 enable을 공유하면 power 기회가 커질 수 있지만 high-fanout control과 congestion도 함께 검토해야 한다.

그러므로 “enable을 넣었으니 clock power도 줄었다”고 말할 수 없다. Data enable은 state update를 막지만 clock pin은 계속 toggle할 수 있다. 실제 ICG inference와 clock-tree activity는 synthesis/power report에서 따로 확인한다.

## 4. 잘못된 수정: 기능 priority를 바꾸기

무조건 increment를 `if (count_en)`으로 감싸는 것만으로는 충분하지 않다. Clear와 event가 같은 cycle에 오면 어떤 동작이 이겨야 하는지 정해야 한다.

예를 들어 요구가 다음이라면:

- Reset이 가장 높은 priority다.
- Phase B에서는 과거 값을 clear한다.
- Phase C에서만 `count_event`를 센다.
- B와 C 조건이 겹치는 비정상 또는 전환 cycle에는 B의 clear가 이긴다.
- 그 밖의 cycle에는 hold한다.

RTL도 같은 순서를 직접 표현해야 한다.

| Condition at edge | Next value | 이유 |
|---|---:|---|
| `!rst_n` | `0` | reset |
| `phase_b` | `0` | 새 측정 window 준비 |
| `phase_c && count_event` | `count_q + 1` | live window의 event |
| otherwise | `count_q` | 값 보존 |

## 5. 권장 RTL: live window에서만 update

다음 예는 위 priority를 구현하며 modulo wrap을 의도적으로 허용한다. Overflow가 허용되지 않는다면 [Counter Boundary Design](../09_control_logic/counter_boundary.md)에 따라 saturate, block 또는 error 정책으로 바꿔야 한다.

```systemverilog
module window_event_counter #(
    parameter int unsigned COUNT_W = 8
) (
    input  logic               clk,
    input  logic               rst_n,
    input  logic               phase_b,
    input  logic               phase_c,
    input  logic               count_event,
    output logic [COUNT_W-1:0] count_q
);

    initial begin
        if (COUNT_W < 1)
            $fatal(1, "COUNT_W must be at least 1");
    end

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n)
            count_q <= '0;
        else if (phase_b)
            count_q <= '0;
        else if (phase_c && count_event)
            count_q <= count_q + COUNT_W'(1);
    end

endmodule
```

Sequential block에 마지막 `else`가 없으므로 register는 명시된 update가 없을 때 hold한다. 이 예의 priority는 `reset > phase B clear > phase C event > hold`다. `phase_b`와 `phase_c`가 원래 mutually exclusive라면 assertion으로 그 contract를 검증하되, RTL의 collision behavior도 정의해 둔다.

Phase B가 여러 cycle 유지되면 매 edge에 0을 다시 쓰지만 첫 clear 이후 data bit switching은 없다. B 진입 시 한 번만 clear해야 한다면 `enter_b` event를 사용할 수 있으나 edge detector/state가 새로 필요하므로 기능과 비용을 함께 비교한다.

## 6. Remove → Disable 판단 순서

### Remove

다음 질문에 모두 “아니오”라면 counter 자체를 제거할 후보가 된다.

- Functional output이나 state transition이 count에 의존하는가?
- Debug/test/safety architecture가 값을 관찰하는가?
- 미래 기능이 아니라 현재 specification에 count가 필요한가?
- Synthesis가 제거하지 못하도록 유지해야 하는 명시적 interface contract가 있는가?

### Disable

Counter가 C 구간에 필요하다면 기존 phase/event signal로 update를 제한한다. 새 `count_active_q`를 만들기 전에 기존 control을 재사용할 수 있는지 본다. 새 state가 필요하면 그 FF의 reset, priority, clock power와 verification cost도 포함한다.

### Simplify

Update를 제한한 뒤에도 다음을 확인한다.

- Maximum event 수에 맞는 최소 width인가?
- Terminal compare가 실제 필요한가?
- Every-cycle count 대신 sparse event accumulator나 timestamp 차이가 더 자연스러운가?
- Downstream decode도 invalid 구간에 isolation할 가치가 있는가?

Width 문제는 [Bit-Width Minimization](../05_area/bit_width_minimization.md), operand activity는 [Operand Isolation](../04_low_power/operand_isolation.md)을 정본으로 삼는다.

## 7. 유효한 예외

Free-running이 곧 잘못은 아니다. 다음 state는 연속성이 기능의 일부일 수 있다.

- 여러 consumer가 공유하는 monotonic timestamp/timebase
- Wall-clock cycle 기준 timeout 또는 watchdog
- 항상 실행되는 performance/time accounting
- Protocol이나 safety requirement가 모든 cycle 경과를 관찰하는 age counter
- Gray counter 등 별도 CDC contract를 가진 continuously sampled time source

예외에서는 “현재 consumer가 안 읽는다”만으로 멈추면 안 된다. Wrap 주기, sleep/clock-stop 동안 시간 의미, reset epoch, CDC sampling과 최대 관찰 간격을 specification으로 남긴다. Counter를 공유 timebase로 유지하고 consumer가 start/end timestamp 차이를 계산하는 편이 여러 local counter보다 나을 수도 있지만, subtraction width와 wrap ambiguity를 검증해야 한다.

## 8. Verification과 evidence

### Assertion 후보

```systemverilog
// B가 아닌 A 구간에서는 값이 유지된다.
ap_hold_outside_live_window:
    assert property (@(posedge clk) disable iff (!rst_n)
        (!phase_b && !phase_c) |=> $stable(count_q));

// B의 clear가 C event보다 우선한다.
ap_clear_priority:
    assert property (@(posedge clk) disable iff (!rst_n)
        phase_b |=> (count_q == '0));
```

`|=>`와 `$stable`의 sampling은 현재 edge의 condition과 다음 sampled value를 비교한다. Project assertion convention에 맞게 reset abort와 initial history를 검토한다. Assertion semantics는 [Assertion-Driven RTL](../13_verification/assertion_driven_rtl.md)을 참고한다.

### Corner-case matrix

- Reset과 B clear 동시 발생
- B clear와 C event 동시 발생
- C 진입 첫 cycle과 이탈 마지막 cycle의 event
- Back-to-back B, zero-length C와 maximum-length C
- No event, every-cycle event와 overflow boundary
- Invalid 구간에서 downstream observer가 count를 사용하려는 negative case

### Implementation evidence

- RTL/elaboration lint: width, incomplete combinational assignment가 아닌 sequential hold인지 확인
- Synthesis: counter FF, adder/comparator width와 enable/feedback-MUX mapping
- STA: enable/clear decode와 increment/terminal path
- Power: representative phase duty cycle 및 event density를 사용한 count cone activity
- Post-route: enable fanout, routing과 clock-gating group이 있다면 실제 clock load

Before/after 비교에서는 workload, activity coverage, clock/reset assumptions, tool/library와 physical stage를 같게 유지한다. 자세한 report 읽기는 [Reading Synthesis Reports](../11_synthesis/read_synthesis_reports.md)와 [RTL to Post-Route Feedback](../12_physical_aware/rtl_to_post_route_feedback.md)을 참고한다.

## 9. Design Review Checklist

- [ ] Counter 값의 live value window가 cycle 단위로 정의됐는가?
- [ ] Window 밖의 모든 observer와 debug/test 경로를 확인했는가?
- [ ] Counter 전체를 Remove할 수 있는지 enable 추가보다 먼저 검토했는가?
- [ ] A에서는 hold, B에서는 clear, C에서는 필요한 event만 count하는가?
- [ ] Reset·clear·event 동시 발생 priority가 specification과 일치하는가?
- [ ] Wrap, saturate, block 또는 error policy가 명시됐는가?
- [ ] Width가 maximum event count와 parameter corner에 맞는가?
- [ ] Data enable과 실제 clock gating을 구분했는가?
- [ ] Enable generation/MUX/fanout/ICG 비용을 절감에 포함했는가?
- [ ] Counter뿐 아니라 downstream compare/decode activity도 측정했는가?
- [ ] Timestamp/timebase/watchdog 예외의 연속성과 wrap contract가 문서화됐는가?
- [ ] Synthesis·STA·power·post-route evidence가 같은 workload와 configuration인가?

## 관련 문서

- [Counter Optimization](../04_low_power/counter_optimization.md): count window, enable와 clock-gating trade-off
- [Register Enable](../04_low_power/register_enable.md): update/hold와 mapping
- [Unused Logic and State Reduction](../05_area/unused_logic_and_state_reduction.md): observer와 제거 증명
- [Counter Boundary Design](../09_control_logic/counter_boundary.md): terminal, wrap/saturate/block 정책
- [Bit-Width Minimization](../05_area/bit_width_minimization.md): range 기반 width 결정
- [Enable and MUX Inference](../11_synthesis/enable_and_mux_inference.md): CE, feedback MUX와 report 증거
- [Corner-Case Matrix](../13_verification/corner_case_matrix.md): simultaneous event 검증

## 참고 자료

- [AMD, Creating Clock Enables](https://docs.amd.com/r/en-US/ug949-vivado-design-methodology/Creating-Clock-Enables): FPGA clock-enable coding과 control-set 영향에 관한 target-specific 지침
