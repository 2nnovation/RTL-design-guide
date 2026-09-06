# Reading Synthesis Reports

Report의 첫 질문은 “slack이 양수인가?”가 아니다. **내가 의도한 RTL, configuration과 분석 범위를 실행한 결과인가?**가 먼저다. Wrong top, missing clock, constant output이나 과도한 exception도 매우 작은 area와 좋은 timing summary를 만들 수 있다.

이 문서는 synthesis와 후속 STA/physical report를 review evidence로 읽는 순서를 제안한다. STA 원리와 exception의 정본은 [Timing Overview](../03_timing/overview.md), [Critical Path](../03_timing/critical_path.md), [Multi-Cycle Path](../03_timing/multi_cycle_path.md)다. 여기의 표와 report 형태는 직접 만든 설명용 자료이며, 특정 vendor의 output이나 실제 합성·STA 실행 결과가 아니다.

## 1. 읽는 순서: 조건 → Coverage → 수치 → 구조

```text
run provenance
      |
      v
warnings / unresolved objects / unexpected removal
      |
      v
mapping inventory: storage / width / memory / FSM / ICG
      |
      v
clocks / unconstrained coverage / exception scope
      |
      v
timing paths --> area --> power
      |
      v
netlist cross-probe --> controlled A/B experiment
```

위 순서는 보고서를 읽는 우선순위이며 tool command sequence가 아니다. Coverage나 기능이 의심되면 PPA 개선 결론을 보류하고 원인을 찾는다. 마지막에 netlist를 본다는 뜻도 “warning을 조사할 때 netlist를 열지 말라”는 제한은 아니다.

## 2. Run Provenance를 고정한다

다음 정보를 report와 함께 보관해야 다른 사람이 비교를 재현할 수 있다. 파일 이름에 `final`이 들어 있다고 final implementation이 되는 것은 아니다.

| 항목 | 기록할 내용 | 누락 시 오해 |
|---|---|---|
| RTL identity | Revision, 추가 local diff, filelist, include/define, top | 다른 코드를 같은 실험으로 비교 |
| Elaboration | Instance별 parameters, feature configuration, wrapper/tie-off | 비활성 feature의 작은 area를 최적화로 해석 |
| Tool/flow | Tool/version, flow revision, optimization 설정, run completion | 다른 알고리즘/effort 또는 미완료 결과 혼합 |
| Library | 사용 cell/macro, timing/power models, 제외 resource | Cell 지원·area 단위·delay 차이 누락 |
| Constraints | Clock, I/O delay/load, uncertainty, design rules, exceptions | 느슨해진 requirement를 개선으로 해석 |
| Analysis view | Mode, process/voltage/temperature corner, variation 설정 | 다른 operating point를 비교 |
| Physical stage | Pre-layout / post-place / post-CTS / post-route, parasitic source | Wire/skew 정밀도가 다른 timing 비교 |
| Power activity | Workload, time window, activity file/model, annotation coverage | 입력 switching 차이를 RTL 효과로 해석 |
| Scope | Hierarchy, path groups, clocks/macros/test 포함 범위 | Subset을 whole-chip 또는 all-mode 결과로 해석 |

라이브러리 이름이 같아도 release와 corner가 다를 수 있다. Timing과 power가 같은 operating condition인지, multi-corner 분석이면 각 결과가 어느 view에 속하는지 확인한다. Report와 netlist가 같은 run 산출물인지도 연결한다.

## 3. Warning은 PPA보다 먼저 Disposition한다

모든 warning을 무조건 error로 취급할 필요는 없지만, expected라고 판단한 이유와 영향 범위가 있어야 한다. 개수만 줄이려고 global suppression을 추가하지 않는다.

| Warning / symptom | 먼저 확인할 것 | Review 판단 |
|---|---|---|
| Unresolved module / black box | Intended macro인지 missing source/model인지 | Interface model과 제외된 timing/area/power를 명시 |
| Inferred latch | 의도된 level-sensitive state인지 assignment 누락인지 | Unexpected latch는 원인 해결 전 결과 보류 |
| Multiple driver | 실제 conflict, tri-state 모델 또는 잘못된 연결인지 | Simulation/netlist 의미와 target 지원 확인 |
| Undriven signal | 누락 port/default, generate branch 연결 | X/constant 치환으로 오류가 숨지 않는지 확인 |
| Removed register/operator/output | Feature-off, unused cone 또는 wrong enable/top | Live observer와 build 조건에서 추적 |
| Width/sign conversion | Intentional resize인지 carry 손실인지 | Numeric contract와 parameter boundary 확인 |
| Unsupported construct | Frontend가 무시/거부/다른 방식 처리했는지 | 실제 하드웨어 의미 확인 전 waive 금지 |

Black box count가 0이라는 사실만으로 모든 memory timing/power가 정확하다는 뜻은 아니다. 반대로 의도한 macro black box가 존재할 수 있지만, 모델이 제공하는 arc와 분석 제외 범위를 설명해야 한다. 제거된 object는 [Constant and Dead Logic](constant_dead_logic.md)의 expected/unexpected 분류를 사용한다.

## 4. Mapping Inventory: Count보다 예상 구조와 대조한다

먼저 [RTL to Hardware Mapping](rtl_to_hardware_mapping.md)에서 만든 state/operator hypothesis를 가져온다.

- Sequential **bits**와 mapped **instances**를 따로 센다. Multi-bit cell이나 macro가 있으면 둘이 다르다.
- Resettable/resetless, enable/feedback, latch와 ordinary FF를 구분한다.
- Arithmetic operand/result width와 signedness, macro fallback을 확인한다.
- Memory의 port 수, depth/width, read latency와 FF bank 대체 여부를 확인한다.
- FSM이 recognition/recoding됐는지, illegal-state contract가 보존되는지 확인한다.
- Enable recognition과 ICG insertion을 분리하고 eligible/gated/ungated bits를 본다.
- Buffer/inverter와 combinational cell이 과도하면 clock/reset/control load와 실제 path를 조사한다.

Count 차이가 항상 오류는 아니다. Constant propagation, factoring, merging이나 encoding이 달라질 수 있다. 차이를 설명할 수 있어야 한다는 것이 기준이다. Operator report가 없는 단계에서는 mapped output cone을 추적하고, “report 없음”을 “operator 없음”으로 해석하지 않는다.

### 짧은 RTL hypothesis와 netlist 대응

아래는 declaration과 reset policy를 생략한 module 내부 fragment다. 기능적 enable이 mapping에서 어디로 갔는지 찾기 위한 예이며 완결 module이 아니다.

```systemverilog
always_ff @(posedge clk) begin
  if (en)
    q <= d;
end
```

```text
Hypothesis: state q, update on en, hold otherwise

Possible evidence:
  q -> feedback MUX -> D(FF)       en drives MUX select
  d -> D(enable FF)                en drives CE pin
  d -> D(FF), approved ICG -> CK   transformed clock plus residual controls

Not evidence:
  a report line containing the word "enable" without pin/clock cross-probe
```

기능과 library 조건은 [Enable and MUX Inference](enable_and_mux_inference.md)에서 확인한다. 이 짧은 fragment를 근거로 ICG, reset 또는 power 절감을 추정하지 않는다.

## 5. Clock, Unconstrained Coverage와 Exceptions

Timing 수치를 읽기 전에 분석 대상이 완전한지 확인한다.

| Coverage 질문 | 확인할 증거 |
|---|---|
| 모든 sequential clock이 정의됐는가? | Clock 목록, generated relationship, missing/multiple clock 진단 |
| I/O path budget이 있는가? | Input/output delay, load와 해당 mode의 interface 모델 |
| Endpoint가 분석되는가? | Timed, unconstrained, excluded endpoints와 각 이유 |
| Clock propagation 단계가 맞는가? | Ideal/estimated/propagated clock, CTS와 parasitic 상태 |
| Exception이 정확히 적용됐는가? | Resolved object 집합, 적용된 path와 edge relationship |
| Constraint가 조용히 빗나가지 않았는가? | Empty collection, unmatched pattern, renamed/removed target |
| 의도한 mode를 모두 보는가? | Functional/test/wake 등 supported mode matrix |

Check script가 빈 collection을 대상으로 “0 violations”를 출력하면 검증 성공이 아닐 수 있다. 각 주요 constraint/check는 expected object count 또는 대상 목록을 확인한다. 반대로 wildcard가 너무 넓어 data, enable, reset과 다른 clock 경로까지 exception에 포함했는지도 조사한다.

False path와 MCP는 적용 전후 **어떤 path가 어떤 이유로 바뀌었는지** 기록한다. MCP가 실제 multi-cycle capture contract와 일치하는지, setup과 hold edge 관계를 모두 확인한다. Functional invariant는 RTL/property에서 증명하고 constraint만으로 만들어 내지 않는다.

!!! note "확인한 tool-specific 사례"
    OpenSTA 공식 공개 source의 [`Search.tcl`](https://github.com/The-OpenROAD-Project/OpenSTA/blob/master/search/Search.tcl)에 정의된 `check_setup`은 missing clock/I/O delay, unconstrained endpoints, loops와 generated-clock 검사를 노출한다. 이름에 setup이 있어도 단일 setup-slack 숫자만 검사하는 것은 아니라는 사례다. 사용 버전의 실제 범위는 다시 확인해야 하며, 이 문서는 해당 검사를 실행했다는 보고가 아니다.

## 6. Timing Path를 같은 시간축으로 읽는다

Launch/capture edge, clock arrival, data arrival와 required time을 먼저 적는다. 그 다음 slack의 부호를 계산한다. 아래는 **illustrative/fabricated** single-clock 예제다. 실제 vendor output이 아니며 특정 공정 성능을 나타내지 않는다.

가정은 period=1.00 ns, ideal clock, skew=0인 단순 모델이다. Setup과 hold는 각각 max/min delay를 사용한다. 실제 flow의 variation, propagated skew나 pessimism correction 등을 이 표가 대신하지 않는다.

```text
Setup timeline (ns):
  E0 launch(0.00) --> required(0.86) --> arrival(0.92) --> E1 capture(1.00)
                     latest allowed    late by 0.06

Hold timeline (ns):
  E0 launch/capture(0.00) --> required(0.05) --> arrival(0.06)
                             earliest allowed  margin 0.01
```

Diagram의 위치는 개념적이며 scale drawing이 아니다. 정확한 값은 다음 표다.

| 항목 | Setup: max-delay view | Hold: min-delay view |
|---|---:|---:|
| Launch edge arrival | 0.00 ns | 0.00 ns |
| Clock-to-Q | 0.08 ns | 0.03 ns |
| Combinational cell delay 합 | 0.48 ns | 0.01 ns |
| Net delay 합 | 0.36 ns | 0.02 ns |
| Data arrival | 0.92 ns | 0.06 ns |
| Capture edge arrival | 1.00 ns | 0.00 ns |
| Setup / hold requirement | 0.06 ns | 0.03 ns |
| Uncertainty | 0.08 ns | 0.02 ns |
| Required time | 1.00 - 0.06 - 0.08 = 0.86 ns | 0.00 + 0.03 + 0.02 = 0.05 ns |
| Slack | 0.86 - 0.92 = **-0.06 ns** | 0.06 - 0.05 = **+0.01 ns** |

```text
setup slack = required time - maximum data arrival
hold slack  = minimum data arrival - required time
```

Setup은 늦게 오는 data, hold는 너무 빨리 바뀌는 data를 본다. 동일 reference edge의 clock delay, skew, uncertainty가 이미 report에 들어 있다면 수기로 다시 더하지 않는다. Generated/related clock, opposite edge, latch 또는 MCP에서는 위의 E0/E1 가정을 그대로 적용하지 말고 report가 선택한 실제 launch/capture edge를 확인한다.

RTL cycle table과 STA edge table도 다르다. RTL에서 E0에 accept하여 E0 NBA에 output register를 갱신하는 one-stage 예제는, upstream FF가 이전 edge에 launch한 input을 E0에 capture하는 path일 수 있다. SVA의 `|=>` sample 간격을 근거로 그 path에 추가 cycle의 timing budget을 주지 않는다.

## 7. WNS/TNS는 Report Scope와 함께 읽는다

일반적으로 WNS는 가장 나쁜 negative slack, TNS는 분석 범위에서 집계한 negative slack의 합을 뜻한다. 그러나 path group, endpoint별 worst path, rise/fall과 setup/hold의 집계 방식은 tool/report마다 확인해야 한다. 같은 endpoint로 가는 모든 출력 path의 slack을 무작정 합하지 않는다.

다음도 **illustrative/fabricated** 예다. 이 표에서만 “endpoint마다 worst setup slack 하나, negative 값만 합산”이라고 집계 규칙을 명시한다.

| Endpoint | Worst setup slack |
|---|---:|
| endpoint_a | -0.06 ns |
| endpoint_b | -0.02 ns |
| endpoint_c | +0.10 ns |
| 이 표의 WNS / TNS | -0.06 ns / -0.08 ns |

모두 통과한 경우 negative-slack metric을 0으로 표시하는 report와 positive worst slack을 보여 주는 report를 구분한다. WNS=0이 얼마나 많은 positive margin을 갖는지 알려 주지는 않는다. TNS 감소는 위반의 폭을 이해하는 데 유용하지만 제거·제외된 endpoint 때문에 줄었을 가능성도 조사한다.

Positive slack만으로 다음을 주장할 수 없다.

- Unconstrained/excluded path까지 검증됐다.
- 다른 mode/corner의 setup/hold도 통과했다.
- Gating, recovery/removal, pulse-width와 design-rule check도 통과했다.
- 아직 없는 routed parasitic이나 clock tree도 문제가 없다.

WNS/TNS와 함께 violation endpoints, coverage, margin distribution과 다음 bottleneck을 기록한다.

## 8. Cell Delay, Net Delay와 Design Rules

Path의 cell/net delay 비율은 다음 실험을 정하는 단서다. Pre-route wire estimate가 거칠면 net delay가 작다는 사실조차 최종 구조의 성질로 확정할 수 없다.

| 관찰 | 가능한 원인 | 다음 확인 |
|---|---|---|
| Cell delay가 지배 | 깊은 logic, wide arithmetic, 약한 drive, 나쁜 input slew | Operator/MUX depth, cell arcs와 load |
| Net delay가 지배 | Long route, dispersed loads, congestion detour | Physical 위치, route length/layer, buffer topology |
| Select/enable이 늦음 | Decode dependency와 control fanout | Data path와 control path를 각각 cross-probe |
| Setup 개선 후 hold 악화 | Shorter min path 또는 clock balance 변화 | 같은 변경의 minimum-delay analysis |

Max fanout, max transition(slew), max capacitance는 setup/hold slack과 다른 design-rule check다. Setup이 통과해도 load/slew limit을 넘을 수 있고, electrical violation을 고친 buffer가 timing과 power를 바꿀 수 있다. Library/model의 분석 가능 범위와 design rule을 만족하는지 별도 확인한다.

!!! note "Pre-route evidence의 한계"
    OpenROAD의 공식 [Gate Resizer 문서](https://openroad.readthedocs.io/en/latest/main/src/rsz/README.html)는 placement 기반 parasitic이 routed parasitic을 정확하게 예측하지 못한다고 설명한다. 따라서 placement timing을 post-route closure로 보고하지 않는다. 여기서는 OpenROAD 실행이나 특정 repair 효과를 주장하지 않는다.

## 9. Area: Mapped Cells와 Core Footprint

Area report를 읽을 때 포함 resource와 단위를 먼저 확인한다. Sequential, combinational, macro, buffer, ICG의 합이 어떤 scope의 total인지 본다. Hierarchical subtotal이 inclusive인지 exclusive인지 확인하지 않고 부모·자식 area를 모두 더하면 중복 집계할 수 있다.

Mapped cell area 감소가 core footprint 감소를 보장하지 않는다. Placement whitespace, macros, routing channels, pin access, CTS와 timing repair가 실제 block 크기에 영향을 준다. Area definition과 congestion의 정본은 [Physical Area and Congestion](../05_area/physical_area_and_congestion.md)이다.

확인할 질문은 다음과 같다.

- FF 수 감소가 bit count 감소인가, multi-bit cell packing인가?
- Buffer와 clock/reset 관련 area가 포함됐는가? 아직 삽입 전인가?
- Memory가 macro에서 FF bank로 바뀌어 비교 단위가 달라지지 않았는가?
- Area 감소와 함께 live outputs나 required mode가 사라지지 않았는가?
- 동일 floorplan에서 congestion/route/hold repair 비용까지 확인했는가?

## 10. Power: Activity Coverage부터 본다

Power는 cell list만의 속성이 아니다. Activity, operating corner, clock frequency, input slew/load와 power model 범위가 결과를 좌우한다.

| 항목 | 기록할 내용 |
|---|---|
| Activity source | Simulation activity, measured trace 또는 vectorless assumption |
| Workload/window | Active/idle/reset 구간, transaction 수, mode와 time unit |
| Annotation coverage | 어떤 port/net/register에 activity가 연결됐는지, coverage의 분모 |
| Unannotated objects | Default toggle rate/probability, clock 처리, 이름 mapping 실패 |
| Power components | Switching, internal, leakage와 tool의 accounting 정의 |
| Clock inclusion | Clock pins, ICG 앞/뒤 tree, CTS 전후 포함 범위 |
| Macro/model coverage | Memory/DSP/black-box power model 유무 |
| Corner | Voltage, temperature, process와 frequency |

Internal과 switching power의 분류는 모델/report 정의를 따른다. Leakage를 빼고 total이라고 보고하거나, clock tree가 없는 pre-CTS estimate를 complete clock power로 설명하지 않는다. Glitch activity와 delay annotation 여부도 동적 power 비교에 영향을 준다.

Unannotated net이 default activity를 쓰면 annotation coverage 차이만으로 후보의 power가 좋아질 수 있다. 전체 coverage가 높아도 가장 큰 clock/macro cone이 빠지면 결과가 취약하다. Block별 coverage와 load가 큰 cone의 activity를 함께 확인한다.

Throughput이 달라졌다면 같은 시간의 power만 비교하지 말고 유효 transaction당 energy와 처리율도 고려한다. Clock을 멈춘 시간에 작업을 못 한 설계를 같은 기능을 수행한 것처럼 비교하지 않는다.

## 11. Netlist Cross-Probe: 숫자를 설명 가능한 구조로

Timing startpoint/endpoint를 RTL state에 연결하고, cell chain에서 arithmetic, selection, feedback과 control을 식별한다. 이름이 바뀌거나 logic이 합쳐졌다면 output cone과 mapping database를 사용한다.

```text
RTL hypothesis                 report evidence               implementation
shared select              ->  late control path         ->  decode/buffers/MUX pins
payload enable             ->  gated or ungated bits     ->  CE / feedback / ICG
feature-off                ->  removed object summary    ->  constants and observers
local duplication          ->  lower net delay?          ->  replica position/routes
```

중요한 것은 보고서의 단어를 찾는 것이 아니라 연결을 확인하는 것이다. 특히 ICG output에서 실제 clock loads까지, removed register에서 required output까지, late control에서 모든 consumer group까지 추적한다. Logical hierarchy가 physical locality를 보장하지 않으므로 위치 근거는 [Fanout and Locality](../12_physical_aware/fanout_and_locality.md)를 따른다.

## 12. Controlled A/B Ledger

하나의 가설을 정하고 같은 build, constraints, library, corner, physical stage와 workload에서 비교한다. 가능하면 동일 floorplan/effort/seed를 쓰고, nondeterminism이 의미 있게 남으면 반복 실험으로 분산을 기록한다.

아래는 실제 수치가 아닌 **비교 기록 양식**이다. 칸이 비어 있다는 사실을 통과로 해석하지 않는다.

| 항목 | Baseline A | Candidate B | 비교 가능 여부 / 설명 |
|---|---|---|---|
| 변경한 가설 | 기존 구조 | 한 가지 구조 변경 | 기능/latency/II 동일 여부 |
| Provenance | Run identity | Run identity | RTL 차이 외 조건 일치 |
| Coverage/exceptions | Timed/excluded objects | Timed/excluded objects | Target 수와 이유 일치 |
| Mapping | FF bits, operators, ICG, macros | 같은 분류 | 예상 구조 변화 |
| Timing | Setup/hold WNS/TNS와 view | 같은 metric/view | Electrical/gating checks 포함 |
| Area | Mapped / physical 구분 | 같은 scope | CTS/repair 단계 일치 |
| Power | Activity/model coverage와 components | 같은 window/scope | Throughput/energy 함께 검토 |
| Verification | Equivalence/tests | Equivalence/tests | Assumption 변화 여부 |
| Decision | 유지/추가 조사 | 채택/기각/추가 조사 | Evidence와 재검토 조건 |

숫자가 좋아지면 먼저 다음 반증 질문을 한다.

1. Wrong configuration이나 output disconnect로 기능이 줄었는가?
2. Clock period, I/O budget이나 load가 달라졌는가?
3. False path/MCP가 늘거나 broad exception으로 critical endpoints가 빠졌는가?
4. Empty collection 때문에 check가 아무것도 검사하지 않았는가?
5. Power annotation이 끊겨 inactive default가 사용됐는가?
6. Pre-route와 post-route, 다른 mode/corner를 섞었는가?
7. Shared/duplicated logic이 예상과 다르게 최적화됐는가?

이 질문을 통과한 뒤에도 “좋아진 숫자”와 “채택할 설계”는 다르다. Maintainability, debug, initialization, protocol과 downstream constraint 영향까지 [Microarchitecture Decision Record](../02_architecture/microarchitecture_decision_record.md)에 남긴다.

## 13. Common Mistakes와 Verification Strategy

대표적인 실수는 positive slack을 coverage로, cell area를 footprint로, annotation 없는 power를 측정값으로 보고하는 것이다. 다른 실수는 하나의 worst path를 개선한 뒤 다른 endpoint, hold와 test mode를 확인하지 않는 것이다.

Report review 자체도 검증 가능하게 만든다.

- Expected clocks, endpoints, macro와 critical exception의 대상 목록을 regression에서 비교한다.
- Empty/unmatched collection과 새로운 warning을 눈에 띄게 보고한다.
- 주요 숫자의 단위, sign convention과 집계 범위를 소규모 예제로 검산한다.
- 동일 run의 netlist/constraint/activity를 cross-probe한다.
- 기능 등가와 reset/mode tests로 PPA 개선이 의미 손실 때문이 아님을 확인한다.
- 실행하지 않은 synthesis/STA/physical/power 분석은 명시적으로 `not run`으로 기록한다.

## 14. Design Review Checklist

- [ ] Top/parameter/define/RTL revision과 tool/library/constraint provenance가 있는가?
- [ ] Unresolved/black-box/latch/multiple-driver/removed-object warning을 검토했는가?
- [ ] Generic object, sequential bits와 mapped instances를 구분했는가?
- [ ] Memory/FSM/arithmetic/ICG의 실제 mapping을 확인했는가?
- [ ] Clock/I/O/unconstrained coverage와 empty collection을 확인했는가?
- [ ] Broad exception과 MCP setup/hold edge relationship을 검토했는가?
- [ ] Arrival/required와 setup/hold slack 부호·단위를 검산했는가?
- [ ] WNS/TNS의 scope와 endpoint/path 집계 방식을 기록했는가?
- [ ] Max fanout/slew/cap과 gating/reset-related checks를 별도로 봤는가?
- [ ] Mapped area와 physical footprint를 구분했는가?
- [ ] Power activity coverage, defaults, leakage/corner/clock 범위를 기록했는가?
- [ ] Netlist와 post-place/post-route evidence로 구조 가설을 확인했는가?
- [ ] 동일 조건 A/B ledger와 미실행 검증의 한계가 남아 있는가?

## 관련 문서

- [Ignoring Synthesis Result and Fanout](../14_anti_patterns/ignoring_synthesis_result_and_fanout.md): 예상과 다른 제거·mapping과 fanout를 다음 설계 판단에 반영하는 review pattern
- [RTL to Hardware Mapping](rtl_to_hardware_mapping.md)
- [Constant and Dead Logic](constant_dead_logic.md)
- [Critical Path](../03_timing/critical_path.md)
- [Physical Area and Congestion](../05_area/physical_area_and_congestion.md)
- [Fanout and Locality](../12_physical_aware/fanout_and_locality.md)
- [RTL to Post-Route Feedback](../12_physical_aware/rtl_to_post_route_feedback.md)
- [RTL Design Review Checklist](../15_checklist/rtl_design_review_checklist.md)
