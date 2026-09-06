# Enable and MUX Inference

`if (en) q <= d;`는 clock edge에서 새 값을 받을지 기존 값을 유지할지 정한다. 이 intent가 feedback MUX로 남았는지, enable-capable cell에 흡수됐는지, 별도 clock-gating transformation을 거쳤는지는 합성 결과를 읽어야 알 수 있다.

Update/switching window의 기능적 판단은 [Register Enable](../04_low_power/register_enable.md)과 [Operand Isolation](../04_low_power/operand_isolation.md)이 담당한다. 이 문서는 그 window가 어떤 cell/control로 mapping됐는지 확인하는 데 집중한다. Inferred/explicit ICG의 ownership와 안전성은 [Inferred vs Explicit Clock Gating](../06_clock/inferred_vs_explicit.md), [Clock Gating](../06_clock/clock_gating.md)을 따른다.

## 1. Hold Semantics와 구현 후보를 분리한다

```text
Logical next state: q_next = en ? d : q

Feedback MUX candidate                 Enable-cell candidate

d --------+                            d --------> D [FF with CE] --> q
          MUX --> D [FF] --> q          en -------> CE
q --------+          ^                 clk ------> CK
feedback  ^          |
          en         clk
```

둘 다 active edge에서 enable이 false이면 state를 보존할 수 있다. 왼쪽의 MUX는 D path에 추가될 수 있고, 오른쪽은 cell 내부 control/timing arc로 표현된다. Enable cell이라는 이름만으로 clock pin activity나 내부 power 특성을 단정하지 않는다. 지원 polarity, reset priority와 characterized timing/power를 확인한다.

| 구현 | Mapping의 전제 | 확인할 증거 | 자동으로 해결되지 않는 것 |
|---|---|---|---|
| Feedback MUX+FF | 일반 FF와 combinational selection 구현 가능 | Q→MUX feedback, D/select path | Upstream switching, FF clock activity |
| Enable-capable FF | Cell의 edge/control/reset behavior가 RTL과 호환 | Enable pin과 truth table, timing arcs | Upstream 계산, 전체 clock tree power |
| ICG+FF transformation | Flow 지원, eligible group, approved ICG와 검증 | ICG, clock connectivity, gated bits, residual MUX | Reset/test/wake, gating check와 physical closure |

같은 RTL이 다른 library나 constraint에서 다른 후보를 선택할 수 있다. “Enable이 inference됐다”와 “ICG가 삽입됐다”는 별도 주장이다.

## 2. `q <= q`는 Sequential Hold다

다음 두 fragment는 같은 clocked state-update intent를 표현한다. `q`, `d`, `en`은 같은 synchronous domain의 signal이라고 가정한다.

```systemverilog
always_ff @(posedge clk) begin
  if (en)
    q <= d;
end
```

```systemverilog
always_ff @(posedge clk) begin
  if (en)
    q <= d;
  else
    q <= q;
end
```

두 번째의 self-assignment는 값을 다시 계산하는 별도 arithmetic operation이 아니다. Hold intent를 명시한 것이다. 실제 enable/feedback 구조는 둘 다 필요할 수 있으며, coding style 차이가 cell count 차이를 보장하지 않는다.

그러나 이 설명을 arbitrary combinational self-assignment에 적용하면 안 된다. `always_comb`에서 `y = y`로 누락된 default를 채우거나 `assign y = select ? d : y`로 state를 흉내 내면, 이전 값 의존성 때문에 combinational loop, latch 또는 diagnostic의 대상이 될 수 있다. Combinational next-state에서 `q_next = q`를 default로 쓰는 것은 **별도 register output q를 읽는 것**이므로 `q_next = q_next`와 다르다. 자세한 경계는 [Combinational vs Sequential Logic](../01_fundamentals/combinational_vs_sequential.md)을 참고한다.

## 3. Reset > Clear > Enable > Hold

다음은 `W >= 1`인 synchronous-reset bank다. 모든 control과 data는 `clk`에 대해 setup/hold를 만족하며, reset을 최소 한 active edge에 걸쳐 제공한 뒤 동작한다. 별도 valid protocol은 없고 q 자체가 bank state다.

```systemverilog
module controlled_bank #(
  parameter int unsigned W = 8
) (
  input  logic         clk,
  input  logic         rst,
  input  logic         clear,
  input  logic         en,
  input  logic [W-1:0] d,
  output logic [W-1:0] q
);
  // Synchronous event priority: reset > clear > enable > hold.
  always_ff @(posedge clk) begin
    if (rst)
      q <= '0;
    else if (clear)
      q <= '0;
    else if (en)
      q <= d;
  end
endmodule
```

Reset과 clear가 같은 값을 쓰더라도 의미와 owner는 다를 수 있다. Tool은 compatible한 control을 논리적으로 결합할 수 있지만, test/reset protocol까지 하나로 합쳐도 된다는 뜻은 아니다.

| rst | clear | en | 해당 edge NBA의 q | Mapping이 보존해야 할 의미 |
|---:|---:|---:|---|---|
| 1 | 0 또는 1 | 0 또는 1 | 0 | Enable과 무관한 synchronous reset |
| 0 | 1 | 0 | 0 | Disabled bank도 clear됨 |
| 0 | 1 | 1 | 0 | Clear가 data capture보다 우선 |
| 0 | 0 | 1 | d | Enabled data capture |
| 0 | 0 | 0 | 이전 q | Hold |

표의 `0 또는 1`은 known binary control의 조합을 묶은 표현이며 simulation X를 don't-care로 허용한다는 뜻이 아니다. Priority semantics 자체는 [Priority and MUX](../01_fundamentals/priority_and_mux.md)가 정본이다.

### Cycle audit

| Edge | rst / clear / en | Edge 직전 q를 읽는 consumer | NBA 이후 q |
|---|---|---|---|
| E0 | 1 / 0 / 0 | Reset 전 값 사용 금지 | 0 |
| E1 | 0 / 0 / 1, d=A | 0 | A |
| E2 | 0 / 1 / 0 | A | 0 |
| E3 | 0 / 1 / 1, d=B | 0 | 0, B는 저장되지 않음 |
| E4 | 0 / 0 / 0 | 0 | 0 유지 |
| E5 | 0 / 0 / 1, d=C | 0 | C |
| E6 | 0 / 0 / 0 | C | C 유지 |

E1에서 d=A를 capture한 bank 값은 E1 NBA 이후 바뀌고, 같은 clock의 downstream FF는 E2에서 A를 볼 수 있다. E2 clear는 이 관찰을 소급 취소하지 않는다. Downstream도 clear cycle의 사용을 막아야 한다면 별도 qualification이 필요하다.

## 4. Priority가 MUX와 Enable에 어떻게 나타나는가

위 bank의 logical next-state는 다음과 같다.

```text
q_next = rst ? 0 : (clear ? 0 : (en ? d : q))

                 d -----+
                        MUX(en) ----+
                 q -----+           MUX(clear) ----+
                               0 ---+             MUX(rst) ---> D [FF]
                                             0 ---+
```

실제 mapping은 이 세 MUX를 그대로 만들 필요가 없다. Zero selection을 AND gate로 흡수하거나 compatible control을 합칠 수 있고, library의 synchronous control/enable cell을 사용할 수도 있다.

중요한 counterexample은 reset이 inactive일 때 다음 조건을 만드는 잘못된 rewrite다.

```text
wrong next state = en ? (clear ? 0 : d) : q
```

`clear=1, en=0`에서 원래 설계는 clear하지만 rewrite는 hold한다. MUX 하나를 줄인 것처럼 보여도 기능이 다르다. Cell에 synchronous reset과 enable이 모두 있다면 **reset이 enable 밖에서 효력을 갖는지** truth table과 mapped connection으로 확인한다. Cell 이름이나 핀 이름만으로 priority를 추정하지 않는다.

비동기 reset을 사용한 bank라면 reset assertion은 clock edge 없이 state에 영향을 준다. 이를 D-path MUX만으로 바꾸면 같은 계약이 아니다. Reset style 변경은 [Synchronous vs Asynchronous Reset](../07_reset/sync_vs_async_reset.md)의 별도 판단이다.

## 5. Clock이 필요한 조건은 단순 `en`보다 넓을 수 있다

위 synchronous bank에서 `en=0`일 때 clock을 모두 막으면 E0 reset과 E2 clear가 실행되지 않는다. 정상 mode에서 적어도 reset, clear, data update를 수행할 edge가 필요하다. 이를 review용으로 쓰면 다음과 같다.

```text
Required clock-active reasons (conceptual, not clock RTL):
  synchronous reset OR clear OR data update
  + approved scan/test requirements
  + reset-release / wake-up sequencing requirements
```

이 목록은 clock을 Boolean AND/OR로 만들라는 코드가 아니다. Approved ICG의 safe-phase control과 test override를 통해 그 edge를 전달해야 하고, functional data selection도 원래 priority를 유지해야 한다. 넓은 clock-active condition으로 gate를 열었을 때 다른 register가 원치 않는 update를 하지 않도록 residual enable/MUX가 필요할 수 있다.

비동기 reset assertion 자체는 clock을 요구하지 않을 수 있지만, 안전한 release와 reset 완료를 확인하는 controller에는 clock이 필요할 수 있다. Scan shift, at-speed capture, test override와 wake-up source도 functional `en`만으로 설명되지 않는다. [Reset with Clock Gating](../07_reset/reset_with_clock_gating.md), [Root Clock vs Function Clock](../06_clock/root_vs_function_clock.md)에서 sequencing을 확인한다.

같은 domain의 synchronous data-enable condition을 조합하는 것과 그 condition을 raw clock AND에 넣는 것은 다르다. 후자는 glitch와 pulse-width 문제를 만들 수 있다. 이 차이의 정본은 [Clock Gating](../06_clock/clock_gating.md)이며, 이 문서에서는 raw clock RTL을 구현 후보로 제시하지 않는다.

## 6. Grouping: 같은 Signal 이름보다 같은 계약

| Compatibility 항목 | 확인할 질문 |
|---|---|
| Clock / active edge | 같은 clock relationship과 edge인가? 서로 다른 domain을 합치지 않았는가? |
| Enable / priority | 같은 cycle에 update/hold하며 clear/load priority가 호환되는가? |
| Reset | Sync/async, polarity, reset value, release sequence와 reset domain이 맞는가? |
| Mode / test | Functional, scan, debug, capture mode의 필요한 edge가 보존되는가? |
| Physical region | Eligible bank가 실제로 가까이 있고 local clock load를 묶을 수 있는가? |
| Timing | 공통 enable이 gate control window 안에 도착하는가? |

Reset value나 일부 enable이 다르다고 모든 grouping이 원천 불가능한 것은 아니다. Flow가 더 넓은 active condition과 남겨 둔 per-register control로 동작을 보존할 수 있다. 다만 eligible group 크기와 실제 clock 절감은 source에서 같은 block에 적힌 bit 수보다 작을 수 있다.

예를 들어 data FF는 valid에서만 update해도, valid FF는 bubble에서 0으로 내려가야 한다. 둘을 단순히 valid로만 gating하면 valid=1이 남을 수 있다. Group report에서 포함된 bits, 빠진 bits, enable expression과 exclusion reason을 개별적으로 확인한다.

## 7. Bank Width와 ICG Overhead

넓은 bank는 ICG와 enable generation 비용을 더 많은 FF에 분담할 여지가 있다. 그러나 bank width만으로 universal threshold를 정할 수 없다.

- 얼마나 자주, 얼마나 오래 idle인가?
- 같은 bank의 idle interval이 서로 겹치는가?
- Gate 앞쪽 clock tree는 계속 움직이는가?
- ICG, control buffer와 local clock wiring은 얼마나 늘어나는가?
- Bank가 흩어져 gated clock route가 길어지는가?
- 원래 cell에 CE가 있는지, 변환 후 FF·MUX area가 어떻게 바뀌는가?

작은 bank나 거의 항상 active인 bank에서는 gating overhead가 이득보다 클 수 있다. 같은 수의 gated FF라도 workload와 physical load가 다르면 power 결과가 다르다. 절감 근거는 representative activity를 사용한 전후 power 분석이어야 한다.

!!! note "확인한 tool-specific 사례"
    Yosys 0.52의 공식 [`clockgate` 문서](https://yosyshq.readthedocs.io/projects/yosys/en/v0.52/cmd/clockgate.html)는 같은 clock/enable을 공유하는 eligible FF group의 변환, library 기반 ICG 선택과 최소 group 크기 조건을 설명한다. 이는 grouping이 별도 flow 결정이라는 사례다. 특정 bank의 eligibility, DFT 완성도나 power 절감량을 보장하지 않으며 여기서 해당 pass를 실행한 것은 아니다.

## 8. D Enable이 멈추지 않는 Activity

```text
changing inputs --> combinational cone --> D selection --> FF --> q
                         toggles              may toggle   |
clk ------------------------------------------------------ CK toggles
en=0 ----------------------------------------------------> q holds
```

Feedback MUX가 q를 선택해도 그 앞의 adder, comparator, shifter가 입력 변화를 받으면 switching할 수 있다. FF의 Q transition 감소, FF internal data power, clock-pin activity와 upstream power를 같은 metric으로 합치지 않는다. Enable cell의 내부 clock 동작도 characterization과 실제 mapping에 의존한다.

Combinational switching window를 줄일 필요가 있다면 [Operand Isolation](../04_low_power/operand_isolation.md)을 검토한다. 그 결과에도 isolation MUX의 delay, control fanout와 glitch 비용을 포함해야 한다.

## 9. Timing과 Physical Evidence

Enable을 추가한 뒤 data-to-D path만 보는 것은 불충분하다.

| Path / check | 새로 볼 위험 | 필요한 확인 |
|---|---|---|
| Data→MUX→D | MUX가 data setup margin 소모 | Critical data path와 cell/net delay |
| State/decode→enable | Late control과 높은 load | Select 또는 CE pin setup/hold |
| Q→feedback→D | 짧은 feedback 경로 | Minimum-delay/hold와 clock skew |
| Control→ICG enable | Safe control window 위반 | Clock-gating setup/hold, pulse width |
| Clock→ICG→bank | Insertion delay와 local skew | Clock propagation, clock-tree load와 mode |
| Clear/reset/test→bank | 넓은 control routing | Max capacitance/slew, reset/test timing |

Late enable이 critical하면 data를 더 빠르게 계산해도 해결되지 않는다. Decode 단순화, consumer 분리와 local control을 검토하되 register를 추가하면 cycle contract가 달라질 수 있다. [Fanout and Locality](../12_physical_aware/fanout_and_locality.md)를 함께 본다.

ASIC에서는 사용 가능한 standard cell과 ICG methodology가 중요하다. FPGA에서는 device에 따라 FF의 CE나 dedicated clock-control resource가 mapping 후보가 될 수 있다. CE 사용이 global clock network 정지를 뜻하지 않으며, ASIC ICG 방식을 LUT 기반 clock logic으로 옮기는 것은 일반적인 대안이 아니다. 실제 device의 공식 inference/clock-resource 지침과 구현 결과를 확인한다.

## 10. Report와 Netlist를 함께 읽는 순서

1. Elaboration에서 의도한 bits와 reset/clear/enable priority가 존재하는지 확인한다.
2. Recognized enable/control report에서 signal과 width를 찾는다. Vector object 수와 register bit 수를 구분한다.
3. Mapped netlist에서 feedback, CE pin, synchronous control과 asynchronous pin 연결을 확인한다.
4. Gating을 요청했다면 eligible/gated/ungated bits, ICG 수와 exclusion reason을 비교한다.
5. Test/scan override, clock source와 reset/wake 경로를 cross-probe한다.
6. Setup/hold, gating checks, max slew/cap와 physical load를 확인한다.
7. 동일 workload·corner에서 clock, sequential, combinational power와 area를 함께 비교한다.

도구가 특정 summary를 제공하지 않으면 netlist와 cell definition에서 확인하고 그 한계를 기록한다. Report의 “enable recognized” 문구만으로 clock power 절감을 주장하지 않는다. 전체 읽기 순서는 [Reading Synthesis Reports](read_synthesis_reports.md)에 정리한다.

## 11. Verification Strategy

다음 SVA는 `controlled_bank` 또는 연결된 checker용 fragment다. E0 control이 일으킨 NBA update는 다음 edge의 sample에서 보므로 `|=>`를 사용한다. Synchronous reset 자체도 clocked property로 검증한다.

```systemverilog
ap_reset:
  assert property (@(posedge clk)
    rst |=> q == '0);

ap_clear:
  assert property (@(posedge clk) disable iff (rst)
    clear |=> q == '0);

ap_capture:
  assert property (@(posedge clk) disable iff (rst)
    !clear && en |=> q == $past(d));

ap_hold:
  assert property (@(posedge clk) disable iff (rst)
    !clear && !en |=> $stable(q));
```

`disable iff (rst)`는 normal-operation check의 abort 조건이지 synchronous reset hardware를 비동기로 바꾸는 표현이 아니다. Reset property와 reset cycle test를 따로 유지한다. Known control, 적어도 한 번의 reset, W=1과 최대 지원 W를 포함해 test한다.

Clock-gating conversion 뒤에는 RTL에 clock edge가 있지만 gated FF에는 edge가 없는 구간을 고려한 equivalence methodology가 필요하다. 아래 항목은 functional simulation만으로 완료되지 않는다.

- Clear=1/en=0, clear=1/en=1, reset overlap과 back-to-back updates
- Off→on→off, idle 중 clear/reset, scan/test override와 wake-up sequence
- 모든 bit의 update/hold와 reset value, partial-bank control
- STA clock-gating checks, CDC/RDC와 post-route clock behavior
- Activity annotation coverage를 맞춘 전후 power 비교

## 12. Common Mistakes와 Review Checklist

흔한 실수는 hold와 clock stop을 동의어로 쓰는 것, clear를 enable 안으로 옮기는 것, valid FF까지 payload enable로 묶는 것, 넓은 bank면 gating이 항상 이득이라고 생각하는 것이다. 또 “합성이 알아서 처리한다”는 말로 report와 test 연결 검토를 생략하기 쉽다.

- [ ] Reset > clear > enable > hold priority가 cell 구현에서도 유지되는가?
- [ ] Disabled 상태의 clear와 reset을 시험했는가?
- [ ] Sequential self-assignment와 combinational feedback을 구분했는가?
- [ ] Recognized enable, mapped CE와 actual ICG를 별도 확인했는가?
- [ ] Group의 clock/edge/reset/control/test와 physical 조건이 호환되는가?
- [ ] Wider clock-active condition과 residual enable이 필요한지 검토했는가?
- [ ] Upstream switching과 FF clock-pin activity를 따로 측정하는가?
- [ ] Late enable, feedback hold, gating check와 max cap/slew를 확인했는가?
- [ ] Bank width뿐 아니라 idle correlation과 ICG overhead를 포함했는가?
- [ ] ASIC/FPGA target의 전용 resource와 flow 지원을 확인했는가?
- [ ] Conversion 뒤 reset/test/wake와 sequential equivalence를 확인했는가?

## 관련 문서

- [RTL to Hardware Mapping](rtl_to_hardware_mapping.md)
- [Register Enable](../04_low_power/register_enable.md)
- [Operand Isolation](../04_low_power/operand_isolation.md)
- [Inferred vs Explicit Clock Gating](../06_clock/inferred_vs_explicit.md)
- [Reset with Clock Gating](../07_reset/reset_with_clock_gating.md)
- [RTL Design Review Checklist](../15_checklist/rtl_design_review_checklist.md)
