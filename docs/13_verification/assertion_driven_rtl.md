# Assertion-Driven RTL

Assertion은 waveform을 대신 읽어 주는 조건문에 그치지 않는다. **어느 edge에서 무엇을 받아들이고, 어떤 state가 바뀌며, 어떤 환경 조건 아래 그 결과를 보장하는지**를 실행 가능한 contract로 남기는 방법이다. Assertion 개수가 많아도 acceptance, priority 또는 reset 경계가 빠져 있으면 중요한 오류는 그대로 남는다.

이 문서는 requirement를 assumption, assertion과 cover로 나누고, RTL의 register update와 SVA의 sampling을 맞추는 방법을 다룬다. Architecture 결정 자체는 [Requirement to Microarchitecture](../02_architecture/requirement_to_microarchitecture.md), 시험 조합과 evidence 관리는 [Corner-Case Matrix](corner_case_matrix.md)가 정본이다. 아래 코드는 교육용이며 특정 simulator/formal tool에서 실행 완료된 regression을 뜻하지 않는다.

## 1. Requirement를 세 가지 질문으로 분리한다

다음 세 문장은 서로 다른 책임을 가진다.

| 구분 | 질문 | 예 | 잘못 사용했을 때 |
|---|---|---|---|
| Environment assumption | Producer/integration이 무엇을 보장하는가? | Stall 중 input valid/data 유지 | 실제 가능한 입력을 제거해 bug를 숨김 |
| Design assertion | 그 조건에서 DUT가 무엇을 보장해야 하는가? | Accepted transaction이 한 번만 전달됨 | DUT가 해야 할 일을 환경 책임으로 돌림 |
| Coverage intent | 의미 있는 상황이 실제로 검증 범위에 들어왔는가? | Full 상태에서 consume/refill 동시 발생 | 한 번 도달한 것을 모든 경우의 correctness로 오해 |

Block formal에서 input protocol을 assume했다면 상위 integration에서는 그 producer의 동작을 assert하거나 별도 evidence로 입증해야 한다. DUT output에 원하는 결과를 assume해 놓고 같은 결과를 assert하면 DUT의 책임을 증명한 것이 아니다.

Assumption은 편리한 search-space 축소 장치가 아니라 명세의 일부다. Owner, 적용 configuration, reset/clock 조건과 변경 시 재검토 대상을 함께 기록한다. YosysHQ의 [Formal extensions to Verilog](https://symbiyosys.readthedocs.io/en/latest/verilog.html#systemverilog-immediate-assertions)도 assumption의 탐색 범위 제한, assertion의 반례 탐색, cover의 도달 witness를 구분한다. 그 문서의 immediate formal syntax와 아래 concurrent SVA를 동일한 frontend 지원으로 간주하지 않는다.

## 2. 작은 Hardware Contract: Sticky Event Bank

Generic 예제로 `W`개의 독립적인 pending bit를 둔다. 각 bit는 “clear되지 않은 사건이 하나 이상 있음”을 표현하며 **사건의 개수나 순서를 저장하지 않는다**. 그 한계와 queue가 필요한 조건은 [Pulse, Level, and Event](../09_control_logic/pulse_level_event.md)를 참고한다.

Contract는 다음과 같다.

- `W >= 1`; 모든 입력은 `clk`와 같은 synchronous domain에 있다.
- Active-high **synchronous reset**이며 priority는 `reset → event set → clear → hold`다.
- `event_mask[b]`와 `clear_mask[b]`가 동시에 1이면 새 사건을 남기기 위해 set이 이긴다.
- 여러 bit의 event/clear는 같은 edge에서 독립적으로 처리한다. Mutual exclusion을 요구하지 않는다.
- Reset 중의 event는 보존하지 않는다. 별도의 ready/acceptance handshake는 없다.
- Pending 중 같은 bit의 event가 반복되면 하나로 합쳐진다. 모든 사건의 개별 처리를 보장하는 구조가 아니다.
- Functional check는 known `rst`와 정상 동작 중 known mask를 전제로 한다. X/Z 검사는 그 전제가 지켜지는지 별도로 확인한다.

```text
pending_q[b] ----+                       +---------+
                +-- hold/clear/set ---->| D     Q |---- pending_q[b]
clear_mask[b] --+         ^              |   FF    |
event_mask[b] -----------+               +---------+
                         synchronous reset wins

Each bit: reset > event set > clear > hold
```

```systemverilog
module sticky_event_bank #(
  parameter int unsigned W = 3
) (
  input  logic         clk,
  input  logic         rst,
  input  logic [W-1:0] event_mask,
  input  logic [W-1:0] clear_mask,
  output logic [W-1:0] pending_q
);
  // Synchronous reset; a new event wins over a same-bit clear.
  always_ff @(posedge clk) begin
    if (rst)
      pending_q <= '0;
    else
      pending_q <= (pending_q & ~clear_mask) | event_mask;
  end
endmodule
```

`W=0`은 지원하지 않는다. Port range에 이미 parameter가 사용되므로 module 내부의 runtime assertion만으로 잘못된 elaboration을 막는다고 가정하지 않는다. Configuration/build 단계에서 먼저 범위를 검사한다.

## 3. RTL Update와 Assertion Sample을 맞춘다

일반적인 single-clock concurrent assertion은 edge의 sampled value를 사용한다. 그 edge의 nonblocking assignment(NBA)로 갱신된 Q를 같은 sampled value로 읽는 것이 아니다.

```text
                    E0                         E1
posedge             |                          |
SVA sample          old Q, event=1              Q=1
RTL NBA             Q <- 1                     next update
                    +--------------------------+
                    event |=> pending checks here, at E1 sample
```

E0에서 event가 sample되면 Q는 E0의 NBA에서 바뀐다. `event |=> pending`은 그 결과를 **E1의 sample**에서 확인한다. Hardware에 두 번째 pipeline stage가 생긴다는 뜻이 아니다. Same-clock downstream FF도 E0에서는 old Q를, E1에서는 E0 update 결과를 볼 수 있다.

| 표현 | Single-cycle antecedent에 대한 의미 | 적절한 용도 |
|---|---|---|
| `a \|-> b` | a와 같은 sample에서 b 확인 | Acceptance와 enable의 같은-edge 관계 |
| `a \|=> b` | a 다음 clock sample에서 b 확인 | 현재 edge의 register update 결과 |
| `$past(x)` | 해당 property clock의 이전 sample | 이전 입력/상태와 현재 Q 비교 |
| `$stable(x)` | 현재와 이전 sampled value의 안정성 검사 | 이전 edge가 hold였을 때 Q 유지 |

Antecedent가 여러 cycle인 sequence이면 consequent의 시작은 그 sequence가 **끝난 시점**을 기준으로 정한다. Implication과 delay를 무심코 겹치면 검증 latency가 바뀐다. 관련 연산자 관계는 Verification Academy의 [nonoverlapped implication 설명](https://verificationacademy.com/forums/t/overlapped-implication-and-nonoverlapped-imlplication/30733)을 참고한다.

Testbench는 입력을 DUT sampling edge와 경합하도록 drive하지 않는다. Clocking block/skew 또는 명시적으로 분리한 drive/check edge를 사용하고, assertion failure를 볼 때도 sampled input, old state, NBA result를 분리한다.

## 4. 한 개의 복사된 식보다 독립적인 Local Property

DUT의 next-state 식을 그대로 assertion에 복사하면 같은 priority 오류를 두 군데에 쓸 수 있다. 다음 checker는 specification의 reset/set/clear/hold를 별도 property로 분해한다. **Verification용 module**이며, 실제 flow에서는 명시적 instance 또는 지원되는 bind 방식으로 DUT signal에 연결한다.

```systemverilog
module sticky_event_bank_properties #(
  parameter int unsigned W = 3
) (
  input logic         clk,
  input logic         rst,
  input logic [W-1:0] event_mask,
  input logic [W-1:0] clear_mask,
  input logic [W-1:0] pending_q
);
  ap_reset_known: assert property (@(posedge clk)
    !$isunknown(rst));

  ap_masks_known: assert property (@(posedge clk)
    !rst |-> !$isunknown({event_mask, clear_mask}));

  ap_reset: assert property (@(posedge clk)
    rst |=> pending_q == '0);

  for (genvar b = 0; b < W; b++) begin : g_bit_checks
    ap_set: assert property (@(posedge clk)
      (!rst && event_mask[b]) |=> pending_q[b]);

    ap_clear: assert property (@(posedge clk)
      (!rst && !event_mask[b] && clear_mask[b]) |=> !pending_q[b]);

    ap_hold: assert property (@(posedge clk)
      (!rst && !event_mask[b] && !clear_mask[b])
      |=> $stable(pending_q[b]));

    cp_set_clear: cover property (@(posedge clk)
      (!rst && event_mask[b] && clear_mask[b]) ##1 pending_q[b]);
  end
endmodule
```

Known input과 reset으로 확립한 known state에 대해 각 bit는 매 edge에서 reset/set/clear/hold 중 하나에 들어간다. Set property에 `!clear_mask[b]`를 붙이지 않는 것이 중요하다. 붙이면 가장 위험한 동시 set/clear를 검사 대상에서 제외하게 된다.

`cp_set_clear`는 동시 입력과 그 다음의 pending sample이 있는 trace를 확인한다. Assert는 모든 검사 대상 trace에서 결과를 요구하고, cover는 그 상황의 도달 가능성을 확인한다. 두 검사를 두는 이유는 서로 다르다.

Checker는 reset을 발생시키지 않는다. Simulation harness에서는 시작 시 적어도 하나의 active edge에서 reset을 sample하게 하고, formal harness에서는 초기 상태/reset의 처리를 명시한다. Reset 없는 임의 초기 상태까지 증명하려면 일반적인 reset 후 contract와 별도의 검증 조건으로 다룬다.

## 5. Reset 때 Check를 중단하는 것과 Reset을 검증하는 것

위 DUT는 synchronous reset이므로 property에도 `rst`의 **sample된 priority**를 직접 썼다. `disable iff (rst)`는 의도적으로 사용하지 않았다.

E0에서 set하고 E1에서 reset이 sample된 경우, E1의 assertion sample에는 E0의 set 결과가 아직 보인다. E1의 reset 결과가 보이는 것은 E2의 sample이다. 이 계약에서 `ap_set`과 `ap_reset`은 양립한다.

반면 일반적인 `disable iff (rst)`는 진행 중인 property evaluation을 비동기적으로 abort하는 의미이며, synchronous reset의 갱신 결과를 확인하는 기능이 아니다. Clock 사이에만 있는 reset pulse도 check를 중단시킬 수 있으므로 “DUT의 reset이 동기식이니 disable도 동기식”이라고 생각하지 않는다. Verification Academy의 [disable iff sampling 설명](https://verificationacademy.com/forums/t/regarding-disable-iff/50484/3)도 일반 disable expression과 sampled expression을 구분한다.

Asynchronous reset의 DUT에서는 진행 중인 transaction의 check를 abort하는 것이 맞을 수 있다. 그래도 다음 항목을 각각 검토한다.

- Reset으로 어떤 obligation을 폐기해도 되는가.
- Reset assertion 시 출력 mask와 state 초기화를 무엇으로 검증하는가.
- Release 후 첫 유효 sample을 어디서부터 세는가.
- Checker 자체의 history와 scoreboard도 같은 transaction을 폐기하는가.

Async reset의 회로 구조, release와 RDC의 책임은 [Reset Architecture Overview](../07_reset/overview.md)와 [Reset Deassertion and RDC](../07_reset/reset_deassertion.md)에 분리한다. SVA의 abort만으로 그 안전성을 증명할 수 없다.

## 6. `$past`의 첫 Sample과 Unknown을 숨기지 않는다

첫 sample에는 유효한 과거 관측이 없다. 위 `ap_hold`는 nonoverlapped implication의 다음 sample에서 `$stable`을 사용하므로 해당 property attempt를 시작한 sample이 존재한다. 처음부터 `$past`를 사용하는 같은 시점의 check에는 history guard를 준비한다.

다음은 같은 checker 안에 둘 수 있는 **다른 표현의 예**이며, `ap_reset`과 둘 다 필수로 두라는 뜻은 아니다.

```systemverilog
// Verification-only history, not a DUT power-on initialization promise.
logic history_valid = 1'b0;
always_ff @(posedge clk)
  history_valid <= 1'b1;

ap_previous_reset: assert property (@(posedge clk)
  (history_valid && $past(rst)) |-> pending_q == '0);
```

이 history는 경과한 sample 수만 나타내며 DUT가 reset을 마쳤다는 의미가 아니다. 여러 cycle의 history, clock 정지, mode 전환을 다룰 때는 필요한 유효 기간을 별도로 정의한다. Checker 변수의 초기화도 선택한 simulator/formal frontend의 처리를 확인한다.

Four-state simulation에서는 unknown을 포함한 antecedent가 기대한 대로 trigger되지 않아 겉보기 failure가 줄어들 수 있다. Functional property와 별도로 control의 knownness를 검사한다. 반대로 resetless payload처럼 invalid 기간의 X가 허용되는 signal을 무조건 known으로 요구하면 architecture contract를 좁히게 된다.

Two-state 분석의 pass를 X 전파 검증 결과라고 부르지 않는다. `===`로 X끼리 일치시키는 것도 knownness의 증명이 아니다. 자세한 내용은 [Resetless Datapath](../07_reset/resetless_datapath.md)를 참고한다.

## 7. Safety, Progress와 Transaction Identity

Safety는 “금지한 일이 일어나지 않는다”, progress는 “필요한 일이 앞으로 진행된다”라는 별개의 요구다. 예를 들어 ready가 영원히 낮은 환경에서는 DUT가 payload를 올바르게 유지해도 delivery는 완료되지 않는다.

| Contract | 필요한 확인 | 불충분한 대체 검사 |
|---|---|---|
| Stall 중 유지 | Valid 지속과 payload 안정성, cancel 예외 | Data만 stable |
| No drop / no duplicate | Acceptance 기준 개수·내용·순서 | Response가 언젠가 한 번 high |
| Bounded response | Accepted 시점부터의 기한과 대상 transaction | Busy가 된 시점부터 모호하게 시간 측정 |
| Eventual progress | Clock 동작, fairness, reset/cancel 조건 | 무제한 stall을 허용하면서 완료 요구 |

여러 outstanding이 있으면 “request 후 response가 있다”라는 property만으로는 다른 request의 response를 잘못 대응시킬 수 있다. ID, 순서가 있는 reference queue, occupancy conservation 등으로 대응 관계를 검증한다. Architecture상의 acceptance/storage는 [Buffering and Backpressure](../02_architecture/buffering_and_backpressure.md)를 참고한다.

이번 sticky bank는 개별 transaction queue가 아니다. Repeated event의 개수 보존이나 clear하지 않아도 언젠가 pending이 사라지는 성질을 요구할 수 없다. Assertion이 표현하지 못하는 것이 아니라 hardware contract가 그 보장을 갖고 있지 않다.

## 8. Vacuity와 Over-Constraint를 의심한다

Implication은 antecedent가 한 번도 성립하지 않아도 failure를 내지 않는다. 예를 들어 실수로 event를 항상 0으로 묶으면 `ap_set`은 설계의 set 동작을 거의 설명하지 못한다.

확인할 것은 pass/fail만이 아니다.

1. 대상 instance·parameter에 checker가 elaborate되고 check가 활성화되어 있는가.
2. Reset이 해제되고 각 antecedent가 실제로 성립하는가.
3. 동시 event, 연속 event, nonzero에서의 clear에 도달할 수 있는가.
4. Assumption이 reset을 영구히 유지하거나 합법적인 collision을 금지하지 않는가.
5. Proof 범위, bounded depth, timeout/unknown을 구분하는가.
6. 의도적으로 priority를 망가뜨린 검증 전용 variant에서 기대한 property가 실패하는가.

Formal cover가 탐색 depth 안에서 발견되지 않았다는 사실만으로 unreachable의 증명이라고 부르지 않는다. Simulation의 coverage hole도 unreachable이라고 단정할 수 없다. Harness 부족, 과도한 constraint, 미실행, 명세상 제외를 구분해 기록한다.

Mutation 확인은 격리된 검증 대상에서 수행하고 망가뜨린 RTL을 본체에 남기지 않는다. 여기의 mutation은 checker 평가 방법의 제안이며, 이 문서의 코드를 EDA로 실행했다는 보고가 아니다.

## 9. Synthesis와 PPA의 관계

Sticky bank의 DUT는 W개의 state bit와 각 bit의 hold/clear/set/reset 선택에 대응하는 logic으로 mapping될 수 있다. 실제 MUX/AOI/OAI 구성, enable cell 활용, reset mapping은 tool, library와 최적화 조건에 따른다. RTL의 OR/AND 표기만으로 고정된 cell 수를 단정하지 않는다.

일반적인 verification-only checker를 implementation filelist에서 제외하는 flow라면 그 checker는 제품 datapath의 FF/logic이 되지 않는다. 다만 assertion을 monitor hardware로 변환하는 flow나 debug instrumentation을 선택하면 area, clock power, routing과 timing 비용이 발생한다. “Assertion은 항상 합성에서 사라진다”라고 취급하지 않는다.

| RTL 변경 | Assertion으로 보호할 contract | 별도로 필요한 PPA evidence |
|---|---|---|
| Enable 추가 | Clear/reset이 disable에 막히지 않음 | Enable cone, clock/FF activity |
| Logic sharing | Priority, 동시 event, acceptance 유지 | MUX, fanout, critical path |
| State/width 축소 | Reachable range와 observer의 동작 유지 | Mapped area, decode, physical footprint |
| Pipeline 추가 | 새로운 latency와 data/control 대응 | Setup/hold, clock power, II |

Pipeline 추가로 계약을 바꾸면 기존 property를 단순히 완화하지 않고 requirement와 consumer 측 check도 갱신한다. Assertion이 통과해도 STA, CDC/RDC, glitch나 metastability의 physical safety, power intent 검증은 별도로 필요하다.

## 10. 실행 조건과 Review Evidence

Tool 이름만으로 “SVA 지원”이라고 판단하지 않는다. Frontend/version, clocking, supported sequence, bind, X semantics, assertion enable 설정을 확인한다. 예를 들어 Verilator의 [Input Languages](https://verilator.org/guide/latest/languages.html#assertions)는 assertion과 functional coverage를 부분 지원한다고 명시한다. 여기의 concurrent SVA를 다른 flow의 immediate assertion으로 검토 없이 바꾸지 않는다.

최소한 requirement ID, property label과 instance, RTL/checker/harness revision, configuration, assumption, run 결과와 미검증 범위를 남긴다. Failure는 다음 순서로 분류한다.

1. Requirement와 priority가 실제로 합의되어 있는가.
2. Checker의 sampling/reset/history가 DUT와 맞는가.
3. 입력 환경이 contract를 만족하는가.
4. DUT가 그 contract를 위반하는가.

Checker bug도 DUT bug도 있을 수 있다. 통과만을 목적으로 assumption을 추가하거나 antecedent를 좁히지 않는다.

## 11. Design Review Questions

- [ ] Assumption, DUT guarantee, cover intent의 owner를 구분했는가.
- [ ] Sampled value, NBA update, consumer edge와 latency를 설명할 수 있는가.
- [ ] Reset/set/clear/hold의 priority를 동시 입력까지 검사하는가.
- [ ] `$past`의 history와 DUT reset 완료 상태를 혼동하지 않는가.
- [ ] Reset abort와 별도로 reset 결과와 release 후 동작을 확인하는가.
- [ ] Knownness 요구를 control과 invalid payload에서 구분했는가.
- [ ] No-drop과 progress에 acceptance, transaction identity와 환경 조건이 있는가.
- [ ] Antecedent/cover에 도달하고 합법적인 corner를 assume으로 없애지 않았는가.
- [ ] Bounded pass, proof, unreachable, unknown, 미실행을 구분해 보고하는가.
- [ ] Assertion 결과와 STA/CDC/RDC/PPA evidence를 별도 책임으로 취급하는가.

## 관련 문서

- [Corner-Case Matrix](corner_case_matrix.md)
- [Lint, Formal, and Equivalence](lint_formal_equivalence.md)
- [Reset and Mode Transition Verification](reset_mode_transition_verification.md)
- [Priority and Simultaneous Events](../09_control_logic/priority_and_simultaneous_events.md)
- [Microarchitecture Decision Record](../02_architecture/microarchitecture_decision_record.md)
- [Enable and MUX Inference](../11_synthesis/enable_and_mux_inference.md)
- [Multi-Cycle Path](../03_timing/multi_cycle_path.md)
- [RTL Design Review Checklist](../15_checklist/rtl_design_review_checklist.md)
