# RTL to Post-Route Feedback

RTL 최적화는 source를 바꾼 순간 완료되지 않는다. 예상한 구조가 합성에서 살아남았는지, placement에서 가까워졌는지, CTS 뒤 clock 관계와 hold가 유지되는지, route 후에도 이득이 남는지를 확인해야 한다. 결과가 예상과 다르면 숫자를 정당화하기보다 **처음 가설의 어느 부분이 틀렸는지** 찾아야 한다.

이 문서는 RTL hypothesis를 implementation evidence와 연결해 다음 변경의 owner, 승인 범위와 regression을 결정하는 절차다. Report provenance, STA arithmetic와 coverage 해석은 [Reading Synthesis Reports](../11_synthesis/read_synthesis_reports.md)가 정본이다. 여기서는 그 report를 반복 설명하지 않고, 단계별 증거를 어떻게 행동으로 연결할지에 집중한다.

## 1. 먼저 반증 가능한 Hypothesis를 쓴다

“PPA를 개선한다”는 실험 가설로 너무 넓다. 어떤 path/region이 문제이며 어떤 구조 변화로 왜 나아질 것으로 보는지 적는다.

```text
Observation:
  selected data path appears wire-dominated near a shared merge region

Hypothesis:
  moving a pure local operation before selection may reduce a long shared cone

Invariants:
  same accepted transactions, values, reset/valid behavior, latency and II

Required evidence:
  changed mapped topology -> intended placement/routes -> improved target paths
  no unacceptable hold, congestion, power or protocol regression

Rejection trigger:
  synthesis restores the original topology, or implementation cost outweighs benefit
```

Hypothesis에는 expected direction과 rejection condition이 있어야 한다. RTL text가 달라졌다는 사실만으로 구현 가설이 성립하지 않는다. 반대로 synthesis가 두 후보를 같은 구조로 만들었다면 “실험 실패”라는 말보다 **이 RTL 차이는 해당 flow에서 독립적인 물리 후보가 되지 않았다**고 기록하는 편이 정확하다.

## 2. 단계마다 묻는 질문이 다르다

| 단계 | 핵심 질문 | 다음 단계에 넘길 증거 | 아직 남는 불확실성 |
|---|---|---|---|
| RTL/architecture | 무엇을 언제 계산·전달하는가? | Function/cycle contract, change scope와 reference model | 실제 mapping/physical 결과 |
| Synthesis | 의도한 구조가 남았는가? | Operator/MUX/state/macro, constant/removal, mapped cone | 실제 위치, route RC와 clock tree |
| Placement | Cell과 macro가 가설대로 연결 가능한가? | 위치, region crossing, estimated wire/load/congestion | Detailed pin access, routed detour와 clock skew |
| CTS | 실제 clock distribution이 path 관계를 어떻게 바꿨는가? | Propagated clock arrival/skew, gating와 new load, setup/hold | 최종 data/clock route와 extraction |
| Route/extraction | 실제 배선 후에도 후보가 유효한가? | Routed RC, connectivity/DRC, slew/cap, setup/hold와 power coverage | 미분석 modes/corners와 별도 sign-off 항목 |

```text
RTL hypothesis --> synthesis --> placement --> CTS --> route / extraction
      ^                 |            |          |             |
      |                 +------------+----------+-------------+
      |                              |
      +---- updated hypothesis <-- evidence + root cause + owner review
```

앞 단계의 결과는 뒤 단계의 보장이 아니다. 하지만 앞 단계에서 이미 기능이나 구조가 틀렸다면 expensive full-route 실험을 계속할 이유도 줄어든다. Verification/coverage가 명백히 깨진 후보는 먼저 수정하고 비교 조건을 다시 고정한다.

## 3. 작은 Generic RTL Experiment

아래는 select 후 mask와 mask 후 select를 비교하는 조합 module이다. `W >= 1`, 모든 입력은 같은 synchronous domain의 known binary data/control이며 side effect가 없다. Mask는 bitwise AND이고 numeric narrowing이나 signed arithmetic을 포함하지 않는다.

```systemverilog
module mask_select_candidate #(
  parameter int unsigned W = 8,
  parameter bit MASK_FIRST = 1'b0
) (
  input  logic [W-1:0] data_a,
  input  logic [W-1:0] data_b,
  input  logic [W-1:0] mask,
  input  logic         select_b,
  output logic [W-1:0] result
);
  generate
    if (MASK_FIRST) begin : g_mask_first
      logic [W-1:0] masked_a, masked_b;
      assign masked_a = data_a & mask;
      assign masked_b = data_b & mask;
      assign result = select_b ? masked_b : masked_a;
    end else begin : g_select_first
      logic [W-1:0] selected;
      assign selected = select_b ? data_b : data_a;
      assign result = selected & mask;
    end
  endgenerate
endmodule
```

```text
MASK_FIRST=0                         MASK_FIRST=1

data_a --+                           data_a --> AND(mask) --+
         MUX --> AND(mask) --> y                            MUX --> y
data_b --+                           data_b --> AND(mask) --+
         ^                                                 ^
       select_b                                          select_b
```

이것은 “mask-first가 더 빠르다”는 권장 코드가 아니라 실험 대상을 작게 만든 예다. Mask-first는 select 이후의 logic을 줄일 가설이 있지만 mask의 load와 AND cone 수가 늘 수 있다. Tool이 두 표현을 같은 구조로 정규화하거나 다른 cell에 흡수할 수도 있다. 먼저 mapped cone을 확인한 뒤 physical 실험의 의미를 판단한다. Select/연산 배치의 원리는 [Datapath MUX and Select](../10_datapath/mux_and_select.md)를 따른다.

### Function와 Cycle을 고정한다

Known binary 입력에서 `(select_b ? data_b : data_a) & mask`와 `select_b ? (data_b & mask) : (data_a & mask)`는 bit별로 동일하다. 이 module에는 FF, reset, valid 또는 handshake가 없다. 주변의 기존 capture stage와 interface 계약은 두 실험에서 그대로 유지해야 한다.

다음은 **동일한 외부 capture FF를 둔 test context**다. Module 안에 hidden register가 있다는 뜻이 아니다. Data/control은 capture edge 전에 안정되고, reset/invalid 중 observer는 capture 결과를 사용하지 않는다.

| Capture edge | Edge 직전 값, W=4 | 두 후보의 조합 result | 기존 capture FF의 NBA 이후 |
|---|---|---|---|
| E0 | a=1010, b=0101, mask=0011, select_b=0 | 0010 | Q=0010 |
| E1 | a=1010, b=0101, mask=0011, select_b=1 | 0001 | Q=0001 |
| E2 | a/b는 known 값, mask=0000 | 0000 | Q=0000 |

```text
inputs A settle before E0 --> E0 capture --> E0 NBA: Q(A)
                                                   |
                                                   +--> E1 pre-edge observer sees Q(A)

Both candidates use the same existing capture FF; no stage is added.
```

Function equality는 gate glitch waveform이나 physical delay equality가 아니다. Mask와 select의 transition에 따라 internal activity가 달라질 수 있다. Delay를 줄이겠다고 별도 register를 추가하면 이 실험의 고정 조건을 벗어나므로 [Pipeline Design](../03_timing/pipeline.md)의 새 architecture 후보로 분리한다.

## 4. Baseline과 Experiment Boundary를 고정한다

Report의 개별 필드는 정본에 맡기되, A/B에서 무엇을 고정했는지를 한 줄씩 기록한다.

| 고정할 조건 | 실험에서 달라질 수 있는 것 | 섞이면 안 되는 변경 |
|---|---|---|
| Functional/cycle contract | 순수 등가 RTL 구조 | Latency/II, reset, numeric policy 변경 |
| Build identity | 명시한 candidate diff | Top/parameter/define 또는 live output 차이 |
| Target/model | 같은 library, constraints, corner/mode | 다른 clock budget, 누락된 exception target |
| Physical comparison scope | 후보 때문에 생기는 placement/route 차이 | Floorplan/layer 제한을 동시에 임의 완화 |
| Activity | 같은 workload와 비교 가능한 observation window | Annotation 누락이나 처리량 감소를 절감으로 해석 |
| Search conditions | 기록된 tool/effort/seed 정책 | 다른 run 설정을 candidate 효과로 해석 |

Wrapper, queue, clock/reset/control과 required debug를 포함한 동일 boundary로 비교한다. 개별 cone만의 실험은 원인 분리에 유용하지만 전체 block의 PPA 개선으로 확대해 보고하지 않는다.

Baseline의 netlist, constraint와 report identity를 보존해 재현 가능하게 만든다. 실패한 candidate를 없애고 가장 좋은 숫자만 남기면 seed sensitivity와 rejected alternative의 이유를 추적할 수 없다. 보관 형식은 [Microarchitecture Decision Record](../02_architecture/microarchitecture_decision_record.md)를 따른다.

## 5. Stage-to-Stage 악화의 원인을 분류한다

| 관찰한 변화 | 첫 가설 | 확인할 증거 | 주된 변경 owner 후보 |
|---|---|---|---|
| RTL 변경 뒤 mapped 구조가 동일 | Canonicalization/merging | 실제 cell cone과 mapping 기록 | RTL + synthesis flow |
| 합성은 개선, placement에서 악화 | Locality/cut 또는 source load | 위치, critical branch와 estimated route | RTL architecture + physical |
| CTS 뒤 hold가 새로 실패 | Clock arrival/skew와 min path 변화 | Launch/capture clock paths, hold endpoints | Clock/physical + timing |
| Detailed route 후 delay 급증 | Detour, layer/via, coupling 또는 load | Extracted RC와 실제 route, cell/net 분해 | Physical + timing |
| Area가 줄었는데 DRC 증가 | Pin/channel 압력 집중 | Local congestion와 rule별 markers | Physical + RTL topology |
| Power만 비정상적으로 감소 | Activity/clock/model coverage 차이 | Annotation mapping, workload와 clock/macro 범위 | Power analysis + verification |
| Timed endpoints도 함께 감소 | Removed output/constraint 누락 | Connectivity와 resolved collections | Integration + constraints |

이 표는 owner를 자동 지정하는 조직 규칙이 아니다. 프로젝트에서 해당 artifact에 책임 있는 역할과 함께 조사한다. 여러 원인이 겹치면 먼저 functional/coverage 문제를 해결한 뒤 PPA 원인을 분리한다.

## 6. Routed RC와 Clock Evidence를 같은 Run에 연결한다

Post-route feedback에서는 routed netlist, parasitic, clock propagation과 constraint가 서로 맞아야 한다. 다른 revision의 이름을 사용하는 parasitic이 일부만 annotation되면 완성된 파일이 존재해도 올바른 분석이 아닐 수 있다.

- Wire resistance, ground/coupling capacitance가 어떤 routed geometry/model에서 나왔는가?
- Annotation되지 않은 nets와 default/estimated parasitic 사용 범위가 있는가?
- CTS 이후의 실제 clock topology와 launch/capture arrival가 반영됐는가?
- Data뿐 아니라 select/enable/ready, clock gating과 reset-related checks를 포함했는가?
- Setup 개선이 short path의 hold 또는 max slew/cap를 악화시키지 않았는가?
- DRC/connectivity 검증과 timing 검증을 각각 통과했는가?
- Power는 routed load와 같은 workload의 activity coverage를 사용했는가?

Delay 구성과 slack 산술을 다시 정의하지 않고 [Reading Synthesis Reports](../11_synthesis/read_synthesis_reports.md)와 [Critical Path](../03_timing/critical_path.md)의 해석을 사용한다. Clock skew와 uncertainty를 report에 반영한 뒤 또 수기로 더해 비교하지 않는다.

!!! note "확인한 tool-specific 사례"
    OpenROAD의 공식 [Parasitics Extraction](https://openroad.readthedocs.io/en/latest/main/src/rcx/README.html)은 routed design과 extraction rules를 사용한 wire R/C 추출, coupling/ground capacitance와 SPEF 산출을 설명한다. 이는 post-route evidence의 구체적 예이며, 추출 파일 하나가 모든 sign-off 검증을 대신한다는 뜻은 아니다. 이 문서에서 추출·STA를 실행하거나 실제 값을 측정하지 않았다.

## 7. 가상 A/B 사례: WNS 개선만으로 채택할 수 없다

다음 숫자는 모두 **illustrative/fabricated**다. 실제 vendor report 형식이나 실행 결과가 아니다. 동일한 조건의 가상 후보를 읽는 연습이며, A도 timing closure가 끝난 설계가 아니다.

이 작은 예에서 setup endpoint는 payload와 control 두 개뿐이라고 가정하고 endpoint별 worst slack 하나를 집계한다. 실제 설계의 endpoint 수나 tool별 집계 규칙을 대체하지 않는다.

| 항목 | Baseline A | Candidate B | 해석 |
|---|---:|---:|---|
| Payload setup slack | -0.08 ns | +0.03 ns | Target path는 0.11 ns 개선 |
| Control setup slack | +0.04 ns | -0.02 ns | Control이 새 worst path가 됨 |
| 이 예의 setup WNS | -0.08 ns | -0.02 ns | 0.06 ns 개선됐지만 여전히 실패 |
| 이 예의 setup TNS | -0.08 ns | -0.02 ns | 각 후보의 negative endpoint 하나를 합산 |
| Worst hold slack | +0.05 ns | -0.01 ns | 새 hold failure |
| Mapped area, A=100으로 정규화 | 100 | 96 | 동일 범위라면 4% 감소 |
| Detailed-route DRC count, 같은 rule scope | 0 | 4 | Routing regression 조사 필요 |
| Power/model coverage | 미확인 | 미확인 | Power 개선 판단 불가 |

B의 payload path 개선은 의미가 있지만 candidate 전체를 채택할 충분조건이 아니다. Setup critical path migration, hold와 route failure를 해결하거나 비용을 재평가해야 한다. Area 4% 감소를 얻었다고 다른 required check를 생략하지 않는다. A도 실패가 있으므로 “B를 기각했다”와 “A가 최종 승인됐다”는 별개다.

WNS/TNS 집계와 coverage 자체의 의미는 정본에 설명돼 있다. 여기서 얻을 교훈은 **원래 target path와 전체 설계의 acceptance criteria를 동시에 유지해야 한다**는 것이다.

## 8. Seed 변동과 Critical Path Migration

Placement/routing은 구현 탐색 조건에 민감할 수 있다. 같은 candidate라도 seed, tie-breaking, tool/version, parallel execution이나 flow 설정에 따라 결과가 달라질 수 있으므로 실제 flow의 재현성을 확인한다. 동일 seed라고 서로 다른 netlist의 cell 위치가 그대로 대응하는 것도 아니다.

작은 개선이 탐색 변동보다 안정적인지 알고 싶다면 같은 설정 정책의 여러 run을 비교하고 분포를 기록한다. 예를 들어 동일한 seed 집합으로 A/B를 반복하되, 각 run의 worst value뿐 아니라 failure rate, margin 범위와 outlier 원인을 본다. 특정 seed 하나의 가장 좋은 결과만 골라 비교하지 않는다. 반복 횟수나 universal 유의성 threshold는 정하지 않는다.

| 변화 | Architecture effect일 가능성 | 추가 조사 |
|---|---|---|
| 여러 run에서 같은 cone/route pattern 개선 | 구조 가설을 지지하는 증거 | 다른 mode/corner와 regression |
| 개선 크기가 run 간 변동과 비슷함 | 결론 불확실 | 반복/원인 분해, 구현 조건 고정 |
| Payload 개선 뒤 control이 worst | Critical path migration 가능 | 새 병목과 주변 distribution |
| Path 수가 줄고 slack만 좋아짐 | Coverage/config 변화 가능 | Unconstrained/exception/removed outputs |
| 한 run만 큰 route/DRC 차이 | Local minimum 또는 설정 차이 가능 | Hotspot, pin access와 run provenance |

Critical path가 바뀌었다는 사실 자체는 오류가 아니다. 원래 병목이 개선되면 다음 경로가 드러난다. 다만 여러 path group과 min/max checks를 보지 않으면 local optimization을 global closure로 착각하게 된다.

## 9. 원인 → Owner → 승인 → 회귀 Loop

원인이 무엇인지에 따라 바꿔야 할 artifact와 권한이 달라진다. RTL task가 physical 설정, exception이나 interface 요구를 조용히 바꾸지 않도록 경계를 명시한다.

| 제안 변경 | 먼저 합의할 것 | 필수 regression의 예 |
|---|---|---|
| Pure RTL restructuring | 기능/latency/II 불변과 변경 scope | Equivalence, reset/mode, mapping 확인 |
| Pipeline/buffering/serialization | Interface latency, acceptance, ordering와 capacity | Scoreboard, stalls/flush, upstream/downstream 통합 |
| Floorplan/pin/macro 위치 | Physical/integration owner의 영향·승인 | Congestion/DRC, routed timing과 power 경계 |
| Clock/reset/power partition | Domain/sequence owner와 안전성 요구 | CDC/RDC, wake/reset/test와 clock checks |
| Constraint/exception 수정 | Specification 근거, 정확한 targets와 timing owner 승인 | Coverage, setup/hold edge, empty/broad collection |
| Library/flow 설정 변경 | 비교 조건 변경이라는 사실과 적용 범위 | 별도 baseline, 지원 resource와 전체 검증 |

```text
observe difference
       |
       v
confirm configuration / coverage / functional invariants
       |
       v
isolate cause --> identify artifact and owner --> review impact and approval
                                                        |
                                                        v
                                                scoped change / experiment
                                                        |
                                                        v
                                              regression + physical evidence
                                                        |
                                      accept / reject / refine hypothesis
```

Timing exception은 위반을 숨기기 위한 실험 knob가 아니다. [Multi-Cycle Path](../03_timing/multi_cycle_path.md)의 실제 capture contract가 있어야 한다. 승인되지 않은 clock-period 완화나 output 제거로 좋은 숫자를 만들면 같은 문제를 해결한 것이 아니다.

## 10. PPA Trade-off와 중단 조건

Feedback loop의 목적은 모든 metric을 무조건 줄이는 것이 아니라 requirement를 만족하는 구현을 고르는 것이다. 선택한 trade-off와 남은 위험을 명시한다.

- Timing 개선 때문에 operator/FF/clock load가 늘었다면 power/area를 같이 측정한다.
- Area 감소 때문에 congestion, buffer/hold repair가 늘면 routed total cost를 확인한다.
- Power 감소가 throughput/활성 시간 감소 때문이면 동등한 처리 조건과 energy도 비교한다.
- Locality 개선을 위해 boundary를 바꾸면 [Hierarchy and Placement](hierarchy_and_placement.md)의 interface/domain audit를 수행한다.
- Congestion 개선 주장은 [Congestion-Aware Structure](congestion_aware_structure.md)의 global/detailed 증거를 구분한다.

다음 상황에서는 채택 판단을 중단한다. 원인을 조사하는 일까지 멈추라는 뜻은 아니다.

- Functional equivalence 또는 required cycle/protocol 검증이 실패했다.
- Critical clock/constraint/activity/parasitic coverage가 누락됐다.
- Intended topology가 생기지 않았는데 physical benefit을 source diff만으로 주장한다.
- Candidate가 required mode/corner에서 실패하고 해결 계획이 없다.
- Baseline과 설정이 달라 어느 변경의 효과인지 분리할 수 없다.
- 권한 밖의 interface, domain, physical 또는 constraint 변경이 필요하다.

## 11. Common Mistakes

- RTL operator 수 감소를 routed PPA 개선으로 곧바로 보고한다.
- Synthesis/post-place 결과를 post-route closure와 같은 확실성으로 표현한다.
- Target path 하나만 보고 새 critical path나 hold를 놓친다.
- Clock tree가 바뀌었는데 data path만의 변화로 설명한다.
- Parasitic/activity 파일이 있다는 이유로 annotation coverage를 확인하지 않는다.
- Best seed만 남기고 실패 run과 설정 차이를 버린다.
- DRC clean, electrical limits, timing, logical equivalence를 같은 check로 취급한다.
- 실제 tool 실행 없이 식 모델이나 가상 숫자를 측정 결과처럼 작성한다.

## 12. Verification과 Handoff Checklist

작은 mask/select 예제는 W=1과 일반 width, select 두 값, zero/all-one/walking-one mask로 식 equality를 확인할 수 있다. Clocked 환경에서는 기존 capture FF, valid/reset와 sampling edge를 고정하고 전후 output trace를 비교한다. 이 식 검산은 실제 compile/simulation, mapping 또는 route 실행의 대체물이 아니다.

Handoff는 다음 질문에 답할 수 있어야 한다.

- [ ] 문제 path/region과 반증 가능한 RTL hypothesis가 있는가?
- [ ] 기능/latency/II/reset/observer invariants가 고정됐는가?
- [ ] 합성에서 실제 구현 후보가 달라졌는지 확인했는가?
- [ ] Placement, CTS, routed RC의 증거와 불확실성을 구분했는가?
- [ ] Coverage/config 변화와 실제 PPA 변화를 분리했는가?
- [ ] Setup/hold, slew/cap, DRC/connectivity와 power coverage를 별도로 봤는가?
- [ ] Target path와 새 critical paths의 migration을 추적했는가?
- [ ] Seed/run variation을 숨기지 않고 비교 조건을 기록했는가?
- [ ] 다음 변경의 artifact owner와 승인 범위가 명확한가?
- [ ] Candidate 채택/기각 이유와 추가 regression이 연결됐는가?
- [ ] 미실행 tool/check와 남은 modes/corners를 명시했는가?
- [ ] RTL/constraints/netlist/reports와 decision record의 revision이 맞는가?

판단 결과는 [Microarchitecture Decision Record](../02_architecture/microarchitecture_decision_record.md)에 남긴다. “좋아짐” 한 줄보다 **어떤 조건에서 무엇이 개선됐고, 무엇은 아직 검증되지 않았는지**를 남기는 것이 다음 RTL 변경에 더 유용하다.

## 관련 문서

- [Reading Synthesis Reports](../11_synthesis/read_synthesis_reports.md)
- [Fanout and Locality](fanout_and_locality.md)
- [Congestion-Aware Structure](congestion_aware_structure.md)
- [Hierarchy and Placement](hierarchy_and_placement.md)
- [Critical Path](../03_timing/critical_path.md)
- [Microarchitecture Decision Record](../02_architecture/microarchitecture_decision_record.md)
- [RTL Design Review Checklist](../15_checklist/rtl_design_review_checklist.md)
