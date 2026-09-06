# Fanout and Locality

Fanout가 큰 net은 조사할 좋은 출발점이지만 fanout 숫자만으로 timing bottleneck을 결정할 수 없다. 가까운 작은 input pins를 구동하는 net과 넓은 영역에 흩어진 큰 load를 구동하는 net은 같은 load count라도 다르다. 반대로 fanout가 작아도 긴 wire 하나가 path를 지배할 수 있다.

이 문서는 load, geometry와 실제 timing evidence를 연결해 buffering, local decode와 replication을 판단한다. Area definition/congestion은 [Physical Area and Congestion](../05_area/physical_area_and_congestion.md), sharing/duplication의 scheduling은 [Resource Sharing vs Duplication](../02_architecture/resource_sharing_vs_duplication.md), STA path 해석은 [Critical Path](../03_timing/critical_path.md)가 정본이다.

## 1. Load Count, Capacitance, Geometry

| 관점 | 의미 | 이것만으로 알 수 없는 것 |
|---|---|---|
| Logical load count | Net이 연결하는 sink pin 수 | Pin별 capacitance, 물리 거리와 route topology |
| Electrical load | Driver가 보는 pin/wire의 유효 capacitive load | Capture schedule와 timing budget |
| Wire geometry | Length, layer, branching, detour, coupling 환경 | 기능적으로 공유가 필요한지 여부 |
| Cell/net delay | Driver arc, input slew, load와 route RC의 결과 | 다른 corner/mode까지 closure 여부 |

Report의 fanout가 단순 pin count인지 weighted load인지 먼저 확인한다. Buffer tree가 있으면 root가 직접 보는 buffer input 수와 전체 leaf consumer 수는 다르다. Root fanout가 작아졌다는 것만으로 전체 distribution network가 저렴해졌다고 결론 내리지 않는다.

개념적인 load 관계는 다음과 같다.

```text
driver load ~= sum(sink pin capacitance) + effective wire capacitance

cell delay = function(input slew, output load, cell, corner, transition)
net delay  = function(route RC, topology, coupling/model, driver/load)
```

실제 effective capacitance는 distributed RC와 분석 모델에 의존하므로 위 식은 모든 net에 적용할 sign-off 계산식이 아니다. Long wire의 resistance와 topology도 중요하며 capacitance 합만으로 delay를 정하지 않는다.

## 2. Source부터 Destination까지 그린다

```text
source FF --> decode --> root driver
                             |
                         buffer / route
                          /          \
                  local branch       long branch / detour
                       |                    |
                 buffer(s)              buffer(s)
                  /   \                  /   \
            sink FF  sink FF       sink FF  sink FF
            region A               region B

Timing path includes:
  source clock-to-Q + decode/cell arcs + routes/buffers + sink requirement
```

Root의 timing slack이 충분한지 먼저 본다. Source decode가 이미 늦다면 buffer만 추가해도 sink까지의 남은 budget이 부족할 수 있다. 반대로 논리 깊이가 얕은데 net delay가 크다면 gate expression을 줄이는 것보다 위치와 route를 조사하는 편이 적절하다.

RTL module 이름과 logical hierarchy는 ownership를 표현한다. Floorplan region, placement constraint나 actual cell coordinates가 없으면 “같은 module에 있으니 가까울 것”이라는 주장은 가설이다. Flattening과 optimization 뒤에는 logical hierarchy와 cell 위치의 대응도 달라질 수 있다.

## 3. 같은 Fanout, 다른 Timing

다음 비교는 정성적 예이며 실제 구현 결과나 universal ranking이 아니다.

| Load/배치 상황 | 가능한 문제 | 우선 확인 |
|---|---|---|
| 많은 작은 load가 한 cluster 안에 모임 | Pin capacitance와 root slew | Drive strength, local tree와 max cap/slew |
| 같은 수의 load가 여러 region에 흩어짐 | Long branches, buffers, detour | Bounding region, route length/layer, branch별 delay |
| 적은 load지만 한 sink가 매우 멂 | Wire resistance/capacitance | Source/sink distance와 long-wire buffering |
| Load는 가까우나 큰 pin capacitance | Cell delay와 transition degradation | Sink cell types, actual load와 driver arc |
| Late select가 wide bank를 제어 | Control arrival 부족 | Decode path와 per-sink enable timing |

따라서 “fanout가 N 이상이면 복제”라는 고정 기준을 제시하지 않는다. Library design rules, target period, physical region, cell types와 mode를 기준으로 판단한다. Constraint limit 위반 여부와 architecture 개선 우선순위도 별개의 질문이다.

## 4. 제거·단순화·Consumer 분리를 먼저 본다

모든 sink가 정말 같은 control을 매 cycle 필요로 하는지 조사한다.

- 이미 invalid로 mask되는 consumer를 불필요하게 clear/update하고 있지 않은가?
- 중복 decode나 불필요한 condition을 제거할 수 있는가?
- Function별로 다른 update window를 하나의 global enable로 과하게 묶지 않았는가?
- Debug/test/reset loads가 기능 sink와 섞여 report를 왜곡하지 않는가?
- Physical flow의 buffering/sizing만으로 requirement를 만족하는가?
- Small decode를 consumer 쪽에서 계산하는 편이 더 나은가?

Consumer 분리는 clock/domain 계약을 깨지 않는 논리적 partition부터 시작한다. Global broadcast를 여러 local control로 바꾸는 과정에서 mode이나 enable이 서로 다른 cycle을 나타내면 단순 physical optimization이 아니다. [Register Enable](../04_low_power/register_enable.md), [Operand Isolation](../04_low_power/operand_isolation.md)에서 window의 정본을 확인한다.

## 5. Combinational Local Decode: Cycle을 추가하지 않는 후보

다음 예제는 shared decode와 duplicated decode를 선택하는 완결 module이다. `run`, `mode`, request는 이미 같은 domain의 synchronous signal이며, 모든 mode 00/01/10/11이 legal하다. Mode 10에서만 request를 통과시킨다. Reset state는 없고, integration은 초기화 중 consumer를 비활성화하고 control을 known 값으로 제공해야 한다.

```systemverilog
module regional_decode #(
  parameter bit DUPLICATE = 1'b0
) (
  input  logic       run,
  input  logic [1:0] mode,
  input  logic       request_a,
  input  logic       request_b,
  output logic       go_a,
  output logic       go_b
);
  generate
    if (DUPLICATE) begin : g_local
      logic use_a, use_b;

      assign use_a = run && (mode == 2'b10);
      assign use_b = run && (mode == 2'b10);
      assign go_a = use_a && request_a;
      assign go_b = use_b && request_b;
    end else begin : g_shared
      logic use_common;

      assign use_common = run && (mode == 2'b10);
      assign go_a = use_common && request_a;
      assign go_b = use_common && request_b;
    end
  endgenerate
endmodule
```

두 configuration의 Boolean function은 같다. 두 output은 region별 consumer enable을 대표하는 단순 예이며, 이 작은 module 자체가 high-fanout 문제를 재현했다는 뜻은 아니다.

```text
Shared hypothesis                 Local-decode hypothesis

run/mode --> decode --> A          run/mode ----> decode_A --> A
                    \-> B                \----> decode_B --> B

fewer decode gates                more upstream signal distribution
one decoded broadcast             potentially shorter local output routes
```

Duplicate branch에 같은 expression을 두 번 썼다고 physical decoder 두 개가 유지되는 것은 아니다. Synthesis가 동일 logic을 merge하거나 output gating과 합칠 수 있다. 이름에 `local`을 넣거나 hierarchy를 나눠도 위치가 강제되지 않는다. 이 RTL은 구조 실험을 표현하며 실제 구현은 mapped/post-place netlist에서 확인한다.

Local decode는 공짜도 아니다. 좁은 decoded control 하나 대신 여러 mode bits와 run을 각 region에 보내야 할 수 있어 upstream fanout와 wire 수가 증가한다. Source가 distant region에 있거나 decode가 비싸면 이쪽이 불리할 수 있다. 넓은 raw control bus를 broadcast하는 비용과 local output route의 절감을 함께 비교한다.

### Timing/functional audit

| 같은 capture edge 직전, 충분히 안정된 입력 | Shared 결과 | Duplicated 결과 |
|---|---|---|
| run=0, mode=10, requests=11 | go=00 | go=00 |
| run=1, mode=10, requests=10 | go_a=1, go_b=0 | go_a=1, go_b=0 |
| run=1, mode=10, requests=01 | go_a=0, go_b=1 | go_a=0, go_b=1 |
| run=1, mode=00/01/11, requests=11 | go=00 | go=00 |

위 `requests`는 a,b 순서의 표기다. 어느 후보도 register를 추가하지 않아 cycle latency 변화가 없다. 하지만 combinational propagation delay가 0이라는 뜻은 아니며, gate-level glitch waveform이나 timing/power가 같다는 보장도 아니다. Consumer의 setup/hold를 만족해야 한다.

## 6. Registered Replica는 별도 State 계약이다

Combinational decode 앞뒤에 FF를 추가하면 새로운 state와 observation cycle이 생긴다. Data, valid와 enable을 그대로 둔 채 control만 한 cycle 늦추면 다른 transaction을 선택할 수 있다.

다음은 **동일한 synchronous state를 복제하려는 후보**다. `control_next`는 이미 synchronous이며 asynchronous input이나 synchronizer first-stage output이 아니다. Reset은 synchronous이고, 두 replica는 같은 reset/enable/clock edge를 사용한다. Reset이 적어도 한 edge에서 실행되기 전에는 consumer가 값을 사용하지 않는다.

```systemverilog
module synchronous_control_replicas (
  input  logic       clk,
  input  logic       rst,
  input  logic       en,
  input  logic       control_next,
  output logic [1:0] control_local
);
  // Synchronous priority: reset > enabled capture > hold.
  always_ff @(posedge clk) begin
    if (rst)
      control_local <= 2'b00;
    else if (en)
      control_local <= {2{control_next}};
  end
endmodule
```

| Edge | rst / en / control_next | Edge에서 관찰하는 replica | NBA 이후 replica |
|---|---|---|---|
| E0 | 1 / 0 / 무관 | 초기 값 사용 금지 | 00 |
| E1 | 0 / 1 / 1 | 00 | 11 |
| E2 | 0 / 0 / 0 | 11 | 11 유지 |
| E3 | 0 / 1 / 0 | 11 | 00 |
| E4 | 0 / 0 / 1 | 00 | 00 유지 |

E1에서 capture한 control은 E1 NBA 뒤 publish되고 E2에서 downstream이 관찰한다. Combinational control을 이 module로 교체하면 one-stage latency가 추가된다. **원래 동일 reset/enable/next-state를 가진 control FF 하나가 있었고 그것을 같은 stage의 replica로 대체하는 경우**에는 external cycle을 유지할 수 있다. 이때도 initial-state relation, mode와 모든 legal transition에서 값이 같다는 증거가 필요하다.

동일 RHS를 갖는 두 FF는 synthesis가 하나로 merge할 수 있다. `control_local[0]`과 `[1]`이 따로 존재하거나 각 region에 배치된다고 보장하지 않는다. 필요한 physical replication은 implementation owner와 함께 실제 cell/route를 확인하고, source RHS, enable와 reset의 증가한 load도 분석한다.

Register를 복제하면 FF/clock/reset area와 power가 늘 수 있고 min path와 skew도 바뀐다. Independent reset release나 서로 다른 enable을 허용하면 두 replica가 같은 값이라는 증명이 깨진다. Local bit equality만 검사하지 말고 원래 control의 cycle contract와 비교한다.

## 7. 복제하면 안 되는 Boundary

!!! warning "CDC 해결을 fanout 복제로 대신하지 않는다"
    Synchronizer first stage나 asynchronous control을 독립적으로 복제해 fanout를 낮추지 않는다. 각 수신점이 metastability를 서로 다르게 해소하면 cycle이 달라지고 reconvergence에서 모순된 control을 만들 수 있다. 같은 RTL RHS라는 사실은 asynchronous capture의 동일성을 증명하지 않는다.

Fanout 분산의 일반 후보는 **동일성이 검증된 synchronous registered state 또는 combinational function**이다. 이미 안전하게 동기화된 signal도 그것을 다시 register할 때 latency, protocol, CDC tool recognition과 reconvergence를 검토해야 한다. First-stage load와 placement는 [2FF Synchronizer](../08_cdc/synchronizer.md), [Metastability](../08_cdc/metastability.md), multi-bit 일관성은 [Multi-Bit CDC](../08_cdc/multi_bit_cdc.md)를 따른다.

Clock과 reset도 일반 data net처럼 복제하지 않는다. Clock tree/gating은 전용 clock methodology, reset distribution/release는 reset/RDC methodology의 책임이다. 특히 clock이 멈춘 region에 wake-up controller를 옮겨 fanout를 줄이면 재시작할 수 없는 구조가 될 수 있다. [Root Clock vs Function Clock](../06_clock/root_vs_function_clock.md), [Reset Deassertion and RDC](../07_reset/reset_deassertion.md), [Reset with Clock Gating](../07_reset/reset_with_clock_gating.md)를 연결해 검토한다.

Test/debug가 같은 control을 읽는지도 확인한다. Functional replica가 정상 mode에서 같아도 scan/test에서 독립 state로 취급되면 필요한 controllability/observability가 달라질 수 있다.

## 8. Physical Repair와 PPA Trade-off

| 후보 | 기대할 수 있는 효과 | 비용 / 악화 가능성 |
|---|---|---|
| 불필요한 consumer 제거 | Load와 route 자체 감소 | Observer/모드 누락이면 기능 손실 |
| Decode 단순화 | Source arrival 개선 | Min delay 감소와 hold 영향 |
| Consumer group 분리 | 각 group의 control 범위 축소 | 중복 control, mode consistency와 upstream load |
| Physical buffering | Electrical load 분산, long-wire delay 개선 가능 | Buffer area/power, route와 hold/setup 상호 영향 |
| Driver upsizing | Slew/cell delay 개선 가능 | Input capacitance, leakage/internal power 증가, upstream path 악화 |
| Local combinational decode | 짧은 local output route 가능 | Decode 중복, raw control distribution, synthesis merge |
| Synchronous register replicas | 분리된 local launch point 가능 | State/clock/reset 비용, equality proof, merge 가능성 |
| Pipeline | Stage budget 재분배 | Latency/II/data-control alignment와 clock/hold 비용 |

Buffer가 늘었다는 이유만으로 나쁜 구현은 아니다. 필요한 route RC나 transition을 해결한 것일 수 있다. 반대로 buffer count가 줄었다고 항상 좋아진 것도 아니다. Long unbuffered wire와 cap/slew 위반으로 바뀌었을 수 있다.

Upsizing으로 driver가 빨라지면 upstream driver가 보는 input capacitance가 커질 수 있다. Branch별 buffering과 local placement는 setup을 개선하면서 다른 short branch의 hold margin을 줄이거나 늘릴 수 있다. 어느 방향인지 실제 max/min path와 clock skew로 확인한다. Clock/reset/test load가 함께 늘어나는 registered replication은 data-path power만 비교하지 않는다.

!!! note "확인한 tool-specific 사례"
    OpenROAD의 [Gate Resizer 문서](https://openroad.readthedocs.io/en/latest/main/src/rsz/README.html)는 max slew/capacitance/fanout 위반과 long-wire RC delay를 위한 buffering, slew를 위한 resizing을 설명한다. 이는 physical repair가 단순 load-count 감소보다 넓다는 사례다. 실제 사용 flow의 버전과 parasitic stage를 확인해야 하며, 이 예제에 repair를 실행하거나 PPA 개선을 측정한 것은 아니다.

## 9. Post-Place와 Post-Route에서 확인할 Evidence

RTL 변경의 성공 조건은 “replica 이름 두 개 존재”가 아니라 requirement를 보존하면서 문제 path가 개선되고 부작용이 허용 범위 안에 드는 것이다.

| 단계 | 볼 증거 | 남는 한계 |
|---|---|---|
| Synthesis | Merge/replication 여부, root/leaf load, cell types, logic depth | Actual location과 routed RC 미확정 |
| Post-place | Replica/sink 좌표, regional clustering, estimated net delay와 slew/cap | Congestion detour와 routed parasitic 추정 오차 |
| Post-CTS | Launch/capture clock arrival, skew, new clock loads, gating checks | Route가 완료되지 않은 data/clock의 오차 |
| Post-route | Extracted RC, branch별 wire/cell delay, transition/cap, setup/hold | 분석하지 않은 mode/corner는 별도 |

같은 root에서 critical한 branch와 noncritical branch를 구분한다. Report에 net 전체의 fanout만 있으면 어느 load가 delay를 지배하는지 알 수 없으므로 pin별 path와 route를 조사한다. 낮은 fanout의 long branch를 high-fanout list 밖에서 놓치지 않는다.

비교에는 다음을 기록한다.

- Source arrival/slack과 decode delay, destination별 setup/hold margin
- Root direct load와 전체 leaf consumers, pin capacitance와 buffer topology
- Actual replica 위치, consumer distance, route length/layer와 detour
- Max capacitance/slew와 관련 design-rule violations
- FF/buffer/decode area, clock/reset/test load와 switching/leakage 범위
- 동일 corner/mode/constraint/activity와 parasitic stage

Placement 추정이 routed parasitic을 정확하게 대신하지 못한다는 한계는 위 공식 source에도 명시돼 있다. 전체 report 비교 형식은 [Reading Synthesis Reports](../11_synthesis/read_synthesis_reports.md)를 따른다.

## 10. Recommended Decision Flow

```text
identify actual slow / electrically stressed branches
                         |
                         v
remove unnecessary observers or updates, if function permits
                         |
                         v
simplify decode and audit source timing budget
                         |
                         v
split consumer responsibility / evaluate physical buffering
                         |
                         v
evaluate local decode or proven same-stage synchronous replicas
                         |
                         v
if still needed: architecture review for pipeline / scheduling
                         |
                         v
equivalence + mode/reset audit + post-place/post-route comparison
```

이 순서는 physical buffering을 마지막까지 미루라는 뜻이 아니다. 이미 wire-dominated라는 evidence가 있으면 early physical repair로 가설을 시험할 수 있다. 반대로 pipeline부터 추가해 latency와 clock load를 늘리기 전에 removal, simplification과 local distribution으로 해결 가능한지 확인한다.

MCP는 fanout나 wire를 줄이지 않는다. 이미 존재하는 multi-cycle contract가 있다면 [Multi-Cycle Path](../03_timing/multi_cycle_path.md)에 따라 분석해야 하지만, electrical violation이나 CDC 문제의 해결책으로 추가하지 않는다.

## 11. Verification Strategy

Combinational candidate는 같은 입력에 대한 shared/duplicated output equality를 검증한다. 위 decode 예제의 known binary 입력은 run 2가지 × mode 4가지 × requests 4가지로 32조합이며 exhaustive truth-table 비교가 가능하다. X policy와 input stability는 별도로 검사한다.

Registered candidate는 reset 이후 두 bit가 같다는 invariant와 원래 state machine의 update/hold/cycle을 모두 확인한다. 다음은 `synchronous_control_replicas` 안 또는 연결된 checker에 놓을 수 있는 SVA fragment다.

```systemverilog
ap_replica_reset:
  assert property (@(posedge clk)
    rst |=> control_local == 2'b00);

ap_replica_capture:
  assert property (@(posedge clk) disable iff (rst)
    en |=> control_local == {2{$past(control_next)}});

ap_replica_hold:
  assert property (@(posedge clk) disable iff (rst)
    !en |=> $stable(control_local));
```

`|=>`는 acceptance edge NBA 결과를 다음 sample에서 확인한다. Synchronous reset 전에 사용하지 않는다는 initialization contract를 testbench/formal harness에도 넣는다. Capture/hold property가 reset, enable과 RHS의 동일성을 가정한다는 점을 유지하고 independently synchronized inputs로 일반화하지 않는다.

추가 검증은 다음과 같다.

- Combinational equivalence 또는 sequential equivalence를 후보의 state 변화에 맞게 선택한다.
- Data/control/valid가 동일 transaction을 나타내는지 cycle reference와 비교한다.
- Reset, enable, mode, test와 wake-up boundary를 audit한다.
- CDC/RDC 구조와 reconvergence, synchronizer first-stage 사용을 재확인한다.
- Mapped/post-place netlist에서 의도한 복제 여부를 확인한다.
- All required views의 setup/hold, electrical limits와 power/area를 비교한다.

Logical equality는 physical placement, metastability containment나 timing closure의 증거가 아니다. 각 검증의 역할과 미실행 항목을 분리해 보고한다.

## 12. Common Mistakes와 Design Review Checklist

흔한 실수는 fanout 순위만으로 최적화 대상을 정하는 것, RTL hierarchy를 floorplan처럼 읽는 것, 같은 RHS를 두 번 쓰면 local physical replica가 생긴다고 믿는 것이다. 특히 asynchronous control이나 synchronizer first stage의 복제는 일반 fanout 최적화의 범위를 벗어난다.

- [ ] Load count, pin/wire capacitance와 route geometry를 구분했는가?
- [ ] Root direct fanout와 전체 leaf consumer 수를 구분했는가?
- [ ] Low-fanout long wire도 조사했는가?
- [ ] Source timing slack, late select/enable와 branch별 cell/net delay를 확인했는가?
- [ ] Remove/simplify/consumer split와 physical buffering을 먼저 검토했는가?
- [ ] Local decode의 upstream bus/load와 duplication cost를 포함했는가?
- [ ] Combinational duplication과 added registered state/latency를 구분했는가?
- [ ] Registered replica는 같은 reset/enable/mode에서 동일성이 증명되는가?
- [ ] Synchronizer first stage와 asynchronous control을 독립 복제하지 않는가?
- [ ] Clock/reset/wake/test는 전용 methodology와 owner를 유지하는가?
- [ ] Actual merge/replica 위치와 post-place/post-route 증거가 있는가?
- [ ] Setup뿐 아니라 hold, max cap/slew, clock/power와 다른 view를 확인했는가?
- [ ] 고정 fanout threshold 대신 target과 분석 조건으로 판단하는가?

## 관련 문서

- [Large Decode Without Timing Review](../14_anti_patterns/large_decode_without_timing_review.md): late decode의 fanout·route·downstream timing evidence
- [Physical Area and Congestion](../05_area/physical_area_and_congestion.md)
- [Resource Sharing vs Duplication](../02_architecture/resource_sharing_vs_duplication.md)
- [Critical Path](../03_timing/critical_path.md)
- [Enable and MUX Inference](../11_synthesis/enable_and_mux_inference.md)
- [Root Clock vs Function Clock](../06_clock/root_vs_function_clock.md)
- [2FF Synchronizer](../08_cdc/synchronizer.md)
- [Congestion-Aware Structure](congestion_aware_structure.md)
- [Hierarchy and Placement](hierarchy_and_placement.md)
- [RTL to Post-Route Feedback](rtl_to_post_route_feedback.md)
- [RTL Design Review Checklist](../15_checklist/rtl_design_review_checklist.md)
