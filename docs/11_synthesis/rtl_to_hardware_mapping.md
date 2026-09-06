# RTL to Hardware Mapping

RTL review에서 그린 adder, MUX와 register는 **mapping hypothesis**다. 합성은 그 의도를 해석하고 등가 변환한 뒤 target resource에 대응시킨다. 따라서 source의 `+` 개수와 최종 adder 수, `if`의 깊이와 mapped gate depth, module 위치와 floorplan 위치를 같은 것으로 취급하면 안 된다.

이 문서는 언어 문법을 다시 정의하지 않고, RTL에서 세운 가설을 elaboration 결과, intermediate representation, mapped netlist와 physical feedback으로 확인하는 방법을 다룬다. Priority semantics는 [Priority and MUX](../01_fundamentals/priority_and_mux.md), type/width 규칙은 [Width and Signedness](../01_fundamentals/width_and_signedness.md), bit-exact arithmetic은 [Datapath Width and Signedness](../10_datapath/width_signedness.md)가 정본이다.

## 1. 먼저 어느 단계의 Hardware인지 묻는다

```text
RTL + top + parameters + defines + filelist
                    |
                    v
              elaboration
       instances / types / generate choices
                    |
                    v
        generic processes and operators
     next-state / MUX / storage / arithmetic
                    |
                    v
               optimization
       constants / sharing / width / cleanup
                    |
                    v
              library mapping
        actual FF / logic / macro resources
                    |
                    v
      placement / clock tree / routing feedback
           sizing / buffers / replication
                    |
                    +----> revisit RTL hypothesis
```

위 그림은 책임을 구분한 개념도다. 실제 flow에서는 optimization과 mapping을 반복하거나 physical estimate를 합성 중에 사용한다. 모든 도구가 같은 순서와 이름의 중간 파일을 내보내는 것은 아니다.

| 단계 | 이 단계에서 결정·확인하는 것 | 아직 보장되지 않는 것 |
|---|---|---|
| Elaboration | Top, instance 연결, parameter 값, define에 따른 source, static generate 선택 | 최종 library cell 수와 배치 |
| Generic representation | Process priority, storage, operator width, abstract MUX/memory | 특정 cell의 delay·area·핀 특성 |
| Optimization | Constant propagation, dead cone 제거, Boolean 재구성, 가능한 sharing | RTL의 operator·hierarchy 일대일 보존 |
| Library mapping | 사용 가능한 sequential/logic/macro resource와 연결 | Routed wire delay와 최종 footprint |
| Physical feedback | 실제 load, 위치, route, buffers, skew, congestion | 다른 corner/mode까지 자동 closure |

Elaboration된 generic adder cell은 라이브러리의 adder macro가 아니다. Generic register 하나가 vector 전체를 표현할 수 있고, mapping 후에는 여러 single-bit FF, multi-bit sequential cell 또는 target-specific resource로 바뀔 수 있다. Cell count를 비교할 때 **bit count, abstract object count, mapped instance count**를 따로 기록한다.

!!! note "Process lowering의 구체적 사례"
    Yosys 0.56의 공식 [Converting process blocks](https://yosyshq.readthedocs.io/projects/yosys/en/v0.56/using_yosys/synthesis/proc.html)는 frontend의 process 표현을 `proc` 단계에서 RTL MUX/register cell netlist로 변환한다고 설명한다. 이 중간 표현이 곧 target library mapping 결과인 것은 아니다.

## 2. 잘못된 Elaboration은 훌륭한 PPA처럼 보일 수 있다

작은 netlist를 보고 기뻐하기 전에 무엇을 합성했는지 확인한다.

- 의도한 top이 맞고, wrapper가 기능 output을 실제로 연결하는가?
- Parameter override가 모든 instance에 원하는 값으로 적용됐는가?
- Filelist, include 순서, define과 선택된 source revision이 기록됐는가?
- 같은 이름의 module이나 package가 다른 경로에서 들어오지 않았는가?
- Simulation용 model, synthesis용 wrapper와 black box가 구분됐는가?
- 최소 width와 feature-off configuration도 legal한 port/type을 갖는가?

예를 들어 feature가 꺼진 parameter로 실행하면 해당 datapath가 없는 결과가 정상일 수 있다. 반면 필요한 output이 연결되지 않아 제거된 결과라면 같은 area 감소가 integration defect다. 이 둘의 구분은 [Constant and Dead Logic](constant_dead_logic.md), 실행 조건 기록은 [Reading Synthesis Reports](read_synthesis_reports.md)를 따른다.

## 3. 완결 예제: Width-Preserving Unsigned Add Stage

다음 예제의 지원 범위는 `W >= 1`이다. Build matrix에서 이 조건을 검사하며, `W=0`을 zero-width port로 지원하는 예제가 아니다. Add operands는 W+1 bits로 명시적으로 확장하고 full carry를 보존한다.

Interface는 backpressure 없는 one-stage stream이다. `rst_n=1`, `clear=0`, `in_valid=1`인 edge에서 input을 accept한다. `bypass=1`이면 zero-extended bypass data, 아니면 unsigned 합을 publish한다. Reset assertion은 비동기, release는 해당 clock에 대해 안전하게 처리된 입력이라고 가정한다.

```systemverilog
module unsigned_add_stage #(
  parameter int unsigned W = 8
) (
  input  logic         clk,
  input  logic         rst_n,
  input  logic         clear,
  input  logic         in_valid,
  input  logic         bypass,
  input  logic [W-1:0] in_a,
  input  logic [W-1:0] in_b,
  input  logic [W-1:0] bypass_data,
  output logic         out_valid,
  output logic [W:0]   out_sum
);
  logic [W:0] sum_full;
  logic [W:0] selected;

  assign sum_full = {1'b0, in_a} + {1'b0, in_b};
  assign selected = bypass ? {1'b0, bypass_data} : sum_full;

  // Priority: asynchronous reset > clear > accepted input > payload hold.
  // Without reset/clear, valid advances every edge, including bubbles.
  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      out_valid <= 1'b0;
      out_sum   <= '0;
    end else if (clear) begin
      out_valid <= 1'b0;
      out_sum   <= '0;
    end else begin
      out_valid <= in_valid;
      if (in_valid)
        out_sum <= selected;
    end
  end
endmodule
```

`clear`는 이 stage의 해당 edge update를 취소한다. 이미 edge 직전에 `out_valid=1`이었다면 downstream FF는 그 이전 결과를 같은 edge에서 소비할 수 있다. System-level flush로 그 소비까지 금지하려면 downstream acceptance에도 별도 flush contract가 필요하다. 이 예제의 clear priority가 과거의 transfer를 소급해서 취소하지는 않는다.

### Cycle audit

Input/control은 해당 edge의 setup/hold를 만족하며, reset 이후 첫 transaction부터 시작한다. Payload는 `out_valid=0`일 때 사용하지 않는다.

| Edge | Edge 직전 입력 | Downstream이 edge에서 보는 값 | NBA 이후 출력 |
|---|---|---|---|
| E0 | valid=1, clear=0, bypass=0, A/B | Invalid | valid=1, A+B |
| E1 | valid=1, clear=0, bypass=1, P | A+B 소비 | valid=1, zero-extended P |
| E2 | valid=0, clear=0 | P 소비 | valid=0, payload P 유지 |
| E3 | valid=1, clear=1 | Invalid | valid=0, payload 0, 새 입력 미수락 |
| E4 | valid=1, clear=0, bypass=0, C/D | Invalid | valid=1, C+D |
| E5 | valid=0, clear=0 | C+D 소비 | valid=0, payload 유지 |

E0 acceptance 직후 NBA에서 결과 register가 갱신되고 E1 edge에서 downstream이 소비한다. 이는 **one registered stage, II=1**이다. Operand register 뒤에 별도 result register가 있는 two-stage 구조가 아니다. 합성 report에서 sequential bit가 예상보다 많다면 input wrapper, retiming 설정과 다른 pipeline boundary까지 cross-probe한다.

## 4. RTL에서 추적할 네 가지 구조

```text
in_a -- zero extend --+
                     +-- unsigned add --+
in_b -- zero extend --+                  |
                                        MUX(bypass) --+
bypass_data -- zero extend --------------+             |
                                                      MUX(in_valid) --+
out_sum feedback -------------------------------------+               |
                                                                      MUX(clear) --> FF --> out_sum
constant zero --------------------------------------------------------+               ^
                                                                                      |
                                                                        clk / async reset

in_valid --> clear qualification --> valid FF --> out_valid
```

그림은 priority를 설명하는 논리적 분해이며 literal MUX tree를 강제하지 않는다.

1. **Operator:** W+1-bit 표현의 unsigned addition이다. 상위 zero bit나 observer 조건 때문에 내부 표현이 줄어들 수 있어도 필요한 carry는 보존해야 한다.
2. **Selection:** Bypass와 합 중 하나를 고른다. Upstream operands가 변하면 bypass가 선택되어 있어도 adder activity가 남을 수 있다.
3. **Enable/hold:** Payload는 bubble에서 hold한다. Feedback MUX나 enable cell은 후보이며, clock gating은 별도 transformation이다.
4. **Storage/control:** Payload W+1 bits와 valid 1 bit라는 RTL state hypothesis가 있다. Clear는 synchronous priority, reset은 asynchronous control이다. 두 control을 같은 종류의 D MUX로 단정하지 않는다.

Clear와 valid condition을 합치거나 logic gate로 흡수하는 구현도 기능적으로 가능하다. Dedicated clear/enable cell이 있는지, polarity와 priority가 맞는지는 library와 mapping에 달려 있다. 더 깊은 enable 해석은 [Enable and MUX Inference](enable_and_mux_inference.md)를 따른다.

## 5. Inference는 Pattern과 Target의 교집합이다

| RTL 의도 | 가능한 구현 후보 | 실제로 확인할 조건 |
|---|---|---|
| Arithmetic | 일반 logic, carry resource, arithmetic/DSP macro | Width, signedness, operation, latency, enable/reset과 macro 지원 |
| Array storage | FF bank+MUX, distributed memory, memory macro | Read/write port, collision, read latency, reset과 target inference 규칙 |
| FSM | Encoded state FF와 decode network | Recognized state register, encoding 정책, illegal-state contract |
| Register enable | Feedback MUX+FF, enable cell | Clock edge, reset, priority, cell availability |
| Common enable bank | ICG+FF와 잔여 data control | Gating flow, eligible bank, test/reset/wake와 timing 검증 |

Arithmetic나 memory가 기대한 macro로 mapping되지 않았다고 바로 RTL을 gate 수준으로 다시 쓰지 않는다. 먼저 unsupported read/reset pattern, 잘못된 width, synthesis setting과 library availability를 찾는다. [Memory and Register Array](../05_area/memory_and_register_array.md), [FSM and Counter Encoding](../05_area/fsm_counter_encoding.md), [Inferred vs Explicit Clock Gating](../06_clock/inferred_vs_explicit.md)에서 각 기능 계약을 확인한다.

## 6. Static Loop는 자동 Iterative Architecture가 아니다

다음은 module 내부에 놓는 combinational fragment다. `N >= 1`이며 출력 각 bit는 같은 cycle의 해당 입력 bit에 의존한다.

```systemverilog
parameter int unsigned N = 4;
logic [N-1:0] data_in, mask, data_out;

always_comb begin
  for (int i = 0; i < N; i++) begin
    data_out[i] = data_in[i] & mask[i];
  end
end
```

정적으로 한계가 결정되는 loop는 반복 body를 hardware representation으로 펼칠 수 있다. 위 예제에는 시간에 따라 움직이는 loop counter register나 N-cycle controller가 없다. 반대로 loop body가 이전 iteration의 결과를 누적하면 combinational dependency chain을 만들 수 있으므로 **unrolled = 얕은 parallel tree**도 아니다.

| 구분 | Static unrolled loop | Explicit iterative architecture |
|---|---|---|
| 반복 위치 | Elaboration/process lowering 중 구조 전개 | Clock edge마다 state transition |
| State | Body가 기술한 state만 존재 | Iteration counter, accumulator, busy 등 필요 |
| Latency/II | Register boundary와 dependency로 결정 | Schedule, resource occupancy와 handshake로 결정 |
| 자원 | 여러 연산으로 펼쳐진 후 최적화 가능 | 적은 operator 재사용 가능, control/storage 비용 추가 |

Source의 `for`를 썼다는 이유로 operator 하나가 여러 cycle 동안 재사용되지 않는다. Iterative scheduling과 sharing의 계약은 [Resource Sharing vs Duplication](../02_architecture/resource_sharing_vs_duplication.md)를 참고한다.

## 7. Latch와 Simulation Construct를 구분한다

Combinational process에서 일부 legal path의 assignment를 빠뜨리면 이전 값을 보존해야 하므로 unintended latch의 원인이 된다. 다음은 **문제를 설명하는 incomplete fragment**다.

```systemverilog
always_comb begin
  if (select)
    y = a; // Missing assignment when select is zero: not a complete function.
end
```

`always_comb`라는 이름이 누락된 assignment를 고쳐 주지는 않는다. Frontend가 error/warning을 낼 수 있으며, 허용된 flow에서는 latch inference로 이어질 수 있다. 의도된 level-sensitive storage는 예를 들어 `always_latch`로 표현하고 transparency window, timing, reset과 test를 검증해야 한다. “Latch count는 언제나 0이어야 한다”보다 **unexpected latch가 없어야 한다**가 정확한 review 질문이다.

Delay control `#`, `initial`과 simulation system task의 지원 범위도 target/flow별로 다르다. Testbench delay를 물리 delay cell로 기대하지 않는다. 어떤 flow는 특정 initialization을 memory/FPGA resource 초기값으로 지원하고, 다른 flow는 무시하거나 거부할 수 있다. 지원을 확인하지 않은 `initial` 값을 ASIC power-on contract로 사용하지 않는다. Simulation convenience와 target이 실제 구현하는 initialization을 분리한다.

## 8. Mapping Hypothesis를 Evidence로 바꾼다

| Hypothesis | 첫 번째 증거 | Netlist/후속 단계에서 재확인 |
|---|---|---|
| Add가 carry를 보존한다 | Elaborated operand/result widths | Carry를 포함한 output cone과 equivalence |
| Payload는 hold 가능하다 | Recognized enable/control summary | Feedback, enable pin 또는 변환된 gating 구조 |
| Clear가 enable보다 우선한다 | Generic next-state representation | Clear=1, valid=0 및 clear=1, valid=1의 state transition |
| Extra pipeline은 없다 | Sequential boundary와 bit inventory | Acceptance→publish→consume cycle의 equivalence |
| Operator가 공유됐다 | Before/after generic operator 정보 | 실제 input MUX와 consumer별 path, scheduling 유지 |
| Memory/FSM/ICG가 inference됐다 | 해당 inference report와 warning | Macro/cell 연결, clock/reset/test, unsupported fallback |
| Local hierarchy라 짧은 path다 | RTL hierarchy만으로는 불충분 | Post-place 위치와 post-route cell/net delay |

Cell 이름이 사라졌다는 이유로 기능이 사라졌다고 결론 내리지 않는다. Logic absorption, merging, renaming 뒤에는 output에서 backward cone을 추적하고 mapping database가 있으면 원래 RTL과 연결한다.

!!! note "확인한 tool-specific 사례"
    Yosys 0.56의 공식 [Optimization passes](https://yosyshq.readthedocs.io/projects/yosys/en/v0.56/using_yosys/synthesis/opt.html)는 `opt_merge`의 동일 cell 병합과 `opt_share`의 조건부 sharing을 설명한다. 이는 source operator 수가 보존되지 않을 수 있다는 구체적 사례이며, 모든 flow가 같은 변환을 한다는 보장은 아니다. 이 문서의 예제를 Yosys로 실행했다는 의미도 아니다.

## 9. PPA와 Over-Coding의 비용

High-level arithmetic와 명확한 next-state expression은 tool이 target cell을 선택할 여지를 준다. 반대로 작은 gate를 수동으로 나열하거나 광범위한 `dont_touch`류 제약을 걸면 constant propagation, sharing, sizing, buffering 또는 구조 재배치의 여지가 줄 수 있다. 속성이 어느 object와 단계에 적용되는지도 도구별로 다르다.

| 선택 | 얻을 수 있는 것 | 잃을 수 있는 것 / 확인할 것 |
|---|---|---|
| High-level operator 유지 | Arithmetic recognition과 portability | 특정 topology가 필요하면 actual mapping 확인 |
| Manual decomposition | 측정된 bottleneck에 맞는 구조 실험 | Logic depth 증가, macro inference 손실, 검증 복잡도 |
| Hierarchy 보존 | Ownership와 compile boundary | Cross-boundary optimization 제한, placement는 별도 |
| 강한 preservation | 의도된 특수 구조 보호 | Area/power 증가, timing repair 제한, 오래된 가정 고착 |
| Timing-driven sharing/duplication | 목표 path 또는 area 개선 가능 | MUX, load, wire, switching 변화와 다른 path 악화 |

특수 구조를 보호할 이유가 있다면 대상, 근거, owner와 제거 조건을 좁게 기록한다. 일반 RTL을 “합성기가 좋아할 모양”으로 바꾸기 전에 같은 configuration과 constraint에서 controlled experiment를 한다.

합성은 latency와 throughput 요구사항을 발명하지 않는다. 지원되는 retiming이나 sequential optimization을 사용하는 경우에도 external cycle contract와 verification boundary를 명시해야 한다. [Multi-Cycle Path](../03_timing/multi_cycle_path.md)는 기존 기능적 capture schedule을 timing model에 표현하며, 그 자체가 register나 느린 연산용 controller를 추가하지 않는다. Constraint 변경이 optimizer 선택에 영향을 줄 수 있다는 사실과 hardware schedule을 만들어 준다는 주장은 다르다.

## 10. Verification Strategy

다음은 `unsigned_add_stage` 안 또는 동일 신호를 연결한 checker에 넣을 수 있는 SVA fragment다. Simulator/formal tool의 SVA 지원을 별도로 확인한다. Clocked SVA는 E0 input을 sample하고 E0 NBA 결과를 E1 preponed sample에서 관찰하므로 `|=>`를 쓴다. Reset assertion은 pending check를 abort한다.

```systemverilog
ap_clear:
  assert property (@(posedge clk) disable iff (!rst_n)
    clear |=> !out_valid && (out_sum == '0));

ap_add:
  assert property (@(posedge clk) disable iff (!rst_n)
    !clear && in_valid && !bypass |=>
      out_valid &&
      out_sum == ({1'b0, $past(in_a)} + {1'b0, $past(in_b)}));

ap_bypass:
  assert property (@(posedge clk) disable iff (!rst_n)
    !clear && in_valid && bypass |=>
      out_valid && out_sum == {1'b0, $past(bypass_data)});

ap_bubble:
  assert property (@(posedge clk) disable iff (!rst_n)
    !clear && !in_valid |=> !out_valid && $stable(out_sum));
```

검증에는 W=1, 최대 지원 W, zero/max/max+max, bypass 전환, 연속 valid, bubble과 clear overlap을 포함한다. 모든 control은 known 0/1이라는 functional assumption을 가지며 X 진단은 별도 검사한다. Reset release와 첫 acceptance도 시험한다.

Compile/elaboration, lint, simulation, sequential equivalence와 timing 분석은 다른 증거다. Arithmetic reference와 cycle model이 일치해도 실제 compiler가 syntax를 수용했거나 target library로 mapping됐다는 뜻은 아니다.

## 11. Common Mistakes

- Generic vector cell count를 mapped physical cell count와 비교해 면적 비율을 계산한다.
- `+` 두 개면 adder 두 개, module 두 개면 물리 영역 두 개라고 단정한다.
- Unrolled accumulation을 자동으로 balanced tree나 iterative datapath로 해석한다.
- Bubble hold를 보고 upstream adder와 FF clock이 모두 멈췄다고 주장한다.
- Missing output 연결로 줄어든 netlist를 최적화 성공으로 보고한다.
- `initial`, delay control과 latch의 target별 지원을 확인하지 않는다.
- Timing 실패를 manual gate coding이나 광범위한 preservation으로 먼저 해결하려 한다.
- MCP를 추가하고 실제 hardware latency가 늘었다고 설명한다.

## 12. Design Review Checklist

- [ ] Top/parameter/define/filelist와 RTL revision이 재현 가능한가?
- [ ] Generic representation과 mapped cell의 단계·집계 단위를 구분했는가?
- [ ] Priority, storage, enable, operator와 output observer를 추적했는가?
- [ ] Accepted edge, NBA publication, downstream observation cycle이 일치하는가?
- [ ] Width/extension과 carry가 canonical arithmetic contract를 보존하는가?
- [ ] Arithmetic/memory/FSM/ICG inference와 fallback의 실제 증거가 있는가?
- [ ] Unintended latch, unresolved module과 unsupported construct를 disposition했는가?
- [ ] Sharing, merging과 hierarchy 변화 뒤에도 의미와 cycle이 보존되는가?
- [ ] Preservation directive의 대상·비용·필요성을 설명할 수 있는가?
- [ ] Physical feedback까지 확인하거나 미확인 범위를 명시했는가?

## 관련 문서

- [Enable and MUX Inference](enable_and_mux_inference.md)
- [Constant and Dead Logic](constant_dead_logic.md)
- [Reading Synthesis Reports](read_synthesis_reports.md)
- [Fanout and Locality](../12_physical_aware/fanout_and_locality.md)
- [Critical Path](../03_timing/critical_path.md)
- [RTL Design Review Checklist](../15_checklist/rtl_design_review_checklist.md)
