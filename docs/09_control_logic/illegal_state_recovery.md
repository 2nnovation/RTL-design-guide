# Illegal State Recovery

Illegal condition은 단순히 FSM register가 선언되지 않은 bit pattern이 된 경우만을 뜻하지 않는다. **Illegal encoding, illegal transition request, protocol-illegal event 조합**을 구분하고, 그 cycle의 side effect와 이후 recovery를 각각 정의해야 한다.

State encoding과 PPA 비교는 [FSM and Counter Encoding](../05_area/fsm_counter_encoding.md), 정상 기능의 phase/acceptance 설계는 [FSM Design](fsm_design.md)가 정본이다. 이 문서는 fault containment와 recovery contract에 집중한다.

## 1. Illegal의 세 종류

| 종류 | 예 | 검출 관점 | 필요한 결정 |
|---|---|---|---|
| Illegal encoding | one-hot FSM의 zero-hot/multi-hot, unused binary code | current state bits | side-effect 차단, recovery state, error 기록 |
| Illegal transition | 현재 phase에서 허용되지 않은 next-state command | state + command | reject/hold/fail-stop, requester response |
| Protocol-illegal event | idle 중 completion, duplicate response, forbidden overlap | event history/ownership | error attribution, resynchronization 또는 escalation |

Encoding이 legal이어도 protocol history가 틀릴 수 있다. 예를 들어 `ST_RUN`은 legal code지만 accepted request가 없는데 completion이 왔다면 ownership contract 위반이다. 반대로 physical upset으로 unused encoding에 들어갔어도 바로 `IDLE`로 이동하는 것이 항상 protocol상 안전한 것은 아니다.

## 2. Recovery 목표를 먼저 선택한다

대표 정책은 다음과 같다.

### Safe-state recovery

Illegal cycle에는 write/commit/accept를 모두 막고 다음 edge에 known idle/safe state로 이동한다. Operation을 재시작해도 외부 일관성이 깨지지 않는 controller에 적합할 수 있다.

### Hold and report

State를 유지하고 sticky error 또는 interrupt를 올린다. Debug에는 유리하지만 corrupted encoding이 계속 unsafe decode를 만들지 확인해야 한다.

### Fail-stop

Output을 inactive 상태로 고정하고 privileged clear/reset 전까지 새 transaction을 받지 않는다. 중복 side effect가 복구보다 위험한 protocol에 적합하다.

### Reset/escalation request

Local recovery가 ownership을 재구성할 수 없으면 block/domain/system reset이나 higher-level recovery를 요청한다. Reset이 다른 domain과 shared resource에 미치는 영향도 함께 정의한다.

“Default에서 `IDLE`로 간다”는 recovery mechanism의 한 부분일 뿐이다. Illegal cycle에 이미 write pulse가 나갔는지, in-flight payload를 누가 폐기하는지, peer가 어느 phase라고 생각하는지, error가 관찰되는지를 함께 검토한다.

## 3. Side Effect는 Legal Decode에서만 만든다

안전한 기본 형태는 다음과 같다.

1. Next state를 safe recovery state 또는 current state로 default한다.
2. Write, commit, accept와 valid output을 inactive로 default한다.
3. Explicit legal state branch에서만 side effect를 enable한다.
4. `default`에서 error event를 만들고 recovery policy를 적용한다.

`casex`는 X/Z를 wildcard로 취급해 illegal simulation state를 legal branch로 잘못 match시킬 수 있으므로 control recovery decode에 사용하지 않는다. `casez`도 Z/`?` wildcard가 정말 protocol requirement일 때만 제한적으로 사용한다. 일반 FSM state decode에는 plain `case`가 명확하다.

## 4. Generic Recover-to-Idle Controller

다음 one-hot 예제는 illegal encoding에서 side effect를 막고 다음 edge에 `ST_IDLE`로 복구한다. Encoding 또는 protocol error를 sticky status에 기록하며, error event와 `error_clear`가 겹치면 새 error가 우선한다.

이 policy는 availability를 우선해 recovery 뒤 새 request를 받을 수 있게 한다. 외부 write의 exactly-once 보장이 필요한 시스템에서는 이 자동 재개가 적합하지 않을 수 있으며 fail-stop 또는 reset handshake로 바꿔야 한다.

```systemverilog
module recoverable_controller #(
  parameter int unsigned DATA_W = 16
) (
  input  logic              clk,
  input  logic              rst_n,

  input  logic              req_valid,
  output logic              req_ready,
  input  logic [DATA_W-1:0] req_data,

  input  logic              complete,
  input  logic [DATA_W-1:0] complete_data,

  output logic              op_active,
  output logic [DATA_W-1:0] op_data,

  output logic              rsp_valid,
  input  logic              rsp_ready,
  output logic [DATA_W-1:0] rsp_data,

  input  logic              error_clear,
  output logic              state_error_event,
  output logic              protocol_error_event,
  output logic              error_sticky,
  output logic              start_pulse,
  output logic              commit_pulse
);
  typedef enum logic [2:0] {
    ST_IDLE = 3'b001,
    ST_RUN  = 3'b010,
    ST_RESP = 3'b100
  } state_t;

  state_t state_q, state_d;
  logic [DATA_W-1:0] operation_q;
  logic [DATA_W-1:0] response_q;
  logic req_accept, rsp_accept;

  assign op_data   = operation_q;
  assign rsp_data  = response_q;

  assign req_accept = req_valid && req_ready;
  assign rsp_accept = rsp_valid && rsp_ready;
  assign start_pulse = req_accept;

  generate
    if (DATA_W < 1) begin : g_bad_data_width
      initial $fatal(1, "DATA_W must be at least 1");
    end
  endgenerate

  // Exact-match safe decode: X-containing or unused encodings enable nothing.
  always_comb begin
    req_ready = 1'b0;
    op_active = 1'b0;
    rsp_valid = 1'b0;

    case (state_q)
      ST_IDLE: req_ready = rst_n;
      ST_RUN:  op_active = rst_n;
      ST_RESP: rsp_valid = rst_n;
      default: ;
    endcase
  end

  always_comb begin
    // Safe defaults: no side effect from an unrecognized encoding.
    state_d              = ST_IDLE;
    state_error_event    = 1'b0;
    protocol_error_event = 1'b0;
    commit_pulse         = 1'b0;

    unique case (state_q)
      ST_IDLE: begin
        state_d = ST_IDLE;
        if (req_accept)
          state_d = ST_RUN;
        if (rst_n && complete)
          protocol_error_event = 1'b1;
      end

      ST_RUN: begin
        state_d = ST_RUN;
        if (rst_n && complete) begin
          state_d      = ST_RESP;
          commit_pulse = 1'b1;
        end
      end

      ST_RESP: begin
        state_d = ST_RESP;
        if (rsp_accept)
          state_d = ST_IDLE;
        if (rst_n && complete)
          protocol_error_event = 1'b1;
      end

      default: begin
        state_d           = ST_IDLE;
        state_error_event = rst_n;
      end
    endcase
  end

  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      state_q     <= ST_IDLE;
      error_sticky <= 1'b0;
    end else begin
      state_q <= state_d;

      // New error dominates a simultaneous software/status clear.
      if (state_error_event || protocol_error_event)
        error_sticky <= 1'b1;
      else if (error_clear)
        error_sticky <= 1'b0;

      if (req_accept)
        operation_q <= req_data;

      if (commit_pulse)
        response_q <= complete_data;
    end
  end
endmodule
```

`op_active`와 `op_data`는 별도 transfer handshake가 아니라, executor가 현재 accepted operation context를 읽을 수 있게 하는 **state-qualified level**이다. `op_data`는 `op_active=1`인 동안만 유효하다. `complete`는 accepted operation당 한 번만 `ST_RUN`에서 발생하는 same-domain event라는 contract다.

예제는 `DATA_W >= 1`을 지원 contract로 두며 integration/build 단계에서도 이를 검사해야 한다. Safe output decode는 equality를 continuous output에 직접 연결하지 않고 exact-match plain `case`와 inactive default를 사용한다. 따라서 X-containing simulation state와 known unused code 모두 ready/valid/active를 enable하지 않는다.

`commit_pulse`는 legal `ST_RUN && complete`에서만 생기고 response payload를 capture한다. `complete`가 `ST_IDLE` 또는 `ST_RESP`에 오면 protocol error를 기록하되 state의 정상 request/response transition은 계속 적용한다. 이 merge 정책도 요구사항이며, 더 엄격한 설계에서는 즉시 fail-stop할 수 있다.

## 5. `unique`와 Safe-FSM Option의 한계

`unique case`는 simulator/lint에 no-match 또는 overlap 의도를 전달하고 synthesis optimization에 영향을 줄 수 있다. 단, 예제처럼 explicit `default`가 있으면 no-match는 그 branch로 처리되므로 no-match warning 자체를 detector로 기대하지 않는다. 예제의 실제 detection은 `default`에서 생성하는 `state_error_event`다. Qualifier와 default는 다음을 자동으로 보장하지 않는다.

- Silicon upset에서 unused code를 항상 detect
- Illegal cycle의 모든 downstream side effect 차단
- Error logging 또는 interrupt
- Protocol ownership 복원
- Tool의 safe-FSM insertion이 verification netlist와 일치

Synthesis option이 parity, recovery arc 또는 state recoding을 삽입할 수 있지만 option 이름만으로 기능을 가정하지 않는다. RTL, synthesis report, mapped netlist, equivalence setup와 fault verification에서 실제 구현을 확인한다. Safety mechanism이 optimization으로 제거되지 않는지도 검토한다.

## 6. One-Hot의 Zero-Hot, Multi-Hot와 X

One-hot legal set이 `001`, `010`, `100`이면 다음이 모두 illegal encoding이다.

- `000`: zero-hot
- `011`, `101`, `110`, `111`: multi-hot
- Simulation의 `0X1`, `X00` 등: unknown-containing value

Simulation X는 물리적인 세 번째 logic value가 아니다. 초기화 누락, contention 또는 pessimism/optimism을 찾는 모델이다. Silicon upset은 보통 0/1 bit pattern으로 나타나며, one-hot에서 single-bit upset이 zero-hot 또는 multi-hot을 만들 수 있다. X simulation test와 physical fault injection은 서로 다른 evidence를 제공한다.

Plain `case`에서 X-containing value가 legal literal과 정확히 일치하지 않으면 `default`로 간다. `casex`를 쓰면 X가 wildcard가 되어 legal branch의 side effect를 잘못 선택할 수 있다.

## 7. Recovery Cycle Audit

| Edge | Pre-state/event | Same-cycle output | Post-state/status | 의미 |
|---|---|---|---|---|
| E0 | reset asserted | ready/valid/side effect off | `IDLE`, error clear | reset 우선 |
| E1 | `IDLE`, request accepted | `start_pulse=1` | `RUN` | legal start |
| E2 | `RUN`, complete | `commit_pulse=1` | `RESP`, response captured | legal completion |
| E3 | `RESP`, ready low | `rsp_valid=1` | `RESP` | payload hold |
| E4 | `RESP`, ready high + unexpected complete | response accepted + protocol error | `IDLE`, sticky set | legal consume와 error merge |
| E5 | injected `000` | all accepts/valid/commit off, state error | `IDLE`, sticky set | containment 후 recovery |
| E6 | `IDLE`, complete + error clear | protocol error | `IDLE`, sticky remains set | new error > clear |

Illegal encoding cycle에 output decode가 비교식으로 inactive가 되는지뿐 아니라, downstream이 이전 cycle의 registered enable을 갖고 있지는 않은지 확인한다. Recovery state가 peer protocol과 재동기화되지 않으면 local `IDLE` 복귀만으로 충분하지 않다.

## 8. 언제 자동 복구하면 안 되는가

- External memory/register write가 이미 부분 수행되어 retry가 중복 side effect를 만들 수 있다.
- Credit, lock, semaphore 또는 ownership을 local FSM만으로 재구성할 수 없다.
- Packet framing 중간에 idle로 돌아가면 peer가 남은 beat를 계속 보낸다.
- Safety requirement가 latent error 뒤 정상 동작 재개를 금지한다.
- Security state나 privilege transition을 추측해서 복구하면 안 된다.
- Error source를 보존하기 전에 reset/recovery가 evidence를 지운다.

이 경우 output quiesce, error latch, peer abort/flush handshake와 controlled reset/escalation을 조합한다.

## 9. Synthesis, STA와 PPA 관점

Illegal detection과 recovery는 state compare, reduction logic, error FF와 output qualification을 추가할 수 있다. One-hot legality check는 state width에 따라 reduction/decode가 되고, parity나 duplication은 storage와 routing을 늘린다.

Critical path에 legality qualifier를 직렬로 추가하면 state→enable path가 길어질 수 있다. Side-effect enable을 legal-state branch에서 직접 decode하거나 registered fault containment을 사용하는 대안이 있지만 detection latency와 unsafe window가 달라진다. Library, synthesis safe-FSM mapping, DFT insertion과 physical routing 결과로 평가한다.

Reliability mechanism은 area/power overhead가 있지만 기능 requirement라면 일반 PPA 최적화로 제거할 대상이 아니다. 필요한 diagnostic coverage와 fault model을 먼저 정의한다.

## 10. 적용하면 안 되는 패턴

- `default: state_d = IDLE`만 쓰고 side effect와 error를 확인하지 않는다.
- `casex`로 illegal/X state를 legal branch에 match시킨다.
- `unique`가 silicon recovery 회로를 만든다고 가정한다.
- 모든 protocol error를 자동 idle recovery로 숨긴다.
- Sticky error clear가 같은 cycle의 새 error를 지우게 둔다.
- Fault injection 없이 reset simulation만으로 recovery를 검증했다고 판단한다.
- RTL safety logic과 tool-inserted safe FSM을 중복 또는 상충되게 구성한다.

## 11. Verification Strategy

### Assertions

아래 `illegal_state` predicate는 known zero/multi-hot뿐 아니라 X-containing simulation state도 명시적으로 포함한다. Illegal state의 recovery 결과는 fault가 관찰된 edge의 다음 sample에서 확인한다.

```systemverilog
default clocking cb @(posedge clk); endclocking
default disable iff (!rst_n);

let illegal_state = $isunknown(state_q) || !$onehot(state_q);

ap_illegal_has_no_side_effect:
  assert property (illegal_state |->
                   !req_ready && !rsp_valid &&
                   !op_active && !start_pulse && !commit_pulse);

ap_illegal_recovers_and_reports:
  assert property (illegal_state |=>
                   state_q == ST_IDLE && error_sticky);

ap_protocol_error_is_sticky:
  assert property (protocol_error_event |=> error_sticky);

ap_new_error_dominates_clear:
  assert property ((state_error_event || protocol_error_event) &&
                   error_clear |=> error_sticky);

ap_commit_only_for_legal_completion:
  assert property (commit_pulse |->
                   state_q == ST_RUN && complete);

ap_stalled_response_stable:
  assert property (rsp_valid && !rsp_ready |=>
                   $stable(response_q));
```

`$isunknown`과 `$onehot`의 simulator/formal 지원 및 4-state policy를 확인한다. Formal engine이 2-state 모델만 사용한다면 X test는 simulation/X-propagation에서 별도로 수행하고, formal은 known illegal 0/1 encodings을 exhaustive하게 검사한다.

### Formal arbitrary state

- Reset assumption 없이 state bits를 arbitrary로 시작해 illegal code에서 containment/recovery를 prove한다.
- Legal state에서만 side effect가 나오는 invariant를 prove한다.
- Accepted request 없이 commit/response가 생성되지 않는 history property를 추가한다.
- Environment assumption은 same-domain stability, completion uniqueness와 response protocol에 한정하고 DUT recovery를 assumption으로 숨기지 않는다.

### Fault injection과 netlist

- 각 state bit single upset, zero-hot, multi-hot과 selected multi-bit fault를 inject한다.
- Illegal event가 output/side effect와 sticky error에 미치는 cycle을 확인한다.
- Synthesis recoding/safe-FSM option 뒤 mapped encoding과 recovery arc를 검사한다.
- Gate-level/X-propagation, DFT/scan initialization과 reset release scenario를 필요 수준에 맞게 검증한다.
- Recovery가 safety requirement에 중요하면 diagnostic coverage를 정의된 fault model로 측정한다.

## 12. Design Review Checklist

- [ ] Illegal encoding, transition과 protocol event를 구분했는가?
- [ ] 각 illegal 종류의 safe output, next state와 error response가 정의됐는가?
- [ ] Illegal cycle에 accept/write/commit이 차단되는가?
- [ ] Recovery가 safe-state, hold, fail-stop 또는 reset escalation 중 무엇인지 명확한가?
- [ ] Auto recovery가 external ownership과 exactly-once side effect를 깨지 않는가?
- [ ] Error와 clear 동시 발생의 dominance가 정의됐는가?
- [ ] `casex`/부주의한 wildcard가 illegal state를 숨기지 않는가?
- [ ] `unique` 및 tool safe-FSM option의 실제 mapping을 확인했는가?
- [ ] One-hot zero-hot/multi-hot과 simulation X를 모두 검토했는가?
- [ ] Formal arbitrary state와 fault injection을 수행했는가?
- [ ] Netlist, equivalence, DFT와 reset flow가 recovery logic을 보존하는가?
- [ ] 복구가 허용되지 않는 protocol에는 fail-stop/escalation을 선택했는가?

## 관련 문서

- [FSM Design](fsm_design.md)
- [FSM and Counter Encoding](../05_area/fsm_counter_encoding.md)
- [Priority and Simultaneous Events](priority_and_simultaneous_events.md)
- [State Partitioning and Ownership](../02_architecture/state_partitioning_and_ownership.md)
- [Reset](../07_reset/overview.md)
