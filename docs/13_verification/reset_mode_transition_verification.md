# Reset and Mode Transition Verification

Reset과 mode transition의 어려움은 기본값을 확인하는 데 있지 않다. **이미 accepted된 transaction의 ownership을 누가 갖고 있으며, reset·flush·mode update가 그 transaction을 drain, abort 또는 preserve하는 정확한 시점**을 정해야 한다. State FF가 초기값으로 돌아갔다는 waveform만으로 외부 side effect와 scoreboard까지 취소된 것은 아니다.

이 문서는 single-clock protocol의 acceptance, cancellation, mode commit과 verification history에 집중한다. Reset 회로 선택과 release/RDC는 [Reset Architecture Overview](../07_reset/overview.md) 및 [Reset Deassertion and RDC](../07_reset/reset_deassertion.md), clock-gating sequence는 [Reset with Clock Gating](../07_reset/reset_with_clock_gating.md)가 정본이다. 아래 예제는 digital behavior를 설명하며 analog reset/clock 안전성이나 metastability를 입증하지 않는다.

## 1. 먼저 Transition Policy를 표로 고정한다

Reset과 mode 변경을 모두 “상태 변경”으로 묶지 않는다.

| 사건 | 새 request | Outstanding work | 이미 제시된 response | 설정 적용 시점 |
|---|---|---|---|---|
| Reset | 차단 | Abort | 아직 미accept면 취소 | Default로 복귀 |
| Abort / flush | 정책에 따라 차단 | Abort 또는 선택적 폐기 | Acceptance mask 여부 명시 | 보통 active mode 유지 |
| Drain-mode update | 새 request 차단 | 완료 허용 | Consumer acceptance까지 유지 | Outstanding이 0이 되는 commit edge |
| Immediate-mode update | 동시 request priority 명시 | Old/new mode tag로 구분 | 기존 response 보존 | Accepted update edge 이후 |
| Preserve-across-reset | 별도 retention 계약 필요 | 복구 또는 replay | 중복 방지 필요 | Restore 완료 후 |

어떤 정책이 항상 우월한 것은 아니다. 긴 연산을 reset에서 즉시 중단해야 하는 safety block과, mode 변경 중 packet boundary까지 drain해야 하는 stream block은 다른 계약이 필요하다. 한 block 안에서도 reset은 abort, mode update는 drain일 수 있다.

정책 문장에는 다음 edge를 명시한다.

- Request가 accepted되어 producer가 ownership을 넘긴 edge.
- Completion이 내부 result를 생성한 edge.
- Response가 consumer에게 accepted되어 외부 side effect가 허용된 edge.
- Mode request가 accepted된 edge와 새 mode가 active가 되는 commit edge.
- Reset/abort가 acceptance를 막는 combinational window와 state를 지우는 sequential event.

## 2. Request, Pending Configuration과 Active Mode를 분리한다

Configuration bus의 값이 바뀐 것과 transaction이 사용하는 active mode가 바뀐 것은 다르다.

```text
mode_valid/data --accept--> pending_mode_q --commit--> active_mode_q
                                                       |
request --accept---------------------------------------+--> captured mode tag
                                                               |
                                                          response
```

Drain policy에서는 mode update를 pending state에 저장한 뒤 old-mode outstanding transaction이 모두 끝날 때 commit한다. Transaction은 acceptance 때의 `active_mode_q`를 tag 또는 equivalent context로 보존한다. 나중에 global mode bus를 다시 읽어 result를 해석하면 설정 변경과 data가 어긋날 수 있다.

다음 용어를 구분한다.

| Signal / event | 의미 |
|---|---|
| `mode_valid` | Source가 설정 변경 요청을 제시하는 level |
| `mode_accept` | Pending slot이 설정 요청을 소유하게 된 edge |
| `mode_busy` | Accepted 설정이 아직 commit되지 않은 state |
| `mode_commit` | Pending 설정이 active가 되는 edge |
| `req_accept` | Transaction data와 active mode tag를 capture한 edge |
| `rsp_accept` | Consumer가 response ownership을 받은 edge |

Software-visible write completion, mode acceptance와 hardware activation이 서로 다른 경우 status/acknowledge도 그 차이를 표현해야 한다.

## 3. Generic One-Entry Drain-and-Commit Stage

다음 예제는 same clock domain에서 한 개의 response를 보존하는 stage다. Mode 0은 data를 그대로 전달하고 mode 1은 bitwise invert한다. 연산 자체보다 transition contract를 보여주기 위한 작은 예제다.

Contract:

- `DATA_W >= 1`; `rst_n`은 active-low asynchronous assertion reset이다.
- `rst_n` release는 destination clock에 대해 안전하게 제어되어 있다고 가정한다.
- Reset은 response, pending mode와 active mode를 취소하고 `DEFAULT_MODE`로 돌아간다.
- Mode slot이 비어 있으면 mode request는 response가 outstanding이어도 accept할 수 있다.
- Mode request가 제시된 edge에는 request보다 mode acceptance가 우선한다.
- Accepted mode가 pending이면 새 request를 차단하고 기존 response를 drain한다.
- Pending mode는 response가 없거나 현재 response가 같은 edge에 accept될 때 commit된다.
- Mode acceptance와 commit은 최소 한 active edge 떨어져 있다.
- Pending mode가 없으면 response consume과 새 request의 same-edge refill을 허용한다.
- Response data와 captured mode tag는 acceptance까지 stable하다.
- Reset 중 ready/valid/acceptance는 모두 mask된다.

```systemverilog
module drain_mode_stage #(
  parameter int unsigned DATA_W = 8,
  parameter bit          DEFAULT_MODE = 1'b0
) (
  input  logic              clk,
  input  logic              rst_n,

  input  logic              mode_valid,
  output logic              mode_ready,
  input  logic              mode_value,
  output logic              mode_accept,
  output logic              mode_busy,
  output logic              mode_commit,
  output logic              active_mode,

  input  logic              req_valid,
  output logic              req_ready,
  input  logic [DATA_W-1:0] req_data,
  output logic              req_accept,

  output logic              rsp_valid,
  input  logic              rsp_ready,
  output logic [DATA_W-1:0] rsp_data,
  output logic              rsp_mode,
  output logic              rsp_accept
);
  logic              active_mode_q;
  logic              pending_mode_q;
  logic              pending_valid_q;
  logic              rsp_valid_q;
  logic [DATA_W-1:0] rsp_data_q;
  logic              rsp_mode_q;

  assign mode_ready  = rst_n && !pending_valid_q;
  assign mode_accept = mode_valid && mode_ready;
  assign mode_busy   = pending_valid_q;

  // A presented mode request wins arbitration over a new data request.
  assign req_ready = rst_n && !pending_valid_q && !mode_valid &&
                     (!rsp_valid_q || rsp_ready);
  assign req_accept = req_valid && req_ready;

  assign rsp_valid  = rst_n && rsp_valid_q;
  assign rsp_data   = rsp_data_q;
  assign rsp_mode   = rsp_mode_q;
  assign rsp_accept = rsp_valid && rsp_ready;

  // This is the pre-edge commit event; active_mode_q updates at that edge.
  assign mode_commit = rst_n && pending_valid_q &&
                       (!rsp_valid_q || rsp_accept);
  assign active_mode = active_mode_q;

  // Control-state priority:
  // async reset > mode capture/commit and response accept/refill > hold.
  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      active_mode_q   <= DEFAULT_MODE;
      pending_mode_q  <= DEFAULT_MODE;
      pending_valid_q <= 1'b0;
      rsp_valid_q     <= 1'b0;
    end else begin
      if (mode_accept) begin
        pending_mode_q  <= mode_value;
        pending_valid_q <= 1'b1;
      end

      if (mode_commit) begin
        active_mode_q   <= pending_mode_q;
        pending_valid_q <= 1'b0;
      end

      if (req_accept) begin
        rsp_data_q <= active_mode_q ? ~req_data : req_data;
        rsp_mode_q <= active_mode_q;
      end

      unique case ({req_accept, rsp_accept})
        2'b10: rsp_valid_q <= 1'b1; // New response.
        2'b01: rsp_valid_q <= 1'b0; // Old response drained.
        2'b11: rsp_valid_q <= 1'b1; // Consume old, refill new.
        default: rsp_valid_q <= rsp_valid_q;
      endcase
    end
  end
endmodule
```

`rsp_data_q`, `rsp_mode_q`에는 reset assignment가 없다. `rsp_valid_q=0`과 outward `rsp_valid=0`이 모든 observer를 막는다는 contract다. 보안 zeroization, debug visibility 또는 hidden compare가 있으면 이 resetless 선택을 다시 검토한다.

`mode_valid`가 high인 동안 request arbitration에서 mode가 우선한다. Mode producer가 요청을 의미 없이 계속 유지하면 request traffic을 막을 수 있으므로, producer는 `mode_accept`에서 transaction이 끝나는 valid/ready contract를 따라야 한다.

## 4. Edge/NBA/Observer Audit

이 표는 예제의 기본 parameter인 `DEFAULT_MODE=0`을 사용한다.

다음 표에서 `A`, `B`, `C`, `D`는 서로 다른 generic payload다. `~B`는 bitwise invert 결과다. `out after edge`는 해당 edge NBA 이후의 externally visible response다.

| Edge | Before-edge inputs/state | Accepted event at edge | State update after NBA | Output after edge |
|---|---|---|---|---|
| E0 | `rst_n=0` | 없음 | Active=0, pending=0, response invalid | Invalid |
| E1 | Request A, active=0, empty | `req_accept(A, mode0)` | Response A/tag0 valid | A/tag0 |
| E2 | Mode request=1, response stalled | `mode_accept(1)` | Pending mode1, old response 유지 | A/tag0 |
| E3 | Request B held, response ready | `rsp_accept(A)`, `mode_commit(1)` | Active=1, pending clear, response invalid | Invalid |
| E4 | Request B still held | `req_accept(B, mode1)` | Response `~B`/tag1 valid | `~B`/tag1 |
| E5 | Request C, response ready | `rsp_accept(B)`, `req_accept(C, mode1)` | Same-edge refill with `~C`/tag1 | `~C`/tag1 |
| E6 | Reset asserted before edge | 없음 | Outstanding C abort, active=default | Invalid |
| E7 | Release 후 mode1과 request D 동시 제시 | `mode_accept(1)` | Pending mode1, request D not accepted | Invalid |
| E8 | Pending mode1, request D held | `mode_commit(1)` | Active=1 | Invalid |
| E9 | Request D still held | `req_accept(D, mode1)` | Response `~D`/tag1 valid | `~D`/tag1 |

E2의 mode acceptance는 A의 의미를 바꾸지 않는다. A는 old active mode tag0을 유지한다. E3 edge 직전에 A가 consumer에게 accepted되고, 같은 edge의 NBA에서 새 mode가 active가 된다. E4부터 accepted되는 request가 mode1을 사용한다.

E5에서는 edge 직전의 response B가 consumer에게 전달되고, edge NBA 뒤 response storage에는 C가 들어간다. Scoreboard가 NBA 이후 `rsp_data`를 보고 E5의 `rsp_accept` payload라고 기록하면 B 대신 C를 잘못 비교한다. Acceptance edge의 pre-NBA response를 sample해야 한다.

E6은 reset이 sampling edge 전에 asserted되어 outward valid가 mask된 경우다. E5에서 accepted된 C는 producer ownership을 이미 stage에 넘겼지만 아직 consumer에게 전달되지 않았으므로 reset policy에 따라 abort된다. Producer가 자동 retry해야 하는지, 상위 reset이 전체 transaction을 폐기하는지는 system contract가 정한다.

## 5. 현재 Edge의 Acceptance는 소급 취소할 수 없다

Sequential clear/reset assignment는 같은 edge에 다른 FF가 이미 sample한 이전 값을 소급해 지우지 못한다.

```text
edge E
  before edge: rsp_valid=1, rsp_ready=1, flush=1
  consumer samples old rsp_valid/data
  source NBA clears rsp_valid_q
```

Flush가 단지 `always_ff` 안에서 valid를 clear하면 consumer는 E에서 old valid/data를 accept할 수 있다. 명세가 “flush와 겹친 response는 취소”라면 source의 outward valid/acceptance와 consumer의 side effect가 같은 flush 조건으로 edge 전에 mask되어야 한다. Consumer가 별도 reset/mode domain에 있으면 그 조건 자체가 CDC/RDC protocol 문제다.

반대로 response가 E에서 이미 accepted된 뒤 reset이 E 직후 assert되었다면, E의 외부 side effect는 완료된 일이다. Source state와 scoreboard를 reset해도 그 write, interrupt 또는 dequeue를 없던 일로 만들 수 없다. 필요하면 상위 protocol이 rollback/compensation을 별도로 제공해야 한다.

Asynchronous reset이 edge와 매우 가깝게 움직일 때의 recovery/removal와 metastability는 digital event-order 표만으로 안전성을 입증할 수 없다. Release synchronization과 physical reset analysis를 별도로 수행한다.

## 6. Scoreboard는 Epoch와 Ownership을 추적한다

Scoreboard queue는 raw `req_valid`가 아니라 `req_accept`에서 entry를 만든다. Entry에는 최소한 다음을 저장한다.

```text
{expected_data, captured_mode, transaction_id, reset_epoch}
```

`rsp_accept`에서 queue의 oldest entry와 edge 직전 response를 비교하고 pop한다. Mode acceptance만으로 기존 entry의 expected mode를 바꾸지 않는다. Drain mode commit은 queue가 비었거나 마지막 response가 같은 edge에 pop되는 시점과 일치해야 한다.

Reset/abort policy가 outstanding을 취소하면 scoreboard도 같은 event에서 queue를 비우고 epoch를 증가시킨다. 오래 걸리는 predictor나 monitor callback에는 capture 당시 epoch를 붙인다. Callback이 돌아왔을 때 현재 epoch와 다르면 이미 취소된 transaction의 결과이므로 새 reset 이후 transaction과 비교하지 않는다.

Epoch는 reset 자체의 correctness를 증명하지 않는다. Queue가 잘못된 acceptance에서 채워졌거나 consumer side effect가 reset mask를 따르지 않으면 epoch만 맞아도 bug가 남는다. Reset 후 ID가 재사용될 수 있다면 `{epoch, id}` 조합으로 old/new transaction을 구분한다.

### Checker의 History도 Reset Contract를 따른다

- `$past`, outstanding count와 latency timer의 유효 시작점을 reset release 뒤에 다시 정한다.
- Reset이 obligation을 abort하는 policy라면 assertion, reference queue와 coverage sequence를 같은 event에서 중단한다.
- Preserve/replay policy라면 queue를 무조건 clear하지 않고 retained state와 복구 acknowledgement를 모델링한다.
- Mode commit은 reset이 아니므로 old transaction history를 지우지 않는다. Drain 완료까지 비교를 유지한다.

## 7. Assertion 후보와 Reset Semantics

다음은 예제 module에 연결할 수 있는 **partial property**다. 실제 frontend 지원, reset event scheduling과 harness 초기화를 확인해야 한다.

```systemverilog
ap_mode_wins_request: assert property (@(posedge clk)
  mode_accept |-> !req_accept);

ap_request_tag: assert property (@(posedge clk)
  disable iff (!rst_n)
  req_accept |=> rsp_valid && rsp_mode == $past(active_mode));

ap_response_stable: assert property (@(posedge clk)
  disable iff (!rst_n)
  (rsp_valid && !rsp_accept) |=>
    rsp_valid && $stable({rsp_data, rsp_mode}));

ap_mode_capture: assert property (@(posedge clk)
  disable iff (!rst_n)
  mode_accept |=> mode_busy);

// Intentionally incorrect; the failure mechanism is explained below.
ap_mode_commit_bad_example: assert property (@(posedge clk)
  disable iff (!rst_n)
  mode_commit |=> !mode_busy && active_mode == $past(active_mode, 1));
```

마지막 `ap_mode_commit_bad_example`은 그대로 사용하면 잘못됐다. Consequent의 `active_mode == $past(active_mode, 1)`은 mode가 바뀌어야 할 commit에서 오히려 이전 active mode와 같다고 요구한다. **그럴듯한 assertion도 review 대상**이라는 예다. 올바른 check는 acceptance 때 pending mode를 checker state에 capture하거나, pre-edge `pending_mode_q`를 관측 가능한 verification port로 연결해 다음 sample과 비교해야 한다.

다음처럼 checker-owned expected mode를 사용하면 DUT 내부 이름에 의존하지 않고 request/commit 관계를 추적할 수 있다. 이 fragment는 single pending slot과 mode acceptance가 commit보다 최소 한 edge 앞선다는 현재 contract에 맞춘다.

```systemverilog
logic expected_pending_mode;
logic expected_pending_valid;

always_ff @(posedge clk or negedge rst_n) begin
  if (!rst_n) begin
    expected_pending_mode  <= DEFAULT_MODE;
    expected_pending_valid <= 1'b0;
  end else begin
    if (mode_accept) begin
      expected_pending_mode  <= mode_value;
      expected_pending_valid <= 1'b1;
    end
    if (mode_commit)
      expected_pending_valid <= 1'b0;
  end
end

ap_commit_expected_mode: assert property (@(posedge clk)
  disable iff (!rst_n)
  (mode_commit && expected_pending_valid)
  |=> active_mode == $past(expected_pending_mode));
```

`disable iff (!rst_n)`는 이번 DUT의 asynchronous reset이 진행 중인 obligation을 abort한다는 policy와 맞춘 것이다. Reset 결과 자체는 별도의 property 또는 reset monitor로 확인한다. Synchronous reset DUT에 같은 문구를 복사하면 abort 시점과 RTL update가 어긋날 수 있다. 자세한 sampling 원칙은 [Assertion-Driven RTL](assertion_driven_rtl.md)을 따른다.

의도적으로 잘못된 `ap_mode_commit`은 교육용 bad example이므로 regression property set에는 넣지 않는다. 문서에서 “assertion을 작성했다”는 사실보다 capture한 값과 비교 edge가 계약에 맞는지 검토한다.

## 8. Reset과 Mode Corner-Case Matrix

| Precondition | Same-edge events | Expected result | 주요 checker |
|---|---|---|---|
| Idle | Mode request + data request | Mode accept, data request 미accept | Arbitration assertion |
| Response stalled | Mode request | Response/tag 유지, mode pending | Stability + pending check |
| Pending mode + valid response | Response acceptance | Old response consume + mode commit | Scoreboard + commit check |
| No pending mode + valid response | Response acceptance + request | Old response consume + new-mode-consistent refill | Ordering/reference queue |
| Any busy state | Reset before edge | All acceptance mask, outstanding abort, default mode | Reset output/state check |
| Response accepted at edge | Reset immediately after edge | Completed side effect 유지, 이후 outstanding 취소 | Edge event log + epoch |
| Clock stopped | Request/mode valid high | Acceptance 없음, source가 payload 유지 | Clock/control protocol check |
| Clock restarted | Pending request/mode | 첫 active edge policy대로 accept/commit | Resume sequence check |

각 행은 reset polarity만 바꿔 반복할 test가 아니다. Assertion/deassertion이 edge와 어떻게 정렬되는지, acceptance mask가 combinational인지, checker가 어느 event에서 history를 버리는지까지 기록한다. Parameter와 전체 matrix 관리 방법은 [Corner-Case Matrix](corner_case_matrix.md)를 참고한다.

Mode가 여러 field인 경우 atomic capture를 확인한다. 각 bit를 서로 다른 cycle에 active configuration으로 복사하면 mixed configuration이 생길 수 있다. Shadow register + commit, version tag 또는 request 당시 full configuration capture 중 architecture에 맞는 방법을 선택한다.

## 9. Clock Stop/Resume는 Acceptance를 멈춘다

Synchronous handshake의 acceptance는 active clock edge에서만 일어난다. Clock이 멈춘 동안 combinational `ready=1`이 보이더라도 transaction이 accepted된 것은 아니다. Producer는 실제 sampling edge의 valid/ready contract에 따라 request와 payload를 유지해야 한다.

Clock stop 전에 해야 할 일을 정한다.

- New request를 먼저 차단하고 outstanding을 drain할지, abort할지.
- Pending mode commit이 stop 전에 끝나야 하는지 다음 wake까지 유지되는지.
- Clock enable을 만드는 controller가 gated clock 밖의 always-on 영역에 있는지.
- Reset assertion 중 clock이 없어도 어떤 state가 즉시 초기화되는지.
- Release 후 local reset-done과 first legal acceptance edge가 언제인지.

Async reset assertion은 clock 없이 control FF를 reset할 수 있지만, mode commit과 synchronous drain은 clock edge가 없으면 진행되지 않는다. Drain 완료를 기다리면서 먼저 clock을 끄면 deadlock이 된다. Force-on/wake sequencing은 [Reset with Clock Gating](../07_reset/reset_with_clock_gating.md)과 [Root Clock vs Function Clock](../06_clock/root_vs_function_clock.md)을 따른다.

Digital simulation에서 clock을 멈추고 다시 toggling해 기능 sequence를 확인할 수는 있다. ICG enable의 glitchlessness, runt pulse, recovery/removal, 실제 clock tree와 RDC safety는 구조 검사, STA/CDC/RDC 및 implementation evidence가 필요하다.

## 10. 실패 모드와 권장 패턴

| 실패 패턴 | 왜 실패하는가 | 권장 패턴 |
|---|---|---|
| Global mode를 result 시점에 다시 읽음 | Outstanding transaction의 mode와 불일치 | Acceptance 때 mode/tag capture |
| Mode write 즉시 active 변경 | Old/new transaction 경계가 모호 | Pending + commit 또는 explicit versioning |
| Reset에서 DUT valid만 clear | Consumer가 같은 edge old valid를 sample 가능 | Acceptance와 side effect의 공통 mask |
| Scoreboard queue만 reset | 이미 완료된 외부 side effect를 소급 취소한다고 오해 | Acceptance log, epoch와 system policy |
| Clock off 뒤 drain 대기 | Completion/commit edge가 없어 deadlock | Drain 후 stop 또는 clock force-on |
| 모든 property를 reset disable | Reset 결과와 release 첫 동작이 미검증 | Abort property와 reset/release property 분리 |
| Mode update에서 history 전체 clear | Old transaction 오류를 숨김 | Drain까지 old entry와 tag 유지 |

Drain은 latency를 늘리고 mode 전환 중 throughput을 낮춘다. Version tag를 사용해 old/new mode transaction을 동시에 허용하면 throughput을 유지할 수 있지만 context storage, compare와 verification state가 늘어난다. Abort는 빠르지만 retry, error reporting 또는 lost work의 system 의미가 필요하다.

## 11. Synthesis, Timing, Power와 Area

예제는 active/pending mode FF, pending-valid FF, response-valid FF와 resetless payload/tag storage로 mapping될 수 있다. 실제 cell 종류와 논리 factoring은 tool/library에 따라 다르다.

| 구조 선택 | Timing 영향 | Power / Area 영향 | Protocol 영향 |
|---|---|---|---|
| Pending + drain | Mode/valid control path 추가 | Pending state와 clock load 증가 | 전환 중 request bubble |
| Same-edge refill | `rsp_ready → req_ready` combinational path | Bubble 감소, control switching 증가 가능 | Throughput 최대 1/cycle 가능 |
| Per-transaction mode tag | Result 해석 경로에 tag MUX 가능 | Outstanding 수만큼 context bit 증가 | Old/new mode 구분 명확 |
| Resetless payload | Reset tree/load 감소 가능 | X/old data observer 검증 필요 | Invalid 기간 사용 금지 |
| Combinational reset mask | Interface control path에 reset 영향 | 추가 gating과 fanout 가능 | Assert 중 acceptance 차단 |

Mode transition을 안전하게 만들었다고 timing/power/area가 자동으로 좋아지지는 않는다. `mode_valid → req_ready`, pending state와 `rsp_ready → mode_commit`, same-edge refill ready path를 STA에서 확인한다. Wide configuration tag와 reset/mode fanout은 placement와 routing evidence를 함께 본다.

Reset fanout과 cell 비용은 [Reset Area Cost](../05_area/reset_area_cost.md), control mapping은 [Enable and MUX Inference](../11_synthesis/enable_and_mux_inference.md), physical feedback은 [Fanout and Locality](../12_physical_aware/fanout_and_locality.md)를 참고한다.

## 12. Review Questions

- [ ] Reset, flush와 mode update 각각에 drain/abort/preserve 정책이 있는가.
- [ ] Request, completion, response acceptance와 mode commit edge를 구분하는가.
- [ ] Same-edge reset/accept/complete/consume/commit priority가 정의되어 있는가.
- [ ] 이미 accepted된 response side effect를 state clear로 소급 취소한다고 가정하지 않는가.
- [ ] Active mode, pending configuration과 transaction tag가 분리되어 있는가.
- [ ] Scoreboard가 acceptance에서 entry를 만들고 reset epoch로 late result를 거르는가.
- [ ] Async reset assertion, controlled release와 synchronous reset sampling을 구분하는가.
- [ ] Reset abort와 reset 결과 자체를 서로 다른 property로 확인하는가.
- [ ] Mode/reset 뒤 `$past`, timer와 coverage history의 유효 시작점을 다시 설정하는가.
- [ ] Clock stop 전에 drain/commit이 완료되거나 wake/force-on 경로가 있는가.
- [ ] Digital trace와 CDC/RDC, clock integrity 및 physical safety evidence를 구분하는가.
- [ ] Transition 동안의 throughput bubble, context FF와 reset/control timing 비용을 측정하는가.

## 관련 문서

- [Assertion-Driven RTL](assertion_driven_rtl.md)
- [Corner-Case Matrix](corner_case_matrix.md)
- [Lint, Formal, and Equivalence](lint_formal_equivalence.md)
- [FSM Design](../09_control_logic/fsm_design.md)
- [Buffering and Backpressure](../02_architecture/buffering_and_backpressure.md)
- [Reset Architecture Overview](../07_reset/overview.md)
- [RTL Design Review Checklist](../15_checklist/rtl_design_review_checklist.md)
