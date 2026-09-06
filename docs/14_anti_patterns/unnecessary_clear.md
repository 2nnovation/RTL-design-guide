# Unnecessary Clear

이 문서의 `clear`는 power-on/global reset이 아니라 **정상 동작 중 state나 payload를 0으로 다시 쓰는 동기 동작**을 뜻한다. Transaction이 끝났거나 값이 invalid가 됐다는 이유만으로 wide datapath, counter와 buffer payload를 매번 0으로 clear하면 기능에는 필요 없는 data switching과 control network가 생길 수 있다.

Global reset 선택은 [Reset Everything](reset_everything.md)과 [Reset Area Cost](../05_area/reset_area_cost.md)가 담당한다. 이 문서는 [Counter Optimization](../04_low_power/counter_optimization.md), [Resetless Datapath](../07_reset/resetless_datapath.md), [Priority and Simultaneous Events](../09_control_logic/priority_and_simultaneous_events.md)을 정본으로 두고 **운용 중 clear의 관찰 가능성, priority와 비용**을 판정한다.

## 1. 문제: invalid가 되면 payload도 0으로 쓴다

```systemverilog
always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
        valid_q   <= 1'b0;
        payload_q <= '0;
    end else if (consume) begin
        valid_q   <= 1'b0;
        payload_q <= '0;
    end else if (load) begin
        valid_q   <= 1'b1;
        payload_q <= payload_i;
    end
end
```

`valid_q=0`일 때 모든 observer가 `payload_q`를 무시한다면 `consume`에서 payload를 0으로 쓸 기능적 이유가 없다. Random-looking payload→0→next payload 전이가 생기고, wide zero 선택과 clear fanout가 추가될 수 있다.

Counter에도 같은 패턴이 있다.

```systemverilog
if (window_done)
    count_q <= '0;
else if (count_event)
    count_q <= count_q + 1'b1;
```

다음 window 시작 전에 값이 반드시 초기화돼야 하는지는 맞지만, 종료 즉시 clear가 필요한지는 별개다. Start edge에서 초기화하거나 epoch/valid로 새 ownership을 표시할 수 있는지 검토한다.

## 2. Hardware view와 PPA 비용

### Data switching

Wide payload가 유효값에서 0으로 바뀌고 다음 load에서 다시 값으로 바뀌면 clear가 없을 때보다 추가 toggle이 생길 수 있다. 정확한 절감은 data statistics와 idle duration에 따라 달라지지만, “0은 전력 소모가 없다”는 가정은 틀리다. 동적 power는 전이와 capacitance에 의존한다.

### MUX/enable와 timing

```text
payload_i ----+
zero ---------+--> priority MUX --> D(FF)
hold feedback-+         ^
                    clear/load/enable
```

Clear가 `load`, `update`, `hold`와 같은 D path에 들어가면 priority MUX 또는 enable-capable cell의 control이 된다. Late high-fanout clear가 많은 FF의 setup path를 제한할 수 있고, clear 조건 decode가 downstream control과 reconverge할 수 있다.

### Fanout와 routing

하나의 phase-clear가 wide bank와 여러 block으로 퍼지면 buffer, route capacitance, congestion과 max slew/cap 문제가 생길 수 있다. Combinational clear pulse가 좁거나 glitch가 있으면 일부 synchronous destination이 서로 다른 edge에 clear할 위험도 있다.

### Memory와 packed resource inference

Register array 전체를 한 cycle에 clear하는 RTL은 target memory macro의 native operation과 맞지 않을 수 있다. Tool/device에 따라 RAM, shift-register나 packed storage inference가 깨지고 FF/MUX bank로 구현될 수 있다. 구체적 mapping은 library/device와 synthesis report에서 확인한다.

## 3. Ownership contract: data가 아니라 valid를 갱신한다

Payload를 hold할 수 있는 조건은 다음과 같다.

1. `valid=0`, occupancy=0 또는 epoch mismatch에서 값은 unowned다.
2. 모든 functional observer가 ownership metadata를 먼저 확인한다.
3. 다음 `valid=1` 전에 payload가 write된다.
4. Debug, parity/ECC, compare, CDC와 assertion 같은 hidden observer도 포함한다.
5. Reset/flush/mode transition이 stale metadata를 다시 valid로 만들지 않는다.

권장 fragment는 payload를 consume할 때 그대로 두고 valid만 내린다.

```systemverilog
always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
        valid_q <= 1'b0;
    end else if (consume) begin
        valid_q <= 1'b0;
    end else if (load) begin
        valid_q   <= 1'b1;
        payload_q <= payload_i;
    end
end
```

이 예의 priority는 `reset > consume > load > hold`다. `consume && load`에서 old entry를 소비하고 new entry로 refill해야 하는 interface라면 위 코드는 event를 잃는다. 그 경우 merge/refill semantics를 명시적으로 구현한다.

```systemverilog
always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
        valid_q <= 1'b0;
    end else begin
        unique case ({consume, load})
            2'b00: ;
            2'b01: begin
                valid_q   <= 1'b1;
                payload_q <= payload_i;
            end
            2'b10: valid_q <= 1'b0;
            2'b11: begin
                valid_q   <= 1'b1;
                payload_q <= payload_i;
            end
        endcase
    end
end
```

동시 `consume+load`는 occupancy를 유지하며 새 payload를 capture한다. `unique`가 case coverage를 증명하는 것은 아니므로 truth table과 regression으로 확인한다.

## 4. Clear pulse와 event loss

Clear가 pulse인지 level인지, 어느 edge에서 적용되는지 정의한다.

- Clear pulse가 destination clock보다 짧거나 다른 domain에서 오면 놓칠 수 있다.
- Clear level이 여러 cycle 유지되면 load/update를 계속 override할 수 있다.
- Back-to-back window에서 end-clear와 next-start load가 겹치면 새 data를 지울 수 있다.
- 여러 register가 서로 다른 enable을 가지면 일부만 clear되어 state ownership이 갈라질 수 있다.
- Clear를 clock gating과 결합하면 gated clock이 꺼진 동안 synchronous clear가 적용되지 않는다.

Cross-domain clear는 일반 data control이 아니라 CDC/RDC와 reset architecture의 책임으로 분류한다. Raw clock/reset pin에 일반 decode clear를 직접 연결하지 않는다.

## 5. Remove → Disable → Simplify와 대안

### Remove

먼저 clear 후 값이 어떤 observer에도 필요하지 않은지 증명한다. Clear logic과 zero assignment 자체를 제거하고 ownership metadata만 갱신한다.

### Disable

Payload update는 실제 load에서만 수행해 invalid/idle 구간 switching을 막는다. Destination FF hold만으로 upstream combinational cone이 멈추지는 않으므로 expensive producer activity는 [Operand Isolation](../04_low_power/operand_isolation.md)과 함께 본다.

### Simplify

- Wide bank마다 clear를 broadcast하는 대신 valid/occupancy bit를 clear한다.
- Counter는 실제 measurement start에서만 0으로 initialize한다.
- Buffer는 write-before-read를 보장하고 per-entry valid를 관리한다.
- Large memory는 epoch/tag로 logical invalidation하는 lazy initialization을 검토한다.

Epoch 방식은 wrap 시 stale entry가 다시 current로 보이지 않도록 width, full sweep 또는 generation rollover policy가 필요하다. Metadata를 줄였지만 hidden observer와 safety requirement가 늘면 적합하지 않다.

## 6. X를 숨기기 위한 clear가 되면 안 된다

Simulation에서 stale payload가 `X`로 보인다는 이유로 매 transaction 뒤 0을 쓰면 unguarded observer bug를 가릴 수 있다. 올바른 질문은 다음과 같다.

- `valid=0`인데 누가 payload를 읽는가?
- Assertion, coverage 또는 testbench가 ownership contract를 지키는가?
- 2-state formal/equivalence가 unknown initial state를 0으로 가정하지 않는가?
- Clear 제거 전후 X semantics와 initial-state relation이 같은가?

X는 analog hardware 값 자체가 아니라 simulation abstraction이지만, missing initialization과 invalid-use를 찾는 데 유용하다. Waveform을 깨끗하게 만드는 것과 기능 correctness를 구분한다.

## 7. Clear가 실제로 필요한 예외

다음에는 정상 동작 중 명시적 clear가 요구될 수 있다.

- Software/interface가 idle일 때 architecturally visible zero를 요구한다.
- Accumulator의 새 measurement window가 0에서 시작해야 하며 start edge priority가 정의된다.
- Safety state 또는 error latch가 승인된 recovery sequence에서 clear돼야 한다.
- Test/BIST protocol이 deterministic background value를 요구한다.
- Security requirement가 특정 state의 zeroization을 요구한다.
- Memory protocol이나 external interface가 zero-filled response를 실제로 관찰한다.

Zeroization은 단순 RTL zero assignment만으로 충분하다고 단정하지 않는다. Synthesis optimization, storage mapping, retention, debug/test copy와 physical remanence 범위는 해당 security methodology에서 별도로 검증한다.

예외마다 clear event, priority, 완료 시점, observer와 proof owner를 기록한다.

## 8. Verification과 evidence

### Observer audit와 properties

```systemverilog
ap_no_use_when_invalid:
    assert property (@(posedge clk) disable iff (!rst_n)
        consume |-> valid_q);

ap_payload_changes_only_on_load:
    assert property (@(posedge clk) disable iff (!rst_n)
        $changed(payload_q) |-> $past(load));

ap_refill_keeps_valid:
    assert property (@(posedge clk) disable iff (!rst_n)
        (consume && load) |=> valid_q);
```

`$past`의 initial history와 NBA sampling은 project convention에 맞게 guard한다. `consume`가 실제 observer를 모두 대표하는지 fanout cone과 interface audit로 확인한다.

### Independent priority matrix

| Reset | Consume | Load | Next valid | Payload action |
|---:|---:|---:|---:|---|
| 1 | X | X | 0 | hold/don't-care |
| 0 | 0 | 0 | hold | hold |
| 0 | 0 | 1 | 1 | load new |
| 0 | 1 | 0 | 0 | hold stale, unowned |
| 0 | 1 | 1 | 1 | consume old + refill new |

### Implementation evidence

- Lint/formal: unguarded observer, clear/load priority와 unreachable/X assumption
- Equivalence: valid transaction 기준 output과 initial-state model
- Synthesis: zero MUX, clear/enable mapping, sequential bit와 memory inference
- STA/physical: clear fanout, decode arrival, cap/slew와 route congestion
- Power: clear 전이와 next load를 포함한 representative activity
- Reset/mode regression: back-to-back window, gated clock과 stale epoch

## 9. Design Review Checklist

- [ ] 이 clear가 global reset이 아니라 정상 동작 event임을 구분했는가?
- [ ] Clear 뒤 payload/counter가 실제 observer에게 보이는가?
- [ ] Valid/occupancy/epoch만 갱신하고 payload를 hold할 수 있는가?
- [ ] 다음 valid 전에 write-before-read가 보장되는가?
- [ ] Debug, parity/ECC, CDC, assertion과 test path를 observer로 포함했는가?
- [ ] Clear/load/update 동시 발생의 merge/drop priority가 정의됐는가?
- [ ] Clear pulse width, level 지속과 back-to-back window를 검증했는가?
- [ ] Wide zero MUX, fanout, switching과 memory inference를 확인했는가?
- [ ] Lazy initialization의 epoch wrap과 stale-entry policy가 있는가?
- [ ] Simulation X를 숨기기 위한 clear가 아닌가?
- [ ] Visible zero, accumulator, safety/test/zeroization 예외의 근거가 있는가?
- [ ] Equivalence, STA, power와 mapped storage evidence가 있는가?

## 관련 문서

- [Counter Optimization](../04_low_power/counter_optimization.md): measurement window와 clear priority
- [Resetless Datapath](../07_reset/resetless_datapath.md): valid-guarded stale/X contract
- [Reset Area Cost](../05_area/reset_area_cost.md): reset과 storage mapping 비용
- [Priority and Simultaneous Events](../09_control_logic/priority_and_simultaneous_events.md): clear/load/refill collision
- [Operand Isolation](../04_low_power/operand_isolation.md): upstream combinational switching
- [Reset Everything](reset_everything.md): power-on/global reset anti-pattern

## 참고 자료

- [AMD, When and Where to Use a Reset](https://docs.amd.com/r/2024.2-English/ug949-vivado-design-methodology/When-and-Where-to-Use-a-Reset?contentId=SpOcbybsGLfLD7LRe~RsJg): control과 datapath 초기화를 구분하는 target-specific 공식 지침
- [AMD, Vivado Design Suite User Guide: Synthesis (UG901)](https://docs.amd.com/r/en-US/ug901-vivado-synthesis): sequential control과 RAM HDL coding/mapping에 관한 공식 가이드
- [Yosys, Memory handling](https://yosyshq.readthedocs.io/projects/yosys/en/latest/using_yosys/synthesis/memory.html): memory inference와 transformation을 설명하는 공개 합성 문서
