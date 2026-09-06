# Corner-Case Matrix

Corner case는 단순히 발생 확률이 낮은 입력이 아니라, **state, boundary, 동시 event와 시간 순서가 겹쳐 architecture의 판단이 바뀌는 지점**이다. 정상 traffic을 오래 흘렸다고 reset과 accepted request의 충돌이나 full에서의 consume/refill을 관측했다고 할 수는 없다.

이 문서는 scenario 조합을 expected behavior, checker, coverage와 재현 가능한 evidence로 연결하는 방법을 다룬다. Priority 정책은 [Priority and Simultaneous Events](../09_control_logic/priority_and_simultaneous_events.md), property의 sampling과 assumption 관리는 [Assertion-Driven RTL](assertion_driven_rtl.md)이 정본이다. 여기의 matrix와 testbench는 검증 계획 및 교육용 예제이며 실행 완료된 regression 결과가 아니다.

## 1. Matrix의 한 행은 Contract 하나를 설명한다

입력 조합만 나열하면 중요한 관측 시점과 expected response가 빠지기 쉽다. 각 행에는 최소한 다음 항목이 필요하다.

| 필드 | 기록할 내용 |
|---|---|
| Requirement / case ID | 어떤 설계 판단을 확인하는가 |
| Configuration / precondition | Parameter, mode, reset 상태, occupancy와 기존 state |
| Stimulus / sequence | 같은 edge의 입력과 전후 순서 |
| Acceptance / cancellation | 실제 수락한 일, 거절한 일, 폐기한 일 |
| Expected observation | 값, 순서, error, hold와 정확한 관측 edge |
| Checker / coverage | Correctness 검사와 해당 상황 도달 여부 |
| Evidence / status | Run 식별자, 결과, 미실행·제외 사유와 owner |

예를 들어 “full에서 push”만으로는 부족하다. Downstream이 같은 edge에 pop할 수 있는지, 그때 in_ready가 올라가는지, push와 pop의 payload ownership이 무엇인지가 있어야 한다. Occupancy가 유지되어도 payload 두 개의 이동이 있었다면 단순 count 안정성 check로는 ordering 오류를 찾지 못한다.

Expected behavior를 정할 수 없는 행은 test 부족 이전에 specification gap이다. 현재 RTL이 우연히 하는 동작을 기대값으로 채우지 않고, architecture owner가 계약을 정하도록 남긴다.

## 2. 값을 무작정 곱하지 않고 판단 경계를 찾는다

다음 축을 살펴본 뒤, 서로 영향을 주는 축을 우선 cross한다.

| 축 | 대표 partition | 확인하려는 실패 |
|---|---|---|
| State / occupancy | Empty, one entry, almost full, full | Overflow, stale valid, ownership 손실 |
| Numeric value | 0, minimum, maximum, sign/resize boundary | Wrap, saturation, signedness 오류 |
| Same-edge event | Clear/set, load/step, push/pop, reset/request | 암묵적인 priority 또는 loss |
| Temporal sequence | Isolated, held-high, back-to-back, long stall | Re-arm, duplicate, latency 오류 |
| Parameter | Minimum legal, non-power-of-two, feature off/on | Elaboration, width, 잘못된 default |
| Mode / reset / clock | Idle/busy 전환, reset overlap, stop/resume | Cancel 불일치, stale state, deadlock |
| Invalid input / fault | Illegal encoding, protocol violation, X/Z | Unwanted side effect, recovery 누락 |

모든 Cartesian product를 무조건 생성하는 것도, pairwise만으로 충분하다고 선언하는 것도 피한다. 예를 들어 `full × pop × push × flush`의 priority bug는 두 축씩만 본 시험으로 드러나지 않을 수 있다. 작은 control state space는 exhaustive check를 고려하고, 큰 data space는 boundary partition, 독립 reference model과 random traffic을 조합한다.

동등하다고 묶은 값을 대표값 하나로 줄일 때도 근거가 필요하다. 모든 bit가 대칭이라고 해도 실제 RTL에 MSB만 잘못 연결된 bug가 있을 수 있다. One-hot walking mask, high/low bit와 mixed pattern은 구조의 연결 실수를 찾는 데 유용하다.

## 3. 공통 예제의 Priority Partition

[Assertion-Driven RTL](assertion_driven_rtl.md)의 `sticky_event_bank`를 그대로 사용한다. 별도 architecture를 추가하지 않는다.

```text
At each posedge:
  reset ? clear all bits
        : for each bit, event set > clear > hold

Expected Q after this edge's NBA
    = Q observed at the following posedge sample
```

각 bit에 대해 known input을 다음처럼 partition할 수 있다. `*`는 그 열의 known 0/1 어느 값이든 같은 결과라는 표기이지, DUT에 X를 drive하라는 뜻이 아니다.

| rst | event bit | clear bit | Previous Q bit | Next Q bit | Property |
|---:|---:|---:|---:|---:|---|
| 1 | * | * | * | 0 | `ap_reset` |
| 0 | 1 | * | * | 1 | `ap_set` |
| 0 | 0 | 1 | * | 0 | `ap_clear` |
| 0 | 0 | 0 | 0 | 0 | `ap_hold` |
| 0 | 0 | 0 | 1 | 1 | `ap_hold` |

특히 set 행의 clear `*`를 0으로 좁히지 않는다. Clear와 event가 겹치는 것은 명세상 합법이며, set이 이긴다는 판단 자체가 검증 대상이다. 같은 bit의 event를 연속해서 주어도 pending은 1로 유지되므로, event 개수를 pending 변화 횟수와 비교하면 잘못된 checker가 된다.

## 4. W=3 Directed Matrix

다음은 3-bit 예제의 연속 scenario다. Mask는 `[2:0]` 순서이며 각 행은 하나의 posedge에 해당한다. 첫 행이 reset으로 known state를 만들고, 이후 행의 previous Q는 직전 행의 next Q다. 표의 next Q는 그 행의 NBA 이후 값이며, 앞 문서의 SVA는 다음 posedge sample에서 검사한다.

| ID | Previous Q | rst | Event | Clear | Next Q | 목적 |
|---|---|---:|---|---|---|---|
| M00 | Any | 1 | 111 | 111 | 000 | Reset이 모든 event보다 우선 |
| M01 | 000 | 0 | 000 | 000 | 000 | Reset release 뒤 idle |
| M02 | 000 | 0 | 001 | 000 | 001 | Low bit set |
| M03 | 001 | 0 | 001 | 000 | 001 | Back-to-back 같은 event coalescing |
| M04 | 001 | 0 | 100 | 001 | 100 | 서로 다른 bit의 set/clear 동시 처리 |
| M05 | 100 | 0 | 100 | 100 | 100 | Pending bit의 set/clear collision |
| M06 | 100 | 0 | 010 | 010 | 110 | Empty bit의 collision + 다른 bit hold |
| M07 | 110 | 0 | 000 | 110 | 000 | Nonzero state에서 multi-bit clear |
| M08 | 000 | 0 | 111 | 000 | 111 | 모든 bit 동시 set |
| M09 | 111 | 0 | 000 | 000 | 111 | Nonzero hold |
| M10 | 111 | 1 | 111 | 000 | 000 | Pending 중 reset과 새 event 충돌 |
| M11 | 000 | 0 | 100 | 000 | 100 | Release 첫 edge의 새 event |
| M12 | 100 | 0 | 000 | 111 | 000 | 이미 빈 bit를 포함한 전체 clear |

M03은 low sample 없이 event bit가 두 edge 연속 1인 경우다. 이 interface는 rising-edge detector가 아니므로 두 edge의 event indication을 보지만, state는 “하나 이상 pending”만 표시한다. M04에서는 Q가 단지 nonzero인지 보는 checker로는 wrong bit capture를 찾을 수 없다. Whole-vector expected value가 필요하다.

이 13행은 읽기 쉬운 smoke set이지 전체 조합의 대체물이 아니다. `W=3`의 known `(Q, event, clear, rst)` 조합은 `8 × 8 × 8 × 2 = 1,024`개다. 모든 조합의 one-step transition을 확인해도 reset history, X, 실제 sampling scheduling과 다중 cycle harness 동작은 별도로 검토한다.

## 5. 식 복사 대신 Specification 기반 Reference Model

아래는 앞 문서의 두 module을 함께 compile할 때 사용할 수 있는 **simulation용 testbench 예제**다. DUT와 checker module은 [Assertion-Driven RTL](assertion_driven_rtl.md)에 있다. 이 예제는 `W=3` matrix만 실행하며, clock 생성과 시간 대기가 있으므로 합성 대상이 아니다.

Reference function은 DUT의 bitwise 식을 복사하지 않고 각 bit의 priority 문장으로 기대값을 만든다. Driver는 첫 negedge에서 시작해 각 step의 입력을 drive하고, 다음 posedge의 NBA를 지난 다음 negedge에서 비교한다. 이어지는 step은 그 negedge에서 바로 입력을 바꾸므로 중간 idle cycle이 삽입되지 않는다.

```systemverilog
module sticky_event_bank_matrix_tb;
  timeunit 1ns;
  timeprecision 1ps;
  localparam int unsigned W = 3;

  logic clk = 1'b0;
  logic rst = 1'b1;
  logic [W-1:0] event_mask = '0;
  logic [W-1:0] clear_mask = '0;
  logic [W-1:0] pending_q;
  logic [W-1:0] model_q = 'x;

  always #5ns clk = ~clk;

  sticky_event_bank #(.W(W)) dut (
    .clk(clk), .rst(rst), .event_mask(event_mask),
    .clear_mask(clear_mask), .pending_q(pending_q)
  );

  sticky_event_bank_properties #(.W(W)) checks (
    .clk(clk), .rst(rst), .event_mask(event_mask),
    .clear_mask(clear_mask), .pending_q(pending_q)
  );

  function automatic logic [W-1:0] reference_next (
    input logic [W-1:0] old_q,
    input bit reset_i,
    input bit [W-1:0] events_i,
    input bit [W-1:0] clears_i
  );
    logic [W-1:0] result;
    result = old_q;
    if (reset_i) begin
      result = '0;
    end else begin
      for (int b = 0; b < W; b++) begin
        if (events_i[b])
          result[b] = 1'b1;
        else if (clears_i[b])
          result[b] = 1'b0;
      end
    end
    return result;
  endfunction

  // Caller starts on a negedge; each call spans exactly one active edge.
  task automatic step (
    input string case_id,
    input bit reset_i,
    input bit [W-1:0] events_i,
    input bit [W-1:0] clears_i
  );
    logic [W-1:0] expected_q;
    rst = reset_i;
    event_mask = events_i;
    clear_mask = clears_i;
    expected_q = reference_next(model_q, reset_i, events_i, clears_i);
    @(negedge clk);
    if (pending_q !== expected_q)
      $fatal(1, "%s: expected=%b actual=%b", case_id, expected_q, pending_q);
    model_q = expected_q;
  endtask

  initial begin
    @(negedge clk);
    step("M00", 1'b1, 3'b111, 3'b111);
    step("M01", 1'b0, 3'b000, 3'b000);
    step("M02", 1'b0, 3'b001, 3'b000);
    step("M03", 1'b0, 3'b001, 3'b000);
    step("M04", 1'b0, 3'b100, 3'b001);
    step("M05", 1'b0, 3'b100, 3'b100);
    step("M06", 1'b0, 3'b010, 3'b010);
    step("M07", 1'b0, 3'b000, 3'b110);
    step("M08", 1'b0, 3'b111, 3'b000);
    step("M09", 1'b0, 3'b000, 3'b000);
    step("M10", 1'b1, 3'b111, 3'b000);
    step("M11", 1'b0, 3'b100, 3'b000);
    step("M12", 1'b0, 3'b000, 3'b111);
    // Let the concurrent properties observe the final update as well.
    step("DRAIN", 1'b0, 3'b000, 3'b000);
    $finish;
  end
endmodule
```

M00이 reference state를 known zero로 만든다. 비교에 `!==`를 써서 known expected value에 대한 DUT의 X/Z도 실패로 잡는다. 하지만 task 입력은 `bit`형이므로 이 testbench는 X/Z injection을 시험하지 않는다. Four-state negative test에는 4-state driver와 별도 expected-failure 처리가 필요하다.

마지막 DRAIN은 M12의 register update를 다음 posedge에서 보는 SVA까지 평가할 기회를 준다. DRAIN 자체의 hold 결과는 reference compare로도 확인한다. 더 긴 bounded property가 있다면 기능상 남은 obligation을 마칠 수 있는 종료 조건이 필요하다. End-of-test에 진행 중인 transaction의 check가 있는데 failure가 없다는 이유만으로 완료라고 하지 않는다.

Testbench 자체의 버그도 가능하므로 matrix의 수동 기대값과 reference model을 대조한다. 표, model, DUT가 모두 같은 잘못된 specification을 공유하는 경우는 독립적인 architecture review로 찾아야 한다.

## 6. Coverage는 도달과 Correctness를 분리한다

M05의 입력을 drive했다는 log만으로 해당 state에서 collision이 일어났다고 할 수 없다. Coverage는 DUT가 보는 sampling edge의 previous state와 event를 기준으로 잡는다. Correctness checker는 그 뒤의 expected Q를 따로 확인한다.

다음은 앞 문서의 checker 안에 추가할 수 있는 **partial SVA 예제**다. 특정 test 이름이 아니라 중요한 상황 자체를 관찰한다.

```systemverilog
for (genvar b = 0; b < W; b++) begin : g_corner_cover
  cp_clear_pending: cover property (@(posedge clk)
    (!rst && pending_q[b] && !event_mask[b] && clear_mask[b])
    ##1 !pending_q[b]);

  cp_repeat_event: cover property (@(posedge clk)
    (!rst && event_mask[b]) ##1 (!rst && event_mask[b])
    ##1 pending_q[b]);

  cp_reset_then_set: cover property (@(posedge clk)
    rst ##1 (!rst && event_mask[b]) ##1 pending_q[b]);
end
```

위 cover에는 결과까지 포함했지만, 하나의 witness가 전체 동작의 correctness를 보장하지는 않는다. 항상 set만 하는 DUT도 일부 cover를 만족할 수 있으므로 clear/hold/reset assertion과 scoreboard가 함께 필요하다.

전체 bank regression에서는 low/high/middle bit, empty/pending collision과 mixed mask를 추가로 분리한다. M00–M12 smoke set만으로 위 per-bit cover가 전부 hit되는 것도 보장하지 않는다. 미도달 bit의 조건은 추가 stimulus나 formal reachability task로 채운다.

Coverage denominator에는 승인된 목표만 포함하되, 제외한 항목과 근거는 보이게 남긴다. 다음은 서로 다른 status다.

- **Reached and checked**: 해당 상황이 발생했고 연결된 check가 통과했다.
- **Reached, checker failed**: Stimulus는 도달했지만 DUT/checker/specification 분석이 필요하다.
- **Not reached / not run**: 도달하지 못했거나 아직 실행하지 않았다.
- **Proven unreachable under assumptions**: 명시한 가정 아래 도달 불가를 입증한 evidence가 있다.
- **Excluded by specification**: 지원하지 않는 configuration 등이며 검토한 owner와 이유가 있다.
- **Unknown / timeout**: 도구가 판정을 끝내지 못했다. Pass나 unreachable이 아니다.

Covergroup/cross/transition bin과 SVA cover의 지원 범위는 tool/version에 따라 다르다. Verilator의 [Coverage 지원 설명](https://verilator.org/guide/latest/languages.html#coverage)처럼 부분 지원인 flow도 있으므로, code가 읽혔다는 사실과 coverage가 실제로 수집됐다는 사실을 구분한다.

## 7. Parameter, Invalid Input과 Sequence 확장

### Parameter는 별도 Elaboration으로 확인한다

`W=3` run은 `W=1`의 안전성을 증명하지 않는다. 최소 폭에서는 part-select나 loop range가 깨질 수 있고, 큰 폭에서는 mask truncation이 숨을 수 있다.

- `W=1`: 최소 legal width, set/clear collision과 hold.
- `W=3`: Non-power-of-two width, mixed mask와 중간 bit.
- 지원 상한 또는 대표적인 큰 폭: MSB walking mask, all-zero/all-one와 truncation.
- `W=0`: 지원 대상이 아니므로 configuration 단계에서 거절되는지 확인.

여기서 non-power-of-two **width**는 sticky bank의 bit 연결 시험이다. FIFO의 non-power-of-two **depth**에 필요한 pointer wrap과 full/empty 검증을 대신하지 않는다. 범위 정책은 [Counter Boundary Design](../09_control_logic/counter_boundary.md)을 참고한다.

### Illegal과 Rare-but-Legal을 구분한다

이 예제의 multi-bit event와 동일 bit set/clear는 합법이다. 이를 illegal bin이나 assumption으로 제외하면 핵심 priority bug를 검증 범위 밖으로 보낸다. 반면 정상 동작 중 unknown control은 별도 contract 위반이다.

Protocol violation이나 fault injection을 시험하려면 정상 환경의 assumption과 충돌하지 않는 별도 negative test 구성을 둔다. Expected detection/containment/recovery를 명시하고, 의도한 assertion failure와 예상하지 못한 failure를 구분한다. Illegal encoding 정책은 [Illegal State Recovery](../09_control_logic/illegal_state_recovery.md)가 정본이다.

### Sequence는 한 행의 State를 실제로 만든다

긴 stall 뒤 consume, reset 직전 accept, release 첫 edge event처럼 history가 필요한 case는 사전조건을 만드는 sequence도 evidence에 남긴다. 내부 state를 force해서만 만든 조건과 정상 interface를 통해 도달한 조건을 섞지 않는다.

Reset/clock mode별 회로 안전성은 [Reset Architecture Overview](../07_reset/overview.md)와 [Reset with Clock Gating](../07_reset/reset_with_clock_gating.md)에 연결한다. 이 single-clock bank의 matrix를 비동기 pulse capture, metastability 또는 RDC 검증 완료로 확대 해석하지 않는다.

## 8. Checker Sensitivity를 Mutation으로 확인한다

다음은 검증 전용 복사본에서 시도할 수 있는 mutation 계획이다. 실제 HDL 실행으로 검출되었다는 보고가 아니며, 수정된 DUT를 원본에 통합하지 않는다.

| 의도적으로 만든 오류 | 검출을 기대하는 case | 관련 check |
|---|---|---|
| Clear가 새 event보다 우선 | M05, M06 | `ap_set`, reference compare |
| Pending을 항상 0으로 출력 | M02, M08 | `ap_set` |
| Clear mask를 무시 | M07, M12 | `ap_clear` |
| MSB event 연결 누락 | M04, M11 | Bit별 `ap_set`, vector compare |
| Event가 없는 cycle마다 0으로 덮어쓰기 | M09 | `ap_hold` |
| Reset branch 제거 | M10 | `ap_reset` |

Bug가 검출되지 않으면 checker가 틀렸다고 단정하기 전에 대상 configuration, checker 연결, assertion 활성화, antecedent 도달과 종료 시점을 확인한다. Statement/branch coverage가 높아도 assertion이 disabled되어 있거나 기대값을 전혀 비교하지 않는 run일 수 있다.

## 9. Optimization과 PPA Review에 Matrix를 재사용한다

Matrix는 verification 팀만의 목록이 아니다. RTL 최적화가 보존해야 할 contract의 회귀시험 경계다.

| 변경 | 우선 재검증할 case | 기능 pass 이후의 별도 확인 |
|---|---|---|
| Pending update에 enable 추가 | Event=0인 clear, reset, hold | Enable cone과 실제 switching 감소 |
| Set/clear logic factoring | 같은 bit collision, disjoint mask | Mapping, fanout와 critical path |
| Storage/width 축소 | MSB, 최대값, legal parameter | FF/logic area와 physical footprint |
| Buffer/pipeline 추가 | Back-to-back, stall, flush, ordering | Latency/II, setup/hold, clock power |

예를 들어 event가 있을 때만 bank를 update하도록 enable을 붙이면 event=0인 clear가 막힐 수 있다. M07/M12와 `ap_clear`는 이 실수를 확인하는 기능 evidence이고, power가 실제로 줄었는지는 activity와 implementation report로 검증한다.

RTL bank는 bit별 state와 priority logic으로 mapping될 수 있으며, 정확한 cell 구성과 비용은 library와 tool에 따라 달라진다. Verification-only reference model, cover와 testbench를 제품 filelist에서 제외하는 flow에서는 그 model을 PPA area에 합산하지 않는다. On-chip monitor로 구현할 때는 별도의 FF, routing, clock/load 비용을 포함한다.

Simulation의 긴 traffic 또는 coverage 숫자를 power workload의 대표성으로 대신하지 않는다. Corner 위주의 worst-case activity와 실사용 workload는 목적이 다르다. 구현 증거의 비교 조건은 [Reading Synthesis Reports](../11_synthesis/read_synthesis_reports.md)를 참고한다.

## 10. Review 종료 조건과 인계

Matrix 행이 모두 초록색이라는 표시보다 각 결과의 범위가 중요하다. Run에는 RTL/checker/harness revision, top/parameter/define, tool/version, assertion/coverage 설정, simulation seed 또는 formal depth/mode/assumption을 연결한다. Raw log와 waveform은 프로젝트의 접근 정책에 맞게 보관하며 공개 문서에는 실제 내부 경로나 식별 정보를 넣지 않는다.

- [ ] 모든 중요한 priority와 boundary에 expected observation이 있는가.
- [ ] Precondition과 acceptance/cancellation을 실제로 관찰하는가.
- [ ] Same-edge 조합과 back-to-back sequence를 모두 포함하는가.
- [ ] Minimum/non-power-of-two/대표 폭을 각각 elaborate하고 검사하는가.
- [ ] 도달 coverage와 correctness check가 연결되며 독립적으로 보고되는가.
- [ ] Legal collision을 assumption이나 exclusion으로 지우지 않았는가.
- [ ] Negative test와 정상 contract의 가정이 섞이지 않는가.
- [ ] Test 종료 시 진행 중인 obligation과 미도달 cover를 확인하는가.
- [ ] Pass, bounded result, unknown, exclusion과 미실행을 구분하는가.
- [ ] 변경된 architecture가 matrix, property, consumer contract와 PPA 재검토 대상에 반영되는가.

## 관련 문서

- [Assertion-Driven RTL](assertion_driven_rtl.md)
- [Lint, Formal, and Equivalence](lint_formal_equivalence.md)
- [Reset and Mode Transition Verification](reset_mode_transition_verification.md)
- [Buffering and Backpressure](../02_architecture/buffering_and_backpressure.md)
- [Overflow, Saturation, and Rounding](../10_datapath/overflow_saturation_rounding.md)
- [Microarchitecture Decision Record](../02_architecture/microarchitecture_decision_record.md)
- [RTL Design Review Checklist](../15_checklist/rtl_design_review_checklist.md)
