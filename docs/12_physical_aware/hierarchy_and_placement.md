# Hierarchy and Placement

RTL hierarchy는 기능과 ownership를 나누는 유용한 경계다. 하지만 module 경계를 넘는 signal이 실제 chip의 어느 길을 지나고, cell이 어떤 region에 놓일지는 별도 문제다. Code에서 가까운 두 instance가 물리적으로도 가까운 것은 아니며, wrapper 하나를 추가한다고 timing budget이 한 cycle 늘어나지도 않는다.

이 문서는 logical hierarchy를 physical planning에 전달할 때 필요한 **interface cut, port 위치, macro affinity와 register boundary 계약**을 다룬다. Local load/replica의 정본은 [Fanout and Locality](fanout_and_locality.md), area/footprint는 [Physical Area and Congestion](../05_area/physical_area_and_congestion.md), pipeline 동작은 [Pipeline Design](../03_timing/pipeline.md)을 따른다.

## 1. 세 종류의 Boundary를 따로 그린다

| Boundary | 주된 목적 | 그 자체로 보장하지 않는 것 |
|---|---|---|
| Logical hierarchy | 기능 분해, interface와 ownership, reuse | Cell 좌표, route 길이, 추가 latency |
| Synthesis/optimization boundary | Compile 단위, cross-boundary 변환의 허용 범위 | 실제 physical partition이나 timing closure |
| Physical partition/region | 배치 범위, pin/boundary와 implementation 책임 | 올바른 protocol, CDC/reset/power 계약 |

```text
RTL ownership tree                 One possible physical arrangement

top                                +-----------------------------+
 +-- control                       | compute parts | control     |
 +-- compute                       |               | memory     |
 |    +-- arithmetic               | arithmetic ---+-- interface |
 |    +-- memory_wrapper           +-----------------------------+
 +-- interface

The tree is not a coordinate map.
```

Hierarchy 정보가 placer의 clustering에 활용될 수는 있다. 그렇더라도 실제 cell 위치와 route가 원하는 대로 나왔는지는 구현 결과로 확인한다. Synthesis에서 flatten, factoring 또는 replication이 일어나면 source instance와 mapped objects의 대응이 달라질 수도 있다.

## 2. Interface Cut: 경계를 넘는 정보의 목록

Physical partition을 제안할 때는 module 이름보다 경계를 넘는 communication을 먼저 적는다. 여기서 cut은 어떤 기능을 partition 안팎으로 나눴을 때 경계를 통과하는 연결 집합이다.

| Interface 항목 | 확인할 질문 | 배치·타이밍 의미 |
|---|---|---|
| Payload | 어느 방향으로 몇 bits가 이동하는가? | Pin 수, channel demand와 data route |
| Select/mode | Data와 같은 transaction인가? | Late control, decode와 control route |
| Valid/ready | 누가 acceptance를 결정하는가? | Forward/backward timing과 loop 가능성 |
| Tag/error/last | Payload와 같은 cycle에 필요한가? | Metadata skew와 width inventory |
| Clock/reset/test | 어떤 domain과 sequence인가? | 전용 distribution과 검증 책임 |
| Memory interface | Address/data/mask/response의 owner는 누구인가? | Macro affinity와 port-side routing |
| Debug/observation | 정상 mode 밖에서 무엇을 읽는가? | 숨은 cut nets와 preservation 요구 |

Bus width의 합은 초기 비교에 유용하지만 physical cost 그 자체는 아니다. Pin capacitance, 거리, layer, fanout와 bidirectional control을 함께 본다. 여러 cycle에 나누어 보내거나 local result만 보내는 구조 변경은 [Congestion-Aware Structure](congestion_aware_structure.md)의 기능·throughput 검토를 따른다.

Module 경계를 바꾸면서 내부 signal을 새 output port로 노출하면 standalone synthesis의 observability가 달라질 수 있다. 따라서 “포장만 바꿈”이라고 해도 top, 연결된 observer와 synthesis boundary를 동일하게 두고 비교해야 한다.

## 3. Port Location과 Macro Affinity

Physical block의 port가 어느 면에 있는지는 내부 logic과 외부 consumer 사이 route에 영향을 준다. Logical port declaration 순서가 최종 pin order를 보장하지 않는다.

```text
unfavorable interface cut          candidate aligned interface cut

external source --> [block]        external source --> [input side]
                     |                                  |
                far-side pins                      local processing
                     |                                  |
                long internal return               memory-facing pins --> macro
```

Macro affinity는 자주 통신하는 logic과 macro를 가깝게 둘 가설이다. Address generator, write-data preparation, read-data consumer 중 무엇이 어느 port와 가장 긴밀한지 구분한다. Macro의 pin 방향, orientation, legal location, channel, halo와 power access가 그 가설을 제한할 수 있다.

- Read response가 급한 consumer와 write path의 요구가 충돌하지 않는가?
- Control은 가까워져도 wide read-data가 더 먼 곳으로 돌아가지 않는가?
- 여러 macro가 하나의 central controller에 의존해 pin 주변이 막히지 않는가?
- Port 위치가 fixed 외부 interface나 상위 partition의 요구와 맞는가?
- Clock/reset/test와 power-grid 자원을 방해하지 않는가?

물리 위치나 pin constraint 변경은 RTL refactor의 자동 부수 작업이 아니다. Physical/integration owner에게 의도, 영향과 대안을 전달하고 승인된 implementation flow에서 적용한다.

!!! note "확인한 tool-specific 사례"
    OpenROAD의 [Hierarchical Macro Placement](https://openroad.readthedocs.io/en/latest/main/src/mpl/README.html)는 RTL hierarchy/data flow를 활용하는 planning과 macro guidance를 설명한다. [Pin Placer](https://openroad.readthedocs.io/en/latest/main/src/ppl/README.html)는 routing track 위 pin 위치와 region 제약을 별도로 다룬다. Hierarchy 정보와 실제 배치·pin 설정이 별개의 입력이라는 사례이며, 특정 placement 결과를 보장하거나 여기서 실행했다는 뜻은 아니다.

## 4. Combinational Wrapper는 Register Boundary가 아니다

아래는 wrapper와 optional registered link의 차이를 보여 주는 완결 예제다. 지원 범위는 `W >= 1`이다. Upstream과 downstream은 같은 clock domain이며 downstream은 매 cycle 수신 가능하다. 따라서 ready/backpressure는 없다. Valid가 0인 payload는 모든 consumer가 무시한다.

`REGISTER_LINK=0`은 data/valid를 조합으로 전달한다. `REGISTER_LINK=1`은 한 stage를 추가한다. 두 configuration은 같은 transaction 값을 전달하지만 **같은 cycle의 interface로 서로 바꿔 끼울 수 있는 등가 후보는 아니다**.

```systemverilog
module payload_boundary #(
  parameter int unsigned W = 8,
  parameter bit REGISTER_LINK = 1'b0
) (
  input  logic         clk,
  input  logic         rst_n,
  input  logic         in_valid,
  input  logic [W-1:0] in_data,
  output logic         out_valid,
  output logic [W-1:0] out_data
);
  generate
    if (REGISTER_LINK) begin : g_registered
      // Priority: asynchronous reset > valid advance and payload capture/hold.
      always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
          out_valid <= 1'b0;
          out_data  <= '0;
        end else begin
          out_valid <= in_valid;
          if (in_valid)
            out_data <= in_data;
        end
      end
    end else begin : g_combinational
      assign out_valid = rst_n && in_valid;
      assign out_data  = in_data;
    end
  endgenerate
endmodule
```

Reset assertion은 비동기이고 release는 해당 domain의 안전한 절차를 거친 입력이라고 가정한다. Reset 중 transfer는 없으며, registered link 안에서 아직 소비되지 않은 transaction은 reset으로 취소된다. Resetless payload가 가능한지의 판단은 [Resetless Datapath](../07_reset/resetless_datapath.md)에 맡기고, 여기서는 비교를 단순하게 하기 위해 registered payload도 reset한다.

### E0 Acceptance와 NBA, E1 Observation

Input은 edge 전에 충분히 안정된 값이다. 초기 reset이 끝나고 output register는 invalid인 상태에서 시작한다.

| Edge | Edge 직전 입력 | Combinational link: edge에서 소비 | Registered link: edge에서 소비 | Registered link: NBA 이후 |
|---|---|---|---|---|
| E0 | valid=1, A | A | 없음 | valid=1, A |
| E1 | valid=1, B | B | A | valid=1, B |
| E2 | valid=0 | 없음 | B | valid=0, payload B 유지 |
| E3 | valid=1, C | C | 없음 | valid=1, C |
| E4 | valid=0 | 없음 | C | valid=0, payload C 유지 |

```text
Input A is stable before E0

Combinational wrapper:
  E0 sample: A passes and is consumed; no new sequential stage

Registered link:
  E0 sample: accept A --> E0 NBA: publish A --> E1 sample: consume A
                        one added stage
```

Wrapper의 pure connection은 추가 clock cycle을 만들지 않는다. 그렇다고 wire/gate delay가 0이라는 뜻은 아니다. 이 예제의 reset qualification도 valid path의 조합 논리다. 기존 direct link와 wrapper를 비교할 때는 같은 reset/valid qualification을 유지한다.

Registered link의 clocked SVA는 E0 input에 대해 `|=>`로 E1 sample의 output을 검사한다. Combinational link는 같은 sample의 data/valid relation을 확인한다. Register 두 개를 거친 구조처럼 `##2`를 사용하면 이 예제의 one-stage 계약과 다르다.

## 5. Boundary Register의 Timing Budget

```text
Combinational partition cut:
  launch FF --> logic A --> [module port] --> wire --> logic B --> capture FF
                    one launch-to-capture timing path

Added register cut:
  launch FF --> logic A --> boundary FF --> wire/logic B --> capture FF
                          two state transitions; new external latency may result
```

Module port는 STA의 state boundary가 아니다. Hierarchical timing model이나 budget을 사용하더라도 실제 launch/capture contract를 정확히 반영해야 한다. “상위 block에 한 cycle, 하위 block에 한 cycle”을 각각 부여하고 원래 한-cycle path의 요구를 잊으면 잘못된 budget이 된다.

| 선택 | Timing 관점 | 기능/비용 관점 |
|---|---|---|
| Combinational wrapper | Path는 계속 이어짐; boundary 모델의 일관성 필요 | 새 state/latency 없음, ownership 개선 가능 |
| Source-side register | Source logic과 launch point를 정리할 후보 | Data/control 정렬, clock/reset load |
| Destination-side register | 긴 wire 뒤 capture point를 만들 후보 | Upstream path는 여전히 wire를 포함; 추가 latency 검토 |
| Elastic boundary | Data holding과 acceptance를 분리 가능 | Ready path, skid/FIFO capacity와 ordering |

“Boundary FF”라는 이름만으로 placement가 boundary 가까이에 고정되지는 않는다. Actual register 위치와 앞뒤 timing budget을 확인한다. Register를 단순히 입력 쪽에 모으면 wire가 긴 다음 stage가 계속 실패할 수도 있다.

Stall이 가능한 경우 위 예제처럼 valid를 매 cycle 덮어쓰면 안 된다. Holding storage, simultaneous consume/refill과 ready propagation은 [Buffering and Backpressure](../02_architecture/buffering_and_backpressure.md)의 계약을 따른다. Pipeline 추가와 MCP는 다르며, hierarchy를 나눈 사실은 [Multi-Cycle Path](../03_timing/multi_cycle_path.md)의 기능적 근거가 아니다.

## 6. Hard Boundary와 Preservation의 양면

Flattening 여부와 preservation의 강도를 하나의 “좋은 RTL 스타일”로 고정하지 않는다. Ownership/reuse 요구와 optimization freedom을 함께 검토한다. 각 tool의 정확한 attribute/option 의미는 공식 문서와 사용 flow에서 확인하며 generic RTL에 임의 directive를 넣지 않는다.

| 정책 후보 | 얻을 수 있는 것 | 잃을 수 있는 것 / 확인할 점 |
|---|---|---|
| Logical hierarchy만 유지 | 읽기 쉬운 ownership, flexible optimization | Instance 이름/경계가 mapping 뒤 달라질 수 있음 |
| Separate compile boundary | Reuse, incremental work와 책임 분리 | 바깥 constant/load/observer를 이용한 최적화 제한 |
| Strong preservation | 특정 구조·debug point 보호 | Constant propagation, sharing, sizing/retiming 등의 변환 제한 가능 |
| Hard physical partition | Interface와 implementation scope 명확 | Channel/pin 부담, floorplan 자유도 감소 |
| Flexible placement grouping | Locality 의도 전달과 이동 여지 | 기대한 위치가 유지되는지 결과 확인 필요 |

Hierarchy 보존, cell preservation과 physical fence는 서로 다른 정책이다. 하나를 적용했다고 다른 것도 생기거나 동일한 protection이 제공되는 것으로 가정하지 않는다. Preserve로 부작용이 생겼다면 전역 해제보다 정확한 대상과 보호 목적부터 검토한다.

Debug와 formal/synthesis cross-probe에 이름이 유용하다는 점은 실제 장점이다. 다만 naming convenience를 위해 큰 cone 전체를 고정하면 timing repair나 sharing 기회를 막을 수 있다. Mapping database나 interface-level check로 목적을 달성할 수 있는지도 비교한다.

## 7. Memory Inference와 Memory Placement는 다르다

RTL array가 memory macro로 mapping됐다는 report는 function과 resource 선택에 관한 증거다. 그 macro가 read consumer 가까이에 있고 pin access가 좋다는 증거는 아니다.

```text
RTL array + port/reset/latency pattern
                |
                v
inferred memory / chosen resource
                |
                v
physical macro: location, orientation, pins, halo, power and routing
```

| 확인 단계 | 질문 |
|---|---|
| Function/inference | Port, latency, collision, mask와 reset이 target memory와 맞는가? |
| Mapping | 실제 memory macro인가, FF bank fallback인가? |
| Placement | Legal region, orientation와 pin 면이 producer/consumer에 맞는가? |
| Routing/timing | Address/control/read-data 경로와 주변 channel이 성립하는가? |
| Power/test | Power access, test wrapper와 clock/reset가 유지되는가? |

Macro 수가 같아도 memory placement가 달라지면 주변 logic과 route가 달라질 수 있다. 반대로 가까운 자리에 macro를 놓기 위해 memory latency나 interface를 몰래 바꾸면 안 된다. Memory 기능 정본은 [Memory and Register Array](../05_area/memory_and_register_array.md)다.

## 8. Locality보다 먼저 지켜야 할 Domain Boundary

Clock/reset/power/CDC 경계는 floorplan 편의를 위해 무시할 수 없다.

- 같은 root clock이라고 두 region의 clock-stop, phase와 capture 관계가 항상 같지는 않다.
- Reset domain이 다르면 assertion/release와 stale output의 관찰 시점이 달라질 수 있다.
- Power domain 이동은 isolation, retention, level conversion과 always-on control의 책임을 동반할 수 있다.
- Wake controller를 자신이 깨워야 할 gated region 안으로 옮기면 진행이 막힐 수 있다.
- Synchronizer first stage를 일반 interface register로 옮기거나 복제하지 않는다.
- Debug/test mode의 clock와 observation path도 partition cut에 포함한다.

CDC의 sampling/coherency는 [CDC Overview](../08_cdc/overview.md), reset release는 [Reset Deassertion and RDC](../07_reset/reset_deassertion.md), wake ownership는 [Root Clock vs Function Clock](../06_clock/root_vs_function_clock.md)를 따른다. Domain crossing이 필요한 interface에는 이 문서의 단순 payload link를 사용하지 않는다.

## 9. Timing, Power, Area Trade-off

잘 나눈 hierarchy는 source와 sink의 책임을 명확히 하고 locality 실험을 쉽게 할 수 있다. 그러나 splitting 자체가 PPA 개선은 아니다.

| 변화 | 가능한 이득 | 새 비용과 실패 원인 |
|---|---|---|
| Interface cut 정리 | 불필요한 global communication 식별 | Required observer를 빠뜨리면 기능 손실 |
| Macro-adjacent processing | 짧은 address/data route 가능 | 다른 consumer가 멀어지고 pin 주변 혼잡 증가 |
| Boundary register | Timing stage 분할 가능 | Latency, clock/reset power, hold와 verification 비용 |
| Hard partition | 병렬 implementation와 ownership | Pin/channel bottleneck, 제한된 optimization |
| Flattening 확대 | Cross-boundary constant/sharing 기회 | Debug 대응, compile 규모와 locality 의도 손실 가능 |

Timing은 boundary 전후 data/control path와 hold를 함께 본다. Power는 추가 FF/clock뿐 아니라 interface switching과 distribution cost를 포함한다. Area는 mapped cell만이 아니라 pin/channel 여유와 physical footprint를 확인한다. Locality와 control 복제의 자세한 비용은 [Fanout and Locality](fanout_and_locality.md)를 참고한다.

## 10. 적용 금지 조건과 Common Mistakes

다음은 별도 architecture 또는 implementation 검토 없이 적용하면 안 된다.

- “Module 경계마다 register 하나”를 기계적으로 추가해 latency/feedback를 바꾸는 수정
- Ready/valid interface에서 data만 register하고 ready capacity를 그대로 두는 수정
- Macro에 가깝게 두려고 clock/reset/power owner를 변경하는 수정
- Strong preservation을 기능 등가나 물리 placement proof의 대체물로 사용하는 방법
- Memory inference 성공을 legal macro placement와 routed timing 성공으로 보고하는 방법

또 다른 흔한 실수는 port 이름/선언 순서를 physical pin 위치로 읽는 것, combinational wrapper를 timing stage로 세는 것, standalone과 integrated netlist의 observer 차이를 무시하는 것이다. Hierarchy 변경 뒤 constraint의 object pattern이 비거나 너무 넓게 match되는 경우도 확인한다.

## 11. Verification과 Handoff

검증 범위는 변경의 종류에 맞춘다.

| 변경 종류 | 기능 검증 | 구현 검증 |
|---|---|---|
| Pure wrapper/repartition, state 유지 | 같은-cycle interface/trace equivalence, port connectivity | 실제 mapping boundary와 constraint target |
| Added register | Latency-aware scoreboard, data/valid/tag, reset/flush | Sequential inventory, clock/hold와 placement |
| Ready/valid boundary | No drop/duplicate/order, stalls와 refill | Backward ready path, storage와 control timing |
| Macro affinity/pin plan | Memory/protocol contract 유지 | 좌표/orientation/pin access와 routed paths |

`payload_boundary` 예제는 W=1과 일반 width, 연속 valid, bubble과 reset 중 미소비 transaction 취소를 확인한다. 두 configuration을 같은 cycle의 값으로 비교해 failure가 나오는 것은 예상된 latency 차이일 수 있다. 반대로 valid transaction 순서만 맞는다고 fixed-latency 요구가 만족되는 것도 아니다.

Handoff에는 proposed cut, boundary별 clock/reset/power owner, data/control width, acceptance/capture edge, port/macro affinity와 변경 승인 범위를 담는다. 실제 cell 위치와 report를 얻은 뒤 가설을 확인하거나 수정한다. Evidence 기록은 [Microarchitecture Decision Record](../02_architecture/microarchitecture_decision_record.md), 반복 절차는 [RTL to Post-Route Feedback](rtl_to_post_route_feedback.md)을 따른다.

## 12. Design Review Checklist

- [ ] Logical, synthesis/optimization, physical boundary를 구분했는가?
- [ ] Payload뿐 아니라 ready/select/tag/reset/test/debug까지 interface cut에 포함했는가?
- [ ] Port 선언과 physical pin 위치를 혼동하지 않는가?
- [ ] Macro affinity를 실제 port 방향·consumer 경로와 비교했는가?
- [ ] Combinational wrapper가 새 cycle budget을 주지 않음을 반영했는가?
- [ ] Register 추가 시 edge/NBA/observation과 metadata latency를 갱신했는가?
- [ ] Stall 가능한 boundary에 필요한 holding/skid capacity가 있는가?
- [ ] Preservation/hard partition의 대상·ownership 이득과 optimization 비용을 설명할 수 있는가?
- [ ] Memory inference와 macro placement 증거를 분리했는가?
- [ ] Clock/reset/power/CDC/wake 경계를 유지했는가?
- [ ] Hierarchy 변경 뒤 constraint collection과 netlist cross-probe가 유효한가?
- [ ] Physical plan 변경 owner/승인과 검증 한계를 handoff에 남겼는가?

## 관련 문서

- [Fanout and Locality](fanout_and_locality.md)
- [Congestion-Aware Structure](congestion_aware_structure.md)
- [RTL to Post-Route Feedback](rtl_to_post_route_feedback.md)
- [Pipeline Design](../03_timing/pipeline.md)
- [Memory and Register Array](../05_area/memory_and_register_array.md)
- [Microarchitecture Decision Record](../02_architecture/microarchitecture_decision_record.md)
- [RTL Design Review Checklist](../15_checklist/rtl_design_review_checklist.md)
