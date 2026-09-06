# Congestion-Aware Structure

작은 논리 회로가 반드시 배선하기 쉬운 회로는 아니다. 여러 region의 넓은 bus를 중앙 MUX로 모으면 operator 수가 적어도 특정 channel과 pin 주변의 연결 요구가 커질 수 있다. RTL designer가 검토할 질문은 “cell을 몇 개 줄였는가?”뿐 아니라 **어떤 정보가 어디에서 어디로 이동해야 하는가?**다.

이 문서는 communication topology를 바꿔 routing pressure를 줄이는 판단을 다룬다. Cell area, footprint와 utilization의 정의는 [Physical Area and Congestion](../05_area/physical_area_and_congestion.md), 개별 net의 load/geometry와 복제 위험은 [Fanout and Locality](fanout_and_locality.md)가 정본이다. 여기서는 그 내용을 반복하기보다 서로 다른 topology가 같은 기능을 보존하는지와 실제 routability evidence를 연결한다.

## 1. Congestion은 공간과 Layer에 걸친 수요·용량 문제다

Routing demand는 해당 위치와 layer를 통과하려는 연결 요구이고, routing capacity는 그 모델에서 사용할 수 있다고 보는 자원이다. Demand를 논리 net 수 하나로, capacity를 빈 placement area 하나로 대체할 수 없다.

```text
producer A ========\             /======== consumer A
producer B ========= central MUX ========= consumer B
producer C ========/  [hotspot]   \======== consumer C
                        |
                  narrow channel
             macro wall | macro wall
```

위 그림의 굵은 연결은 넓은 bus를 뜻한다. Hotspot은 반드시 중앙 cell 자체에만 있지 않다. Bus가 모이는 channel, macro corner, layer를 바꾸는 via 주변이나 MUX input pin 접근 지점에 생길 수 있다.

| 관점 | 의미 | RTL/physical review에서 볼 것 |
|---|---|---|
| Spatial demand | 특정 region/channel을 통과하는 연결 집중 | Producer/consumer 위치, crossing bus와 central merge |
| Layer capacity | Layer별 사용 가능한 track과 방향·제약 | Blockage, 사용 layer, clock/power 예약과 routing model |
| Via demand | Layer 사이 이동에 필요한 연결 | Via access, local spacing와 layer 전환 집중 |
| Pin access | Cell/macro pin까지 legal하게 도달할 수 있는가 | Pin 밀도, orientation, 접근 track와 주변 obstruction |
| Detailed routability | 실제 wire/via shape가 규칙을 만족하는가 | Connectivity, opens/shorts와 detailed-route DRC |

Global routing의 coarse grid에서 demand가 capacity를 초과하는 양을 overflow로 보고할 수 있다. 그러나 정확한 집계 단위와 포함 layer/net은 flow별로 확인한다. 어떤 net을 제외했는지, capacity를 어떤 제약으로 추정했는지도 결과의 일부다.

## 2. 평균 Utilization과 Zero Overflow의 한계

평균 utilization이 낮아도 작은 pin-dense 영역은 막힐 수 있다. 반대로 높은 평균 utilization만으로 특정 local path가 실패한다고 확정할 수는 없다. Area density와 routing density는 관련되지만 서로 다른 지표다.

| 관찰 | 말할 수 있는 것 | 아직 말할 수 없는 것 |
|---|---|---|
| 낮은 평균 utilization | 평균적으로 cell을 놓을 여유가 있을 수 있음 | 모든 channel/pin에 배선 여유가 있음 |
| Global overflow 감소 | 같은 모델에서 congestion 추정이 개선됨 | Detailed route가 반드시 성공함 |
| Global overflow=0 | 그 실행의 modeled routing demand가 수용됨 | Pin access, via/spacing와 detailed DRC가 모두 clean |
| Detailed routing 완료 | 해당 flow가 route 산출물을 만듦 | 모든 sign-off rule, 연결, timing/power까지 통과 |
| Detailed DRC clean | 검사한 rule set과 scope의 위반 없음 | 다른 검증 도구·규칙·corner도 자동 통과 |

Routability는 단일 색상 heatmap의 pass/fail로 끝나지 않는다. Heatmap에서 좋아진 영역과 나빠진 영역, 미분석 net, 실제 route/DRC 결과를 함께 확인한다. 혼잡이 한 region에서 다른 region으로 이동했을 수도 있다.

!!! note "확인한 tool-specific 사례"
    OpenROAD의 공식 [Global Routing](https://openroad.readthedocs.io/en/latest/main/src/grt/README.html)은 layer/region의 routing resource 모델을 다루며, [Detailed Routing](https://openroad.readthedocs.io/en/latest/main/src/drt/README.html)은 pin access, track assignment와 DRC를 별도 구성 요소로 설명한다. 두 단계의 증거를 구분하는 사례이지, 모든 router의 metric이 같다는 뜻은 아니다. 이 문서에서 routing을 실행한 것은 아니다.

## 3. 무엇을 보내야 하는지부터 다시 묻는다

Consumer가 전체 payload를 필요로 하면 width를 임의로 줄일 수 없다. 그러나 필요한 정보가 predicate, selected field 또는 최종 계산 결과뿐이라면 raw data 전체를 먼 곳으로 보내는 구조가 필수는 아닐 수 있다.

```text
Raw-data collection                     Local result collection

region 0: data[W] -----+                 region 0: data[W] -> f -> result[R] --+
region 1: data[W] -----+-> MUX -> f      region 1: data[W] -> f -> result[R] --+-> MUX
region 2: data[W] -----+                 region 2: data[W] -> f -> result[R] --+
region 3: data[W] -----+                 region 3: data[W] -> f -> result[R] --+
```

`R < W`이면 candidate communication 폭을 줄일 가설이 생긴다. 하지만 `f`가 네 곳으로 늘고 모두 switching할 수 있다. `R`이 W보다 크거나 raw data도 별도 observer가 필요로 하면 이 방식의 매력이 줄어든다. Select arrival와 operator 배치의 일반 판단은 [Datapath MUX and Select](../10_datapath/mux_and_select.md), [Datapath Parallel Pre-computation](../10_datapath/parallel_precomputation.md)을 참고한다.

또 다른 후보는 source region 안에서 여러 local data 중 하나를 선택한 뒤 selected payload만 보내는 것이다. 이 경우에도 select가 source에 제시간에 도착하는지, 다른 consumer가 같은 cycle에 다른 값을 요구하는지 확인한다. 중앙 select를 분산하면 control 배선이 늘 수 있다.

## 4. Generic RTL: 선택한 Word의 Nonzero 여부만 전달한다

다음 예제에서 consumer가 필요한 값은 **선택한 W-bit word가 0이 아닌지**라는 1-bit predicate뿐이다. Raw data, parity, overflow 또는 다른 debug readback은 이 interface의 요구사항이 아니다. 필요한 observer가 추가되면 이 reduction이 충분한지 다시 검토해야 한다.

`W >= 1`, 두 구현 모두 같은 clock domain, backpressure 없는 one-stage stream이다. `rst_n=1 && in_valid=1`인 edge에서 input을 accept한다. Data와 select는 그 edge의 setup/hold를 만족한다. Reset은 비동기 assertion과 안전한 domain-local release를 가정한다.

```systemverilog
module selected_nonzero_stage #(
  parameter int unsigned W = 8,
  parameter bit LOCAL_REDUCE = 1'b1
) (
  input  logic         clk,
  input  logic         rst_n,
  input  logic         in_valid,
  input  logic [1:0]   select,
  input  logic [W-1:0] data0,
  input  logic [W-1:0] data1,
  input  logic [W-1:0] data2,
  input  logic [W-1:0] data3,
  output logic         out_valid,
  output logic         out_nonzero
);
  logic selected_nonzero;

  generate
    if (LOCAL_REDUCE) begin : g_reduce_first
      logic [3:0] nonzero;
      assign nonzero[0] = |data0;
      assign nonzero[1] = |data1;
      assign nonzero[2] = |data2;
      assign nonzero[3] = |data3;

      always_comb begin
        case (select)
          2'd0: selected_nonzero = nonzero[0];
          2'd1: selected_nonzero = nonzero[1];
          2'd2: selected_nonzero = nonzero[2];
          2'd3: selected_nonzero = nonzero[3];
          default: selected_nonzero = 1'b0;
        endcase
      end
    end else begin : g_select_first
      logic [W-1:0] selected_word;
      always_comb begin
        case (select)
          2'd0: selected_word = data0;
          2'd1: selected_word = data1;
          2'd2: selected_word = data2;
          2'd3: selected_word = data3;
          default: selected_word = '0;
        endcase
      end
      assign selected_nonzero = |selected_word;
    end
  endgenerate

  // Priority: asynchronous reset > valid advance and payload capture/hold.
  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      out_valid   <= 1'b0;
      out_nonzero <= 1'b0;
    end else begin
      out_valid <= in_valid;
      if (in_valid)
        out_nonzero <= selected_nonzero;
    end
  end
endmodule
```

Select 0..3은 모두 legal하다. Accepted input의 control/data는 known binary 값이라는 contract이며, default는 combinational assignment를 완성한다. Unknown select를 정상적인 “zero result”로 신뢰하라는 뜻은 아니다. X 진단과 초기화 검증은 별도로 수행한다.

### 같은 Cycle Contract

다음은 W=4인 기능 예시다. 선택되지 않은 word는 표의 결과에 영향을 주지 않는다.

| Edge | Edge 직전 입력 | Edge에서 downstream이 관찰 | 두 구현의 NBA 이후 출력 |
|---|---|---|---|
| E0 | valid=1, select=0, data0=0000 | Reset 이후 invalid | valid=1, nonzero=0 |
| E1 | valid=1, select=3, data3=1000 | 이전 valid result 0 소비 | valid=1, nonzero=1 |
| E2 | valid=0 | 이전 result 1 소비 | valid=0, payload 1 유지 |
| E3 | valid=1, select=1, data1=0010 | Invalid, 소비 없음 | valid=1, nonzero=1 |
| E4 | Edge 전에 reset assertion 완료 | Invalid, 소비 없음 | valid=0, payload=0 |

```text
accepted input A at E0
        |
        +--> E0 NBA: registered predicate A becomes valid
                         |
                         +--> E1 pre-edge sample: downstream consumes A

select-first and reduce-first: same one-stage boundary, II=1
```

`out_nonzero=0`도 `out_valid=1`이면 유효한 결과다. Valid와 predicate를 혼동하면 zero word에 대한 transaction을 잃는다. Clocked SVA에서 E0 입력에 대한 E0 NBA 결과를 확인하려면 E1 sample을 보는 `|=>` 관계를 사용한다. Physical topology를 바꾸기 위해 output register를 추가한 예제가 아니다.

## 5. 기능 동일성과 예상 Topology는 별도 주장이다

Known select에 대해 `nonzero(select(data0..3)) = select(nonzero(data0)..nonzero(data3))`이므로 두 후보는 같은 Boolean function을 갖는다. Register/reset/valid 계약도 같으므로 같은 accepted input trace에서 같은 output trace를 기대한다.

반면 아래는 **physical hypothesis**이며 별도 증거가 필요하다.

| 가설 | 확인할 증거 | 실패할 수 있는 이유 |
|---|---|---|
| Reduction이 각 producer 가까이에 놓임 | Placed cell 위치와 producer-to-reduction route | Tool이 중앙으로 모으거나 logic을 재구성 |
| 중앙으로 오는 data wire 수 감소 | Region cut을 넘는 실제 nets와 route | Raw data의 다른 observer 또는 boundary가 남음 |
| 중앙 hotspot 완화 | 같은 layer/model의 congestion map과 detailed DRC | Reduction pin density나 다른 channel로 문제 이동 |
| Timing 개선 | Data/select별 cell/net path와 hold | Reduction depth, late control 또는 source load 증가 |
| Power 감소 | 같은 workload의 clock/data/internal power | 네 reduction cone이 모두 계산하며 switching 증가 |

단순한 그림에서는 중앙에 들어오는 candidate data가 4W bits에서 4 predicate bits로 바뀐다. 이는 interface 연결 폭을 센 **개념 모델**이지 routed wire length나 track 사용량의 측정이 아니다. W=1에서는 이 폭 감소도 없다. Synthesis가 select/reduction을 factor하거나 topology를 다시 공유할 수 있다.

Source의 generate block을 `local`로 부르거나 data별로 group을 나누는 것만으로 실제 placement가 결정되지 않는다. 물리 경계와 interface cut은 [Hierarchy and Placement](hierarchy_and_placement.md), local decode/replica의 일반 한계는 [Fanout and Locality](fanout_and_locality.md)를 따른다.

## 6. Functional Width 감소와 Serialization은 다르다

Predicate 예제는 consumer의 필요한 정보만 계산한 것이며 arbitrary truncation이 아니다. 반대로 consumer가 W-bit payload 전체를 필요로 한다면 W보다 작은 bus로 여러 번 나눠 보내는 것은 serialization이다.

| 선택 | 보존해야 하는 것 | 새로 생기거나 바뀌는 것 |
|---|---|---|
| Range proof에 따른 width 축소 | 모든 legal numeric values/flags | Interface type와 bit dependency 검증 |
| 필요한 result/predicate만 전달 | Consumer가 요구한 정보와 observation | Local computation, 다른 observer 처리 |
| 여러 candidate 중 selected payload 전달 | 선택된 word 전체와 선택 계약 | Select distribution, simultaneous consumer 요구 |
| W-bit word를 B-bit beats로 serialization | 모든 payload bits와 word boundary | Beat count, assembly storage, valid/ready, latency/II |

Serialization의 순수 payload beat 수는 `ceil(W/B)`다. 예를 들어 W=16, B=8인 **가상 protocol 예**에서 shared link가 cycle당 beat 하나를 보낸다면 word 하나에 두 번의 successful beat transfer가 필요하다. Header, arbitration과 stall이 없더라도 단일 link의 지속 처리율은 최대 한 word/두 cycle이다. 더 빠른 clock이나 여러 link를 쓰면 별도의 architecture 비교가 된다.

Buffer를 추가해도 장기 service rate가 증가하지 않는다. Burst를 흡수할 수 있을 뿐이다. Width를 줄여 routing을 편하게 만든 대신 요구 II를 깨뜨렸다면 같은 성능의 최적화가 아니다. 상세 계약은 [Buffering and Backpressure](../02_architecture/buffering_and_backpressure.md)를 참고한다.

## 7. Arbiter, Ready/Valid와 Ordering의 비용

Central communication을 여러 local source와 shared result link로 바꾸면 data wire 외에 control을 검토해야 한다.

- 동시에 두 source가 요청하면 둘 다 accept해야 하는가, 하나는 기다려도 되는가?
- Grant를 받지 않은 source는 valid/payload를 유지하는가?
- Downstream stall 중 이미 선택한 source와 word/beat ownership을 보존하는가?
- Packet/word 중간에 grant가 바뀌어 두 transaction의 beat가 섞이지 않는가?
- Response tag, error/last와 payload가 함께 움직이는가?
- Ordering은 per-source인가, 전체 accept 순서인가?
- Ready를 조합으로 멀리 전달해 새로운 critical path나 combinational loop가 생기지 않는가?

Arbitration fairness, queue capacity와 sustained II는 [Resource Sharing vs Duplication](../02_architecture/resource_sharing_vs_duplication.md), stall/holding은 [Buffering and Backpressure](../02_architecture/buffering_and_backpressure.md)가 정본이다. 단순 nonzero 예제에는 이러한 protocol이 없으므로 stall 가능한 interface에 그대로 적용하지 않는다.

## 8. Timing, Power와 Area의 교환

| 구조 변화 | 가능한 이득 | 비용과 확인할 부작용 |
|---|---|---|
| Local predicate/result | Wide global candidate route 감소 | 연산 복제, local pin density와 unselected activity |
| Source-side selection | Selected bus만 장거리 전송 | Select의 source까지 도착 시간과 fanout |
| 더 분산된 merge | 중앙 pin 집중 완화 가능 | 추가 level, control 배포와 region crossing |
| Consumer 근처 buffering | 긴 control/data path 분리 가능 | Storage/clock/reset, latency와 backpressure |
| Serialization | Link의 동시 data wires 감소 | Beat control, assembly queue, II와 latency |

Congestion 때문에 detour가 줄면 net delay와 switching capacitance가 나아질 수 있다. 그러나 cell 수가 늘거나 stronger drive가 필요하면 total power/area는 반대로 갈 수도 있다. 작은 mapping count만으로 판단하지 말고 route와 protocol을 포함한 같은 boundary로 비교한다.

Pipeline은 새로운 FF와 clock load를 만들며, register를 추가해도 좁은 channel을 지나는 bus 폭 자체는 그대로일 수 있다. Setup budget 분할과 congestion 완화는 같은 목적이 아니다. [Pipeline Design](../03_timing/pipeline.md)의 latency/control 정렬을 별도로 검토한다. MCP는 routing demand나 channel capacity를 바꾸지 않으므로 혼잡을 해결하기 위해 임의로 추가하지 않는다.

## 9. 적용하면 안 되는 경우와 Common Mistakes

다음 경우에는 local reduction이나 좁은 communication으로 바꾸기 전에 계약부터 재검토한다.

- Consumer/debug/test가 실제로 raw payload 전체를 요구한다.
- Sources가 서로 다른 clock/reset/power domain인데 local result를 단순 조합으로 합치려 한다.
- Local computation이 memory access나 status update 같은 side effect를 갖는다.
- 각 source의 result가 서로 다른 transaction 시점인데 select만 맞춘다.
- Required simultaneous acceptance를 shared link가 감당하지 못한다.
- Unbounded stall에서 finite buffer만으로 no-drop을 주장한다.

흔한 실수는 “bit 수 감소=기능 유지”, “평균 utilization 낮음=route 성공”, “global overflow 0=DRC clean”으로 결론 내리는 것이다. 또는 grouping 이름만 바꾸고 actual netlist/placement도 바뀌었다고 가정한다. 이 문서의 예제는 pure synchronous predicate 연산이며 CDC, arbitration이나 memory-side effect의 해법이 아니다.

## 10. Verification과 Physical Evidence 계획

검증은 두 줄로 나눠 기록한다.

```text
Functional track: reference function -> accepted trace -> output/ordering/reset
Physical track:   mapped topology -> location/cut nets -> route/DRC/timing/power
```

예제의 functional 검증에는 다음을 포함한다.

- `LOCAL_REDUCE=0/1`, W=1과 여러 legal W의 compile/elaboration 계획
- 모든 select 값, all-zero와 walking-one/max data의 bit-exact 비교
- Inactive candidate를 바꿔도 selected result가 달라지지 않는지 확인
- Back-to-back valid, bubble, reset과 첫 accepted edge의 cycle 비교
- Valid result 0이 transaction으로 보존되는지 scoreboard 확인
- Unknown select/data에 대한 진단과 reset-release assumption 확인

독립 식 모델의 equality는 유용하지만 실제 SV simulation/equivalence 실행과 구분해서 보고한다. Wire 수나 배치 개선도 RTL 함수 equality로 증명되지 않는다.

Physical 검증에서는 동일 build/constraints/layers/floorplan 조건으로 synthesis→placement→global route→detailed route를 비교한다. Hotspot 주변의 route demand, layer capacity, pin access와 DRC 유형을 보고, setup/hold와 clock/control 비용도 함께 확인한다. 절차는 [RTL to Post-Route Feedback](rtl_to_post_route_feedback.md), report의 provenance와 metric 해석은 [Reading Synthesis Reports](../11_synthesis/read_synthesis_reports.md)를 따른다.

## 11. Design Review Checklist

- [ ] Routing demand를 region/layer/channel/pin-access 관점으로 나눴는가?
- [ ] 평균 utilization, global overflow와 detailed routability를 구분했는가?
- [ ] 제외된 nets와 routing capacity 모델이 비교 전후 같은가?
- [ ] Consumer가 필요로 하는 정보와 raw-data observer를 모두 확인했는가?
- [ ] Function equality와 expected physical topology를 별도로 검증하는가?
- [ ] Grouping/hierarchy가 actual placement를 보장한다고 가정하지 않는가?
- [ ] Local computation의 side effect, unselected switching과 pin density를 검토했는가?
- [ ] Functional width 축소와 serialization의 latency/II 차이를 구분했는가?
- [ ] Arbiter, ready/valid, ordering, tag와 buffering 비용을 포함했는가?
- [ ] Clock/reset/power/CDC 경계를 locality 때문에 넘지 않는가?
- [ ] Data뿐 아니라 select/ready path와 hold를 확인했는가?
- [ ] Post-route DRC/timing/power evidence 또는 미실행 한계를 기록했는가?

## 관련 문서

- [Physical Area and Congestion](../05_area/physical_area_and_congestion.md)
- [Fanout and Locality](fanout_and_locality.md)
- [Hierarchy and Placement](hierarchy_and_placement.md)
- [RTL to Post-Route Feedback](rtl_to_post_route_feedback.md)
- [Datapath MUX and Select](../10_datapath/mux_and_select.md)
- [Buffering and Backpressure](../02_architecture/buffering_and_backpressure.md)
- [RTL Design Review Checklist](../15_checklist/rtl_design_review_checklist.md)
