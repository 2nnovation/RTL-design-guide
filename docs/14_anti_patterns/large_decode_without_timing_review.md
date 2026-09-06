# Large Decode Without Timing Review

Wide equality/range compare와 many-term mode/state/address decode는 output이 1비트라서 작아 보이기 쉽다. 그러나 그 1비트가 late select, enable 또는 grant가 되어 넓은 datapath와 많은 register를 구동하면 decode depth보다 fanout·wire·reconvergence가 timing과 power를 지배할 수 있다.

Selection semantics는 [Priority and MUX](../01_fundamentals/priority_and_mux.md), path 분석은 [Critical Path](../03_timing/critical_path.md), wide MUX는 [Datapath MUX and Select](../10_datapath/mux_and_select.md), distribution은 [Fanout and Locality](../12_physical_aware/fanout_and_locality.md)를 정본으로 삼는다. 이 문서는 review에서 **large decode를 timing path와 physical network로 추적하는 증거**에 집중한다.

## 1. 문제: Boolean 식만 보고 비용을 작게 본다

```systemverilog
assign select_payload = enable
                     && (mode_q == 8'hA5)
                     && (state_q inside {RUN, RETRY, DRAIN})
                     && (address_i[31:8] == 24'h12_3456)
                     && (length_i >= 12'd64)
                     && !blocked;
```

이 식은 여러 equality/range compare, set membership와 AND/reduction을 포함한다. `select_payload`가 wide MUX, 수백 개 FF의 enable 또는 먼 region의 control을 구동하면 다음 경로가 생길 수 있다.

```text
mode/state/address/length registers
          |
          v
 wide compare + range compare + mode decode
          |
          v
      reconvergent AND ---- decoded select ---- buffer/routes ----+
                                                                  |
early data -------------------------------------------------------MUX --> capture FF
                                                                  |
                                                         many enable sinks
```

Data가 일찍 준비돼도 select가 늦으면 final MUX path는 늦다. Decode output의 fanout가 크고 consumer가 흩어져 있으면 logic level보다 net delay와 electrical load가 더 중요할 수 있다.

## 2. Hardware/failure mechanism

### Wide equality와 range compare

Equality는 여러 bit의 비교 결과를 reduction하고, range compare는 magnitude/carry 계열 logic으로 mapping될 수 있다. Constant와 target cell 구조에 따라 최적화될 수 있지만 width만 보고 한 gate라고 생각하지 않는다.

### Many-term reconvergence

서로 다른 depth를 거친 condition이 AND/OR에서 다시 만나면 arrival가 어긋나 glitch가 생길 수 있다. Synchronous destination이 setup을 만족하면 combinational glitch가 기능적으로 관찰되지 않을 수 있지만 internal switching과 asynchronous/edge-sensitive consumer에는 위험하다.

### Late high-fanout control

Decoded bit가 MUX select, CE와 state transition을 동시에 구동하면 source decode delay와 distribution delay가 모든 endpoint에 전파된다. Buffering/replication은 route를 개선할 수 있지만 upstream load, area와 power를 바꾼다.

### Parameter/configuration growth

초기 configuration에서는 term가 constant로 제거돼 작아도, 다른 parameter/mode에서는 모든 term가 살아날 수 있다. 한 build의 clean timing을 supported configuration 전체의 증거로 일반화하지 않는다.

## 3. Decode 의미를 먼저 분류한다

| Decode 종류 | Functional 의미 | Illegal/overlap 질문 |
|---|---|---|
| Exact encoded `case` | 하나의 encoded value가 한 item을 선택 | Unlisted/no-match policy는? |
| One-hot select | 각 bit가 후보 하나에 대응 | Zero-hot/multiple-hot이 가능한가? |
| Priority decode | 여러 match 시 앞 item이 승리 | 순서가 specification인가? |
| Wildcard decode | 일부 bit를 don't-care로 취급 | X/Z와 overlapping pattern 의미는? |
| Range/address decode | 값 구간이나 mask match | Boundary와 alias가 없는가? |

`if`를 `case`로 바꾸거나 `unique`를 붙인다고 balanced hardware나 exclusivity가 자동 보장되지 않는다. `unique`/`priority`는 intent/diagnostic이며 illegal input을 막는 circuit이나 proof가 아니다.

Wildcard decode는 `casez`, mask 또는 explicit comparison의 X/Z semantics가 다를 수 있다. Control에서 `casex`로 unknown을 광범위하게 wildcard 처리하면 initialization/illegal-state bug를 숨길 수 있으므로 X policy를 명시한다.

## 4. 비교 bit를 줄일 때 alias를 증명한다

Address가 aligned라는 이유로 low bit를 빼거나, mode 상위 bit만 비교하면 decode가 작아질 수 있다. 하지만 제거한 bit가 다른 legal value와 alias를 만들지 않아야 한다.

```text
원래 match: address[15:0] == 16'hA340
축소 후보: address[15:6] == 10'b1010_0011_01

필요한 proof:
- address[5:0]은 protocol상 항상 0인가?
- misaligned/illegal input에서 side effect가 차단되는가?
- 다른 region/register가 같은 prefix를 공유하지 않는가?
```

Software가 보통 aligned access를 만든다는 기대만으로 bit를 제거하지 않는다. Interface assertion, address map generation과 exhaustive alias test를 연결한다.

## 5. Better architecture 후보

### Remove unused mode와 term

Supported parameter/tie-off에서 unreachable mode와 duplicate condition을 먼저 제거한다. Runtime configuration을 compile-time constant처럼 가정하거나 STA case analysis로 기능을 제거하지 않는다.

### Predecode와 grouping

공통 prefix나 mode group을 미리 계산해 여러 consumer가 재사용할 수 있다.

```systemverilog
logic region_hit;
logic legal_mode;

assign region_hit = (address_i[15:12] == 4'hA);
assign legal_mode = (mode_q == MODE_RUN) || (mode_q == MODE_RETRY);
assign select_payload = request_i && region_hit && legal_mode;
```

이 표현이 원래 식보다 빠르다는 보장은 없다. 공통 subexpression 공유로 gate 수가 줄 수 있지만 shared decode fanout와 route가 커질 수 있다. Synthesis schematic과 path arc로 확인한다.

### Registered decode

Decode를 이전 cycle에 계산해 register하면 select arrival를 앞당길 수 있다.

```systemverilog
always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
        select_q <= 1'b0;
    end else begin
        select_q <= request_i && region_hit && legal_mode;
    end
end
```

이것은 one-cycle state/latency를 추가한다. Data, address, tag와 valid도 같은 transaction으로 정렬하고, stall/flush에서 함께 hold 또는 invalidate해야 한다.

### Local duplication

먼 consumer마다 작은 decode를 복제하면 decoded broadcast route가 짧아질 수 있다. 반대로 raw address/mode bit를 여러 region으로 보내야 하고 synthesis가 같은 logic을 merge할 수 있다. Actual replica와 location을 mapped/post-place netlist에서 확인한다.

### Pipeline 또는 partition

Compare/decode와 wide select를 stage로 나누거나 consumer group을 architecture partition으로 분리할 수 있다. Latency·II, FF/clock power, ordering과 backpressure cost를 포함한다. 결과가 next cycle에 필요하면 pipeline이 허용되는지 먼저 확인한다.

## 6. Edge-sensitive control에 일반 decode를 직접 쓰지 않는다

Combinational decode output을 다음에 직접 연결하지 않는다.

- Raw clock AND/OR/MUX 또는 clock pin
- Asynchronous reset/set pin
- CDC synchronizer first stage 이후의 비동기 reconvergence
- Pulse width가 보장되지 않은 external/edge-sensitive interface

```systemverilog
// Bad clock boundary
assign gclk = clk & large_mode_decode;

// Bad asynchronous control boundary
always_ff @(posedge clk or negedge large_reset_decode) begin
    // ...
end
```

Decode glitch와 route skew가 runt/extra clock edge 또는 partial asynchronous release로 이어질 수 있다. Clock은 승인된 clock-control flow를, reset은 reset/RDC methodology를, CDC는 protocol structure를 사용한다. [Raw Clock Gating](raw_clock_gating.md)을 참고한다.

## 7. Timing·power·physical trade-off

### STA

- Data path와 select/enable path를 각각 report한다.
- Compare input arrival, reduction/priority arc와 final MUX pin을 확인한다.
- Setup뿐 아니라 registered/local decode가 만든 hold와 min path를 본다.
- Mode/corner별 sensitization, case analysis와 false/MCP exception을 확인한다.

### Physical

- Root direct fanout와 buffer 뒤 전체 leaf load를 구분한다.
- Pin/wire capacitance, slew, route length, consumer bounding region과 congestion을 본다.
- Replication 후 source load와 actual replica location을 확인한다.
- Pre-route delay 개선을 post-route closure로 보고하지 않는다.

### Power

Wide input bus가 바뀔 때 compare 내부와 reconvergent node가 toggle할 수 있다. Registered/predecoded 구조는 glitch를 줄일 수 있지만 FF clock power와 duplicated decode activity를 늘릴 수 있다. Activity coverage와 workload를 같은 조건으로 비교한다.

## 8. Verification과 evidence

### Truth table와 assertions

작은 encoded mode는 legal value 전체를 exhaustive하게 비교한다. One-hot은 zero/one/multiple-hot을 분리한다.

```systemverilog
ap_select_requires_all_terms:
    assert property (@(posedge clk) disable iff (!rst_n)
        select_payload |-> (request_i && region_hit && legal_mode));

ap_mode_is_legal:
    assert property (@(posedge clk) disable iff (!rst_n)
        request_i |-> (mode_q inside {MODE_RUN, MODE_RETRY}));

cp_illegal_mode_attempt:
    cover property (@(posedge clk) disable iff (!rst_n)
        request_i && !(mode_q inside {MODE_RUN, MODE_RETRY}));
```

Environment contract라면 legal-mode 조건을 assume할 수 있지만 upstream proof와 owner가 필요하다. Negative cover/test로 checker가 illegal/no-match/overlap을 실제로 탐지하는지 확인한다.

### Configuration와 equivalence

- Minimum/maximum parameter, feature on/off와 all supported modes
- Address boundary, aligned/misaligned와 alias 후보
- Wildcard X/Z, no-match와 overlapping pattern
- Registered/local decode의 latency와 transaction tag alignment
- Original vs minimized-bit/predecoded Boolean function의 exhaustive/formal equivalence

### Implementation evidence

- Synthesis schematic: comparator width, priority/reduction와 final MUX
- Timing path: cell/net delay, select pin arc와 source arrival
- Fanout/electrical: direct/leaf load, cap/slew와 buffer topology
- Post-place/route: coordinates, route length, congestion와 extracted delay
- Power: compare/decode/select cone activity와 glitch modeling 범위
- Constraint: case analysis, exceptions, unconstrained endpoint와 mode coverage

## 9. Design Review Checklist

- [ ] Wide equality/range/term decode의 actual input width와 term 수를 확인했는가?
- [ ] Exact encoded, one-hot, priority와 wildcard semantics를 구분했는가?
- [ ] No-match, overlap, illegal state와 X/Z behavior가 정의됐는가?
- [ ] 비교 bit 축소가 legal/illegal input에서 alias를 만들지 않는가?
- [ ] Decode output이 어느 MUX/enable과 몇 개 sink를 구동하는가?
- [ ] Data가 아니라 late select/control이 critical path인지 확인했는가?
- [ ] Logic depth뿐 아니라 fanout, cap/slew, route와 congestion을 봤는가?
- [ ] Remove term, predecode, register, local duplicate와 partition을 비교했는가?
- [ ] Registered decode의 latency와 data/tag/valid alignment를 검증했는가?
- [ ] 일반 decode가 clock/asynchronous reset 같은 edge-sensitive control을 구동하지 않는가?
- [ ] 모든 parameter/configuration/mode에서 synthesis·STA evidence가 있는가?
- [ ] Boolean/transaction equivalence와 post-route 결과가 구조 가설과 일치하는가?

## 관련 문서

- [Priority and MUX](../01_fundamentals/priority_and_mux.md): selection semantics와 exclusivity
- [Critical Path](../03_timing/critical_path.md): late control과 cell/net delay
- [Datapath MUX and Select](../10_datapath/mux_and_select.md): wide data/select topology
- [Fanout and Locality](../12_physical_aware/fanout_and_locality.md): local decode, replication과 route evidence
- [Deep Priority Chain](deep_priority_chain.md): priority dependency와 fairness
- [Raw Clock Gating](raw_clock_gating.md): decode를 clock에 직접 연결하는 위험

## 참고 자료

- [IEEE, IEEE Std 1800-2023 SystemVerilog](https://standards.ieee.org/ieee/1800/7743/): `case`, wildcard, `unique`와 `priority` 의미의 normative language reference
- [AMD, Vivado Design Suite User Guide: Synthesis (UG901)](https://docs.amd.com/r/en-US/ug901-vivado-synthesis): HDL decode/selection과 target synthesis mapping에 관한 공식 가이드
- [OpenROAD, Gate Resizer](https://openroad.readthedocs.io/en/latest/main/src/rsz/README.html): fanout·capacitance·slew·long-wire repair에 관한 공식 physical 문서
