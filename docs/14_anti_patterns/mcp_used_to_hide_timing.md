# MCP Used to Hide Timing

Multi-Cycle Path(MCP)는 느린 logic을 빠르게 만드는 optimization이 아니다. Hardware가 이미 여러 edge 뒤에만 capture하도록 설계되어 있을 때, 그 **functional launch/capture contract**를 STA에 표현하는 timing exception이다. Negative slack을 없애기 위해 cycle 수부터 늘리면 timing report는 깨끗해져도 silicon의 next-cycle capture는 그대로 남는다.

MCP의 edge·setup/hold·RTL 계약은 [Multi-Cycle Path](../03_timing/multi_cycle_path.md), 실제 logic 개선은 [Critical Path](../03_timing/critical_path.md)와 [Pipeline Design](../03_timing/pipeline.md), report provenance는 [Reading Synthesis Reports](../11_synthesis/read_synthesis_reports.md)를 정본으로 삼는다. 이 문서는 review에서 **slack concealment flow를 탐지하고 exception을 정당화할 증거**에 집중한다.

## 1. Bad flow: slack에서 cycle 수를 역산한다

```text
STA: negative setup slack
  ↓
“N cycle이면 숫자가 통과하겠다”
  ↓
set_multicycle_path N <broad object pattern>
  ↓
WNS가 좋아짐 → 해결로 보고
```

위 `set_multicycle_path` 문장은 실행 가능한 recipe가 아니라 anti-pattern을 표현한 의사 코드다. Tool의 `-start`/`-end`, setup/hold default, object 종류와 edge semantics는 flow마다 다르므로 이 문서에서 복사 가능한 광범위 SDC 명령을 제공하지 않는다.

Constraint 전후 회로는 같다.

```text
Source FF ---- long combinational path ---- Destination FF

before constraint: same gates and wires
after constraint:  same gates and wires; STA edge relationship만 변경
```

Destination FF가 실제로 다음 edge에 capture한다면 MCP는 그 동작을 늦추지 못한다. Intermediate value가 status, feedback나 side effect로 사용되는 것도 막지 못한다.

## 2. Good flow: capture schedule에서 constraint가 나온다

먼저 specification과 RTL에서 edge timeline을 만든다.

```text
edge             E0              E1              E2              E3
transaction      accept A
source value     launch A        hold A          hold A          hold A
capture enable   0               0               0               1
destination                                                      capture A
next accept      blocked         blocked         blocked         policy-dependent;
                                                                E3 only with explicit
                                                                capture/refill support
```

이 timeline의 계약은 다음과 같다.

- E0에서 accepted transaction A의 source value가 launch된다.
- Source는 intended capture가 끝날 때까지 A를 overwrite하지 않는다.
- Destination capture는 E1/E2에 꺼져 있고 E3에만 열린다.
- Intermediate combinational 값은 다른 state, output, interrupt와 feedback에서 사용되지 않는다.
- Busy 중 request를 reject/backpressure/queue하는 정책이 있다.
- Reset, abort, clock stop와 mode change 시 A의 ownership이 정의된다.

이 계약을 RTL/property로 증명한 뒤에만 STA가 E0→E3 setup relationship을 분석하도록 좁은 exception을 작성한다.

## 3. Data identity: “N cycle 뒤 읽는다”만으로 부족하다

Source가 매 cycle 바뀌는 경우를 비교한다.

```text
edge             E0          E1          E2          E3
source launch    A           B           C           D
destination                                          captures ?
```

단일 long combinational path에서 A, B, C, D의 wave가 연속으로 전파된다. E3에서 어떤 transaction의 결과를 capture해야 하는지 storage/tag/protocol이 없다면 “A의 내부 capture path에 3 cycle을 준다”는 constraint만으로 data identity를 보장할 수 없다.

매 cycle 새 input을 accept하면서 fixed interface latency를 원하면 보통 각 transaction을 stage별로 보존하는 pipeline, multi-entry storage 또는 명시적인 iterative schedule이 필요하다. Interface latency, 내부 MCP capture cycle과 initiation interval(II)은 서로 다른 metric이다.

- Source-hold MCP의 E0→E3 내부 capture requirement가 3 cycle이면 controller에 따라 II가 3 이상일 수 있다.
- Three-stage pipeline은 latency 3 cycle이면서 II=1일 수 있다.
- 여러 source가 interleave되는 scheduled unit은 tag와 resource-occupancy contract가 필요하다.

Throughput requirement를 보지 않고 MCP를 선택하지 않는다.

## 4. Better RTL architecture의 최소 형태

다음 fragment는 E0→E3의 3-cycle internal capture를 갖는 source-hold 구조의 의도를 보여 준다. Priority는 `reset > idle accept > intended capture/phase advance`이며 busy 동안 새 input을 받지 않는다.

```systemverilog
always_ff @(posedge clk) begin
    if (rst) begin
        busy_q   <= 1'b0;
        phase_q  <= 2'd0;
        result_v <= 1'b0;
    end else begin
        result_v <= 1'b0;

        if (!busy_q) begin
            if (accept) begin
                source_hold_q <= source_data;
                phase_q       <= 2'd0;
                busy_q        <= 1'b1;
            end
        end else if (phase_q == 2'd2) begin
            result_q <= long_function(source_hold_q);
            result_v <= 1'b1;
            busy_q   <= 1'b0;
        end else begin
            phase_q <= phase_q + 2'd1;
        end
    end
end
```

`long_function`은 combinational datapath를 나타내는 generic placeholder다. 실제 module에서는 function width/signedness와 synthesis mapping을 정의해야 한다. MCP constraint는 `source_hold_q`, `phase_q`, `busy_q`나 destination enable을 만들지 않는다.

이 예제 RTL은 E0에서 accept하고 E3에서 result register를 capture한 뒤 `busy_q`를 내리므로 다음 accept는 가장 빨라도 E4다. 내부 MCP capture requirement는 E0→E3의 3 cycle이고, E3 NBA 뒤 publish된 result를 downstream이 처음 synchronous하게 관찰·capture하는 edge는 E4이므로 이 가이드의 interface latency와 II는 모두 4 cycle이다. E3에서 capture와 새 input refill을 동시에 허용하는 별도 구조라면 nonblocking assignment 이전의 `source_hold_q`가 A의 결과를 만들고 새 source가 B로 교체된다는 점, A/B의 transaction identity와 output ordering을 명시적으로 보존해야 한다.

Capture enable을 생성하는 `phase_q` decode는 intended edge에 정확히 도착해야 하므로 long datapath와 함께 broad MCP로 묶지 않는다. Control path가 single-cycle requirement를 위반하면 destination이 E3에서 capture하지 못할 수 있다.

## 5. 실제로 next-cycle capture라면 architecture를 고친다

Requirement가 다음 edge capture라면 MCP는 적용할 수 없다. 다음 순서로 원인을 줄인다.

1. 사용하지 않는 state, branch와 duplicate calculation을 제거한다.
2. Width, compare, decode와 priority를 단순화한다.
3. Late condition을 precompute하거나 independent 후보를 병렬 계산한다.
4. Resource sharing의 MUX를 줄이거나 필요한 곳에 logic을 복제한다.
5. Latency가 허용되면 pipeline을 넣고 data/valid/control을 함께 정렬한다.
6. Placement, fanout, congestion와 route가 원인이면 physical feedback으로 최적화한다.

Precompute/parallelization은 area와 switching을, duplication은 area를, pipeline은 latency·FF·clock power를 늘릴 수 있다. 같은 constraint·corner·physical stage에서 trade-off를 측정한다.

## 6. Setup MCP와 hold relationship은 한 쌍이다

개념적인 same-clock default와 intended edge는 다음과 같다.

```text
default setup:    E0 launch ------------> E1 capture
intended setup:   E0 launch --------------------------------> E3 capture
default hold:     E0 주변의 minimum-delay 관계 보호
```

Setup capture edge를 E3로 옮길 때 hold check의 launch/capture edge도 tool의 default와 option에 따라 영향을 받을 수 있다. 흔히 same-clock 예에서 setup N과 연관된 hold N−1 조정이 사용되지만, 이를 보편 공식으로 복사하면 안 된다.

- `-start`와 `-end`가 어느 clock edge를 이동하는지 확인한다.
- Rising/falling, phase-shifted/generated clock이면 실제 waveform edge를 본다.
- Setup뿐 아니라 min-delay/hold report에서 launch/capture timestamp를 확인한다.
- Uncertainty, skew, derating과 library setup/hold가 그대로 반영되는지 본다.
- Tool version과 project wrapper가 option default를 바꾸지 않았는지 확인한다.

Constraint parser가 명령을 받아들였거나 setup WNS가 양수가 됐다는 사실만으로 올바른 MCP가 아니다.

## 7. Scope와 precedence가 만드는 유지보수 실패

### Broad `from` / `to` / `through`

Hierarchy 전체를 wildcard로 잡으면 single-cycle control, 새 register와 unrelated mode path가 exception에 들어갈 수 있다. 반대로 synthesis rename, flattening, replication 뒤 pattern이 0개 object를 선택할 수도 있다.

### Empty collection

일부 script는 빈 collection에 명령을 적용해도 flow가 계속될 수 있다. “0 violation”이 실제로 0개 path를 검사한 결과인지 구분한다. Expected startpoint/endpoint count와 resolved object 목록을 regression artifact로 남긴다.

### Exception precedence

같은 path에 false path, max/min delay, clock group와 MCP가 겹치면 어떤 exception이 최종 적용되는지 tool rule을 확인한다. `report_exceptions`와 timing path의 applied-exception field 등 flow가 제공하는 evidence를 사용한다.

### Mode/corner coverage

Functional mode에서는 multi-cycle이지만 scan/test/wake mode에서 capture schedule이 다를 수 있다. 모든 supported analysis view에서 contract가 같은지, 다른 경우 mode-specific scope가 정확한지 확인한다.

### Stale constraint

다음 변경은 MCP 재검토 trigger다.

- Latency, phase counter, capture enable 또는 busy policy 변경
- Back-to-back acceptance와 multiple outstanding 지원
- Source/destination register 이동, rename, replication 또는 hierarchy 변경
- Clock period/waveform, generated clock, gating와 mode 변경
- Reset/abort/flush semantics와 consumer 추가

SDC owner만 알고 있는 assumption은 쉽게 drift한다. Requirement, RTL comment, assertion과 constraint justification이 같은 launch/capture contract를 가리켜야 한다.

## 8. MCP와 false path를 혼동하지 않는다

| 구분 | MCP | False path |
|---|---|---|
| Functional 의미 | 실제 capture되지만 허용 시간이 여러 cycle | 해당 mode에서 기능적으로 capture/sensitize되지 않음 |
| STA | 변경된 setup/hold edge로 max/min timing을 계속 분석 | 지정한 timing analysis를 제외 |
| 필요한 증거 | Source stability, delayed capture, no intermediate use | Path가 활성화되지 않는 구조/mode proof |
| 오용 위험 | 실제 single-cycle path를 느슨하게 분석 | 실제 path를 분석에서 완전히 숨김 |

MCP cycle 수를 더 늘려도 fail하므로 false path로 바꾸는 흐름은 허용되지 않는다. Exception 종류는 slack 크기가 아니라 functional sensitization과 capture 관계로 선택한다. Asynchronous CDC를 MCP로 처리하는 것도 metastability, pulse loss나 coherency를 해결하지 않는다.

## 9. Verification과 evidence

### Functional properties

```systemverilog
ap_source_stable_while_busy:
    assert property (@(posedge clk) disable iff (rst)
        busy_q && $past(busy_q) |-> $stable(source_hold_q));

ap_result_only_at_capture_phase:
    assert property (@(posedge clk) disable iff (rst)
        result_v |-> $past(busy_q && (phase_q == 2'd2)));

ap_no_accept_while_busy:
    assert property (@(posedge clk) disable iff (rst)
        busy_q |-> !accept);
```

마지막 property가 environment obligation이면 `assume`로 둘 수 있지만, DUT가 ready를 내려야 하는 interface라면 `accept` 정의 자체가 busy를 반영해야 한다. `$past`의 initial history와 NBA sampling은 local `past_valid` 또는 project convention으로 검토한다.

Cycle-accurate scoreboard는 accepted transaction ID를 launch edge에 기록하고 intended capture edge의 result와 비교한다. Reset/abort로 폐기된 transaction과 valid result를 epoch로 구분한다.

### STA evidence

- Exception 전후 같은 path의 startpoint, endpoint, max/min delay와 applied exception
- Setup/hold launch/capture edge timestamp와 required time 검산
- Resolved `from`/`to`/`through` object 수와 empty/unexpected collection check
- MCP에서 제외된 capture-enable/control path의 single-cycle timing
- 모든 mode/corner의 exception coverage, unconstrained endpoint와 precedence
- Post-synthesis/post-route rename·replication 후 target 유지 여부

### Change ledger

Before/after report에는 WNS만 쓰지 않는다. Top/parameters, RTL revision, SDC revision, clocks, mode/corner, exception count, latency/II와 verification 결과를 같이 기록한다. MCP가 없어도 통과하도록 logic이 개선됐거나 architecture schedule이 바뀌면 stale exception을 제거하는 review를 연다.

## 10. Design Review Checklist

- [ ] MCP cycle 수가 negative slack이 아니라 specification의 capture event에서 나왔는가?
- [ ] Launch, intermediate, intended capture edge가 timeline으로 정의됐는가?
- [ ] Source가 capture까지 같은 transaction 값을 유지하는가?
- [ ] Destination capture와 모든 intermediate observer가 그 전에는 비활성인가?
- [ ] Back-to-back input, multiple outstanding와 overwrite 정책이 정의됐는가?
- [ ] Latency와 II가 throughput requirement와 구분되어 있는가?
- [ ] 실제 next-cycle requirement라면 simplification/precompute/pipeline을 검토했는가?
- [ ] Setup과 hold edge relationship을 실제 max/min report에서 확인했는가?
- [ ] `from`/`to`/`through` scope와 resolved object 수가 최소·정확한가?
- [ ] Empty collection, hierarchy rename와 exception precedence를 검사하는가?
- [ ] 모든 mode/corner와 generated/gated clock 관계를 확인했는가?
- [ ] Assertion/scoreboard와 STA evidence가 같은 contract를 검증하는가?
- [ ] False path와 MCP의 functional 의미를 혼동하지 않는가?
- [ ] RTL·clock·hierarchy 변경에 대한 owner와 재검토 trigger가 있는가?

## 관련 문서

- [Multi-Cycle Path](../03_timing/multi_cycle_path.md): functional MCP contract와 setup/hold 관계의 정본
- [Pipeline Design](../03_timing/pipeline.md): stage 추가, latency와 throughput trade-off
- [Critical Path](../03_timing/critical_path.md): 실제 cell/net/control 원인과 최적화 순서
- [Reading Synthesis Reports](../11_synthesis/read_synthesis_reports.md): exception coverage, provenance와 A/B evidence
- [Assertion-Driven RTL](../13_verification/assertion_driven_rtl.md): sampling, assumption와 vacuity
- [RTL to Post-Route Feedback](../12_physical_aware/rtl_to_post_route_feedback.md): physical stage별 evidence와 change trigger

## 참고 자료

- [AMD, Multi-Cycle Paths](https://docs.amd.com/r/en-US/ug903-vivado-using-constraints/Multi-Cycle-Paths): setup/hold multicycle edge 관계에 관한 공식 constraint 문서
- [OpenROAD, OpenSTA](https://openroad.readthedocs.io/en/latest/main/src/sta/README.html): generated clock와 timing exception을 지원하는 공개 STA engine 문서
- [OpenSTA, Search.tcl](https://github.com/The-OpenROAD-Project/OpenSTA/blob/master/search/Search.tcl): exception·path analysis 명령 동작을 확인할 수 있는 공식 공개 source
