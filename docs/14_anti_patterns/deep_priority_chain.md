# Deep Priority Chain

`if` / `else if`는 여러 조건이 동시에 참일 때 앞 조건이 이긴다는 **functional priority**를 표현한다. 문제는 source order가 실제 requirement가 아니라 작성 습관일 뿐인데도, 많은 조건을 직렬로 나열해 깊은 priority network와 숨은 collision behavior를 만드는 경우다.

Priority와 MUX의 일반 원리는 [Priority and MUX](../01_fundamentals/priority_and_mux.md), timing path 분석은 [Critical Path](../03_timing/critical_path.md), wide datapath 선택 구조는 [Datapath MUX and Select](../10_datapath/mux_and_select.md)를 정본으로 삼는다. 이 문서는 review에서 **깊은 priority chain의 탐지, 실패 조건, 대안 선택과 필요한 증거**에 집중한다.

## 1. 문제: source order가 specification을 대신한다

다음 선택기는 `request[0]`이 가장 높고 `request[3]`이 가장 낮은 고정 priority를 정의한다.

```systemverilog
always_comb begin
    selected_data = fallback_data;
    grant         = 4'b0000;

    if (request[0]) begin
        selected_data = data[0];
        grant         = 4'b0001;
    end else if (request[1]) begin
        selected_data = data[1];
        grant         = 4'b0010;
    end else if (request[2]) begin
        selected_data = data[2];
        grant         = 4'b0100;
    end else if (request[3]) begin
        selected_data = data[3];
        grant         = 4'b1000;
    end
end
```

이 구조가 맞으려면 `request[0] > request[1] > request[2] > request[3]`이 명세여야 한다. 단지 먼저 떠오른 조건부터 썼거나, 실제로는 request가 서로 겹치지 않는다고 기대한다면 두 문제가 동시에 생긴다.

- 동시 request의 결과가 review되지 않은 source order로 결정된다.
- 뒤 후보는 앞 조건이 모두 거짓이라는 dependency를 거쳐야 하므로 깊은 selection path가 될 수 있다.

`if`를 `case`로 기계적으로 바꾸거나 줄 수를 줄여도 이 두 문제가 자동으로 해결되지 않는다.

## 2. Hardware view: 뒤 후보가 겪는 dependency

개념적인 직렬 mapping은 다음과 같다. 실제 synthesis tool은 factoring, priority encoder나 MUX tree로 재구성할 수 있지만 functional priority는 보존해야 한다.

```text
data[3] ── MUX3 ── MUX2 ── MUX1 ── MUX0 ──> selected_data
            ▲        ▲        ▲        ▲
         req[3]   req[2]   req[1]   req[0]

request[3]이 이기려면 request[0:2]가 모두 false임을 결정해야 한다.
```

Worst path가 반드시 `data[3]`에서 시작하는 것은 아니다. 다음 경로가 각각 bottleneck이 될 수 있다.

- Late request/decode → priority decision → final MUX select → capture FF
- 뒤 data candidate → 여러 selection level → capture FF
- High-fanout winning/valid signal → 먼 consumer와 replicated MUX
- State/compare → request generation → priority network → state update

```text
state/registers --> wide compare --> late condition --+
                                                    MUX --> capture FF
early data ------------------------------------------+
```

Post-synthesis cell depth가 얕아도 placement가 멀고 select fanout이 크면 net delay가 지배할 수 있다. 반대로 route가 짧아도 priority dependency와 wide data MUX의 cell delay가 문제일 수 있다.

## 3. Simultaneous condition은 기능 요구다

세 조건의 예를 먼저 표로 결정한다.

| `a` | `b` | `c` | Fixed-priority 결과 | Requirement 질문 |
|---:|---:|---:|---|---|
| 0 | 0 | 0 | fallback | Idle/hold/error 중 무엇인가? |
| 1 | 0 | 0 | A | A 단독 선택 |
| 0 | 1 | 1 | B | B가 C보다 높아야 하는가? |
| 1 | 1 | 0 | A | A가 B를 preempt하는가? |
| 1 | 1 | 1 | A | 동시 세 요청이 합법적인가? |

가능한 답은 하나가 아니다.

- Overlap이 합법이며 A가 먼저여야 한다: priority가 실제 specification이다.
- Overlap이 금지된다: mutual-exclusion contract와 violation behavior가 필요하다.
- 여러 request를 같은 cycle에 보존해야 한다: 하나를 버리는 priority MUX가 아니라 queue/merge가 필요하다.
- 장기적으로 모두 service되어야 한다: arbitration fairness와 starvation bound가 필요하다.

Source order를 바꾸기 전에 simultaneous-event policy부터 확정한다.

## 4. `unique`와 assertion은 현실을 바꾸지 않는다

`unique`, `unique0`, `priority` qualifier는 의도 표현, simulation diagnostic과 일부 synthesis optimization에 유용할 수 있다. 그러나 qualifier를 추가한다고 upstream에서 두 condition이 동시에 참이 되는 회로가 사라지지는 않는다.

```systemverilog
unique0 case (1'b1)
    select_a: selected_data = data_a;
    select_b: selected_data = data_b;
    select_c: selected_data = data_c;
    default:  selected_data = fallback_data;
endcase
```

이 코드는 exclusivity를 **주장**할 뿐 증명하지 않는다. Overlap 입력에서 simulator warning, X behavior와 synthesized implementation의 의미는 사용하는 language/tool option과 flow에서 확인해야 한다. Assertion도 위반을 검출하거나 formal proof의 목표가 될 수 있지만, assertion 자체가 illegal input을 막는 hardware는 아니다.

```systemverilog
ap_select_is_zero_or_one_hot:
    assert property (@(posedge clk) disable iff (!rst_n)
        $onehot0({select_c, select_b, select_a}));

cp_overlap_attempt:
    cover property (@(posedge clk) disable iff (!rst_n)
        $countones({select_c, select_b, select_a}) > 1);
```

Assertion을 assumption으로 바꾸면 proof 환경이 overlap을 금지할 수 있다. 그 assumption이 실제 upstream protocol guarantee인지, DUT 내부에서 assert해야 할 의무인지 ownership을 분리한다.

## 5. Better architecture: 문제의 종류에 맞게 바꾼다

### 5.1 조건이 실제로 mutually exclusive인 경우

Zero-hot 또는 one-hot이 보장되고 multiple-hot을 정의할 필요가 없다면 priority dependency가 없는 one-hot selection 후보를 검토할 수 있다.

```systemverilog
always_comb begin
    selected_data = '0;

    for (int unsigned i = 0; i < NUM_INPUTS; i++) begin
        selected_data |= ({DATA_W{select_oh[i]}} & data[i]);
    end
end
```

이 OR-based 구조는 multiple-hot일 때 여러 data를 섞으므로 priority 구현과 기능적으로 다르다. `$onehot0(select_oh)`를 보장하고 no-match 결과가 0이라는 contract가 맞을 때만 사용한다. 또한 loop 표현이 특정 balanced tree를 보장하지 않으므로 mapped logic depth와 route를 확인한다.

Binary selector의 exact-value `case`도 후보지만, 문법만으로 balanced topology를 단정하지 않는다. Selector decode, data width와 physical locality가 실제 mapping을 결정한다.

### 5.2 Priority는 필요하지만 chain이 너무 깊은 경우

| 대안 | 기대 효과 | 비용·새 계약 |
|---|---|---|
| Parallel predecode | 늦은 복합 조건을 앞당길 수 있음 | Decode area, switching와 fanout 증가 가능 |
| Grouping/hierarchical priority | 한 단계의 fan-in을 줄일 수 있음 | Group 간 priority와 최악 latency를 새로 정의 |
| Candidate precompute | Select 이후 logic을 줄임 | 여러 후보 operator의 area/power 증가 |
| Pipeline decision | Stage별 timing budget 확보 | Latency, FF/clock power, control 정렬 변화 |
| Stateful/round-robin arbitration | Fairness와 분산된 decision | State, reset, II와 arbitration latency 추가 |
| Request queue | 동시 요청 보존 | Storage, backpressure와 overflow policy 필요 |
| Local decode/duplication | Fanout와 long route 완화 가능 | Area와 coherency/physical 검증 비용 |

우선순위 후보 수를 줄이는 architecture가 가능하면 가장 먼저 검토한다. 이미 upstream에서 같은 의미의 request를 합칠 수 있는지, inactive mode의 candidate를 제거할 수 있는지 본다.

### 5.3 Data와 decision을 분리한다

Wide data path가 priority 조건 생성과 같은 cycle에 얽혀 있다면 winner index 또는 one-hot grant를 먼저 register하고 다음 stage에서 data를 선택하는 구조가 timing을 단순화할 수 있다.

```text
cycle K:   request/decode --> registered grant
cycle K+1: local data MUX  --> registered result
```

이것은 latency를 한 cycle 늘리는 실제 hardware 변경이다. Interface latency와 back-to-back request identity를 grant/data tag로 함께 정렬해야 한다. Negative slack만 보고 pipeline을 넣지 않고 [Pipeline Design](../03_timing/pipeline.md)의 latency·throughput contract를 적용한다.

## 6. Priority를 없애면 안 되는 경우

Priority가 실제 기능인 다음 구조에서는 OR-selection으로 억지로 바꾸면 안 된다.

- Exception/interrupt의 architecturally defined precedence
- Reset, flush, error, load와 normal update의 event priority
- Fixed-priority arbiter가 safety 또는 QoS policy로 요구됨
- Age/urgency에 따라 deterministic service 순서가 필요한 scheduler
- Illegal state에서 safe action이 normal action을 override해야 함

이때 review 질문은 “priority를 없앨 수 있는가?”가 아니라 다음과 같다.

- Lowest-priority request가 무한히 기다릴 수 있는가?
- Starvation이 허용되면 어떤 mode와 이유인가?
- Bounded response requirement와 maximum arbitration latency는 얼마인가?
- Preemption 중 이미 accepted된 transaction을 drain, abort 또는 preserve하는가?
- Priority update state의 reset과 simultaneous request behavior가 정의됐는가?

Round-robin이 언제나 더 좋은 것도 아니다. Fairness를 얻는 대신 state, combinational decision과 verification surface가 늘어난다.

## 7. Synthesis·STA·PPA evidence

### Synthesis

- Priority encoder/MUX level과 actual candidate 수
- `unique`/one-hot assumption이 optimization에 사용됐는지와 diagnostic
- Shared operator 앞뒤의 input/output MUX
- Grant/select replication과 high-fanout buffer
- Unexpected latch, incomplete assignment와 no-match behavior

### STA와 physical

- First/last candidate data path와 각 condition path를 분리해 본다.
- Select arrival, MUX pin arc, cell/net delay와 fanout을 확인한다.
- Pre-route 개선을 post-route closure로 해석하지 않는다.
- Grouping/duplication 후 새 bottleneck, hold, max slew/cap과 congestion을 다시 본다.
- 모든 supported mode/corner에서 priority cone이 sensitizable한지 확인한다.

### PPA

Balanced/predecoded 구조는 timing을 개선할 수 있지만 병렬 decode와 candidate switching을 늘릴 수 있다. Pipeline은 FF/clock power와 latency를, stateful arbitration은 state와 control activity를 추가한다. 동일 top·constraints·activity·physical stage에서 before/after를 비교한다.

## 8. Verification strategy

- Zero-hot, 각 one-hot, 모든 legal multiple-hot 조합을 truth table과 연결한다.
- Highest/lowest candidate, back-to-back request와 request 유지 상황을 검증한다.
- Fixed priority라면 winner와 non-winner 보존/유실 policy를 검사한다.
- Fair arbiter라면 환경이 request를 유지한다는 조건 아래 bounded service 또는 starvation cover를 둔다.
- One-hot assumption은 assertion과 overlap을 시도하는 negative test/cover로 검출 능력을 확인한다.
- RTL 변경 전후에 output뿐 아니라 acceptance, latency, grant identity와 side effect를 equivalence/scoreboard로 비교한다.
- Synthesis/post-route에서 worst path가 예상 data 또는 condition branch와 일치하는지 cross-probe한다.

Assertion pass만으로 overlap이 실제 환경에서 도달하지 않는다는 것이 증명됐는지, antecedent가 미도달해 vacuous pass인지 구분한다. 자세한 방법은 [Assertion-Driven RTL](../13_verification/assertion_driven_rtl.md)과 [Corner-Case Matrix](../13_verification/corner_case_matrix.md)을 참고한다.

## 9. Design Review Checklist

- [ ] `if` / `else if` 순서가 실제 functional priority인가?
- [ ] 모든 simultaneous condition의 winner/drop/queue behavior가 정의됐는가?
- [ ] Mutually exclusive라는 주장이 upstream contract와 assertion으로 검증되는가?
- [ ] `unique`/`priority` qualifier가 exclusivity를 만들어 준다고 오해하지 않는가?
- [ ] First/last data와 각 late condition path를 STA에서 확인했는가?
- [ ] Select fanout, data width, MUX depth와 physical locality를 확인했는가?
- [ ] OR/one-hot selection의 multiple-hot 결과가 허용되는가?
- [ ] Predecode/grouping/precompute가 area와 switching을 과도하게 늘리지 않는가?
- [ ] Pipeline의 latency·control alignment와 II가 interface requirement에 맞는가?
- [ ] Arbiter의 fairness, starvation와 maximum service latency가 정의됐는가?
- [ ] Synthesis mapping과 post-route critical path가 구조 가설과 일치하는가?
- [ ] 대안 비교가 동일 constraint·corner·activity·physical stage에서 수행됐는가?

## 관련 문서

- [Priority and MUX](../01_fundamentals/priority_and_mux.md): functional priority, exclusivity와 RTL construct의 정본
- [Critical Path](../03_timing/critical_path.md): late control, cell/net delay와 report 분석
- [Datapath MUX and Select](../10_datapath/mux_and_select.md): wide MUX topology와 data/select 정렬
- [Resource Sharing vs Duplication](../02_architecture/resource_sharing_vs_duplication.md): MUX·arbitration·locality trade-off
- [Priority and Simultaneous Events](../09_control_logic/priority_and_simultaneous_events.md): collision policy와 acceptance
- [Fanout and Locality](../12_physical_aware/fanout_and_locality.md): select replication과 physical evidence

## 참고 자료

- [IEEE, IEEE Std 1800-2023 SystemVerilog](https://standards.ieee.org/ieee/1800/7743/): `if`, `case`, `unique`와 `priority` 의미의 normative language reference
- [AMD, Vivado Design Suite User Guide: Synthesis (UG901)](https://docs.amd.com/r/en-US/ug901-vivado-synthesis): HDL selection construct와 target synthesis mapping에 관한 공식 가이드
- [OpenROAD, Gate Resizer](https://openroad.readthedocs.io/en/latest/main/src/rsz/README.html): placement 기반 추정과 routed parasitic 차이를 포함한 physical optimization 공식 문서
