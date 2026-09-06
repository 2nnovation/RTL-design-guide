# Enable Everywhere

Register나 operator가 idle일 때 움직이지 않게 하는 것은 중요한 low-power 원칙이다. 그러나 모든 FF와 작은 연산기에 각각 enable을 붙이면 power가 자동으로 줄어드는 것은 아니다. Enable 생성 logic, feedback MUX 또는 CE pin, high-fanout routing, control-set fragmentation과 verification 비용이 실제 절감보다 커질 수 있다.

Functional update/hold는 [Register Enable](../04_low_power/register_enable.md), combinational activity는 [Operand Isolation](../04_low_power/operand_isolation.md), clock gating ownership은 [Inferred vs Explicit Clock Gating](../06_clock/inferred_vs_explicit.md), mapping은 [Enable and MUX Inference](../11_synthesis/enable_and_mux_inference.md)를 정본으로 삼는다. 이 문서는 **fine-grain enable의 손익과 증거**를 판정한다.

## 1. 문제: 모든 state에 작은 enable을 만든다

```systemverilog
always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
        a_q <= '0;
        b_q <= '0;
        c_q <= '0;
    end else begin
        if (mode_a && item_valid && !stall_a)
            a_q <= a_d;

        if ((mode_b || retry) && !stall_b)
            b_q <= b_d;

        if (feature_c && count_q != '0)
            c_q <= c_d;
    end
end
```

각 register는 불필요한 data update를 줄일 수 있지만, 세 개의 복합 enable decode가 생긴다. Enable이 작고 자주 active하거나 register group이 작으면 decode·routing·hold feedback 비용이 절감보다 클 수 있다. 서로 다른 enable/reset 조합이 많아지면 target에 따라 shared CE/clock-gating group이나 packing 기회도 줄 수 있다.

더 큰 문제는 “enable이 있으므로 clock power가 줄었다”고 보고하는 것이다. RTL의 `if (en)`은 data update condition이며 실제 clock edge가 FF에 도달하는지는 별도 mapping 결과다.

## 2. Hardware mapping은 target에 따라 다르다

같은 RTL도 library/device와 synthesis option에 따라 다음 후보로 구현될 수 있다.

```text
                 +---- d --------------------+
                 |                           v
en --> select -->+--> feedback q --------> [MUX] --> D(FF)

또는

d ----------------------------------------------> D(FF with CE)
en ---------------------------------------------> CE

또는 established flow가 eligible group에 대해

en --> gating logic/ICG --> clock branch --> multiple FF
```

- Feedback MUX는 D path의 area, delay와 switching을 추가할 수 있다.
- CE-capable cell/resource는 target의 control pin과 packing 규칙에 의존한다.
- Clock-gating inference는 같은 enable을 공유하는 충분한 load, 승인된 cell과 synthesis/DFT flow가 필요할 수 있다.
- `if (en)` 하나만으로 ICG insertion, glitch-free clock와 clock-tree power 감소를 보장하지 않는다.

실제 mapping은 synthesis report와 netlist pin을 확인한다.

## 3. Enable 자체의 비용

### Generation logic와 select timing

Enable이 mode decode, counter compare, valid와 stall을 연속으로 거치면 data보다 늦게 도착할 수 있다. Feedback MUX select 또는 CE setup path가 critical path가 되고, enable을 만들기 위한 state가 다시 enable되는 circular ownership도 생길 수 있다.

```text
state --> compare --> mode decode --> enable ----+
data --------------------------------------------+--> FF update control
```

### High fanout와 physical distribution

하나의 enable이 넓은 bank와 먼 region을 구동하면 buffer, route capacitance, slew/cap violation과 congestion이 생길 수 있다. Local enable을 여러 개 만들면 decoded net fanout은 줄 수 있지만 raw mode bus와 decode logic이 각 region으로 복제될 수 있다.

### Control-set fragmentation

일부 FPGA architecture에서는 clock, reset과 enable 조합이 register packing/control-set 활용에 영향을 준다. 많은 고유 enable이 logic을 분산시키거나 packing을 제한할 수 있지만 정확한 효과와 용어는 device family와 tool report를 따른다. ASIC에서도 서로 다른 enable은 ICG grouping과 multi-bit FF 사용 기회를 제한할 수 있다.

### ICG와 test overhead

Fine-grain enable을 실제 clock gating으로 바꾸면 ICG, test enable, scan controllability, gating setup/hold와 CTS branch가 추가된다. 작은 group마다 ICG를 넣으면 clock capacitance 절감보다 overhead가 클 수 있다. Raw `clk & en`으로 바꾸는 것은 허용 가능한 shortcut이 아니다.

## 4. Data hold가 upstream switching을 멈추지는 않는다

```systemverilog
always_ff @(posedge clk) begin
    if (result_en)
        result_q <= wide_function(a, b, c);
end
```

`result_en=0`이면 destination FF는 hold하지만 `a`, `b`, `c`가 변하면 `wide_function` 내부 combinational node는 계속 toggle할 수 있다. Enable의 목적이 operator power 절감이라면 operand isolation 또는 source update suppression을 검토한다.

```systemverilog
always_comb begin
    if (work_active)
        isolated_result = wide_function(a, b, c);
    else
        isolated_result = '0;
end
```

Isolation MUX와 control도 capacitance, delay와 glitch를 만든다. Operator 입력이 원래 안정적이거나 idle 비율이 작으면 오히려 불리할 수 있다. Synthesis가 constant/isolation을 operator 안으로 어떻게 mapping했는지와 activity를 확인한다.

## 5. Fine-grain과 coarse-grain 비교

| 구조 | 장점 후보 | 비용·위험 |
|---|---|---|
| Per-register enable | 정확한 update window | 많은 decode/MUX/control set, 낮은 correlation |
| Shared bank enable | decode 공유와 correlated idle | 일부 FF의 불필요 hold/update 정책 결합 |
| Operand isolation | upstream operator switching 감소 가능 | Isolation logic, input timing와 glitch |
| Function-level gating | 큰 clock load의 idle power 감소 가능 | ICG/CTS/DFT/reset/wakeup architecture |
| Always-on/no enable | 가장 단순한 control/timing | 실제 activity가 높으면 data/clock power 증가 |

Coarse-grain ownership은 같은 idle/wake/reset/test lifecycle을 가진 state를 묶는다. 단지 물리적으로 가까운 FF를 같은 enable에 넣어 functional update를 막지 않는다. Always-on controller와 function clock의 경계는 [Root Clock vs Function Clock](../06_clock/root_vs_function_clock.md)을 따른다.

## 6. Break-even을 수치 하나로 정하지 않는다

Dynamic power의 정성적 출발점은 `activity × capacitance × voltage² × frequency`다. Enable 후보의 손익에는 다음을 모두 포함한다.

- 대상 register/data cone/clock branch의 실제 capacitance
- Idle duty cycle과 enable transition frequency
- Enable decode, feedback MUX, isolation와 routing activity
- ICG/CE cell, test override와 CTS 비용
- Glitch activity, clock tree stage와 annotation coverage
- Timing repair buffer/upsizing과 placement 변화

가상의 “N개 FF 이상” 또는 “idle X% 이상”을 보편 기준으로 사용하지 않는다. 같은 workload·clock·corner·mapping/physical stage에서 baseline과 후보를 비교한다.

## 7. Better decision pattern

### Existing control을 재사용한다

새 enable state를 만들기 전에 acceptance, valid, occupancy, phase와 owner state가 이미 정확한 update window를 표현하는지 본다. 하지만 이름이 비슷하다는 이유로 재사용하지 않고 reset, simultaneous event와 cycle alignment를 확인한다.

### Priority를 명시한다

```systemverilog
always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n)
        state_q <= '0;
    else if (clear)
        state_q <= '0;
    else if (update_en)
        state_q <= state_d;
end
```

이 예는 `reset > clear > update > hold`를 정의한다. Enable이 false여도 architecturally required clear는 적용된다. Scan/test/wakeup override는 target clock-control wrapper와 methodology에서 priority를 명시하며, functional data enable RTL에 임의로 섞지 않는다.

### Correlated group만 묶는다

같은 event에서 update하고 같은 reset/flush lifecycle을 가지는 bank는 shared enable 후보다. 일부 register가 예외적으로 update해야 하면 group을 분리하거나 data MUX가 더 단순한지 비교한다.

## 8. Enable이 정당한 경우와 불리한 경우

정당한 후보:

- Payload가 긴 idle window 동안 안정되고 update event가 드물다.
- Wide counter/accumulator가 명확한 active window에서만 필요하다.
- Existing valid/accept signal이 정확한 update condition이며 추가 decode가 작다.
- 많은 correlated register가 같은 lifecycle을 공유한다.
- Mapping/power evidence에서 MUX/ICG overhead를 포함해 이득이 확인된다.

불리할 수 있는 후보:

- Register가 거의 매 cycle update되어 enable이 대부분 1이다.
- 작은 cone마다 서로 다른 복합 enable이 필요하다.
- Enable decode가 critical하거나 먼 region으로 broadcast된다.
- Upstream operator가 계속 toggle하여 destination hold 이득이 작다.
- 고유 control set 때문에 packing/gating group이 조각난다.
- Reset, clear, scan 또는 wake-up priority를 우회한다.

## 9. Verification과 evidence

### Functional equivalence model

Enable RTL의 next state는 `reset ? RESET : clear ? ZERO : en ? d : q`다. Candidate mapping이 feedback MUX, CE 또는 gated clock이더라도 functional edge에서 같은 next state를 만들어야 한다.

```systemverilog
ap_hold_when_disabled:
    assert property (@(posedge clk) disable iff (!rst_n)
        (!clear && !update_en) |=> $stable(state_q));

ap_clear_over_enable:
    assert property (@(posedge clk) disable iff (!rst_n)
        clear |=> (state_q == '0));
```

Clear와 update가 겹치는 case, enable pulse 폭, mode transition, reset release와 clock stop/wake를 검증한다. Gated implementation이면 functional equivalence 외에 gating setup/hold, test enable와 pulse-width check가 필요하다.

### Evidence set

- Synthesis: feedback MUX/CE/ICG mapping, eligible/gated bits와 group 크기
- STA: enable/clear select path, gating checks와 all mode/corner
- Physical: enable fanout, buffer, cap/slew, control-set placement와 congestion
- Power: clock/data/operator cone activity, annotation coverage와 workload
- DFT/reset: scan shift, test override, reset/wakeup sequence
- Equivalence: reset·clear·update·hold priority와 mode별 behavior

## 10. Design Review Checklist

- [ ] 각 enable이 실제 update window requirement에서 나온 것인가?
- [ ] Register enable과 실제 clock activity 감소를 구분했는가?
- [ ] Feedback MUX, CE 또는 ICG 중 실제 mapping을 확인했는가?
- [ ] Enable generation depth, arrival와 high fanout를 확인했는가?
- [ ] 고유 enable/reset 조합이 packing·control set·gating group을 조각내지 않는가?
- [ ] Destination hold 중 upstream combinational cone이 계속 toggle하지 않는가?
- [ ] Operand isolation의 logic/timing/glitch 비용을 포함했는가?
- [ ] Fine-grain과 lifecycle 기반 coarse-grain 구조를 비교했는가?
- [ ] Idle ratio, activity와 capacitance를 representative workload로 측정했는가?
- [ ] Reset·clear·scan·test·wakeup priority가 보존되는가?
- [ ] Gating inference와 ICG/CTS/DFT evidence가 있는가?
- [ ] 작은/자주 active한 cone에서 enable 제거 후보도 비교했는가?

## 관련 문서

- [Register Enable](../04_low_power/register_enable.md): update/hold semantics와 비용
- [Operand Isolation](../04_low_power/operand_isolation.md): upstream combinational activity
- [Inferred vs Explicit Clock Gating](../06_clock/inferred_vs_explicit.md): gating ownership과 granularity
- [Enable and MUX Inference](../11_synthesis/enable_and_mux_inference.md): feedback MUX/CE/ICG mapping evidence
- [Fanout and Locality](../12_physical_aware/fanout_and_locality.md): enable distribution과 physical repair
- [Raw Clock Gating](raw_clock_gating.md): 일반 logic으로 clock을 만들면 안 되는 이유

## 참고 자료

- [AMD, Creating Clock Enables](https://docs.amd.com/r/en-US/ug949-vivado-design-methodology/Creating-Clock-Enables): FPGA clock enable과 control-set trade-off에 관한 target-specific 공식 지침
- [Altera, Use Gated Clocks](https://docs.altera.com/r/docs/683082/25.1/quartus-prime-pro-edition-user-guide/use-gated-clocks?contentId=x3hh07ZotyuPlLtZYm_cmw): synchronous enable과 전용 clock-control hardware에 관한 공식 지침
- [Yosys, clockgate](https://yosyshq.readthedocs.io/projects/yosys/en/v0.52/cmd/clockgate.html): eligible FF grouping, library ICG와 minimum group size를 설명하는 공개 합성 문서
