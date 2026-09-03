# Datapath Parallel Pre-computation

Parallel pre-computation은 select가 확정되기 전에 여러 **pure datapath candidate**를 계산하고, transaction에 정렬된 select로 그중 하나만 architectural result로 commit하는 구현이다. 목적은 late select가 expensive operator 앞에 놓이는 timing path를 바꾸는 것이지, 계산량을 공짜로 줄이는 것이 아니다.

Pre-computation 여부와 select arrival을 architecture 수준에서 판단하는 방법은 [Parallelism and Pre-computation](../02_architecture/parallelism_and_precomputation.md), sharing/duplication과 scheduling은 [Resource Sharing vs Duplication](../02_architecture/resource_sharing_vs_duplication.md)이 정본이다. 이 문서는 registered datapath implementation, valid/select alignment와 speculative result ownership에 집중한다.

## 1. 같은 Functional Contract를 두 구조로 비교한다

두 unsigned W-bit operand pair 중 `sel`이 고른 합을 W+1 bits로 반환한다고 하자.

```text
sel=0: result = zero_extend(a) + zero_extend(b)
sel=1: result = zero_extend(c) + zero_extend(d)
```

### Shared form: select then operate

```text
a/c ── input MUX ──┐
                    ├─ one W+1-bit adder ──> result
b/d ── input MUX ──┘
          ▲
         sel
```

예상 구조는 operand MUX 두 개와 adder 한 개다. Select가 늦으면 `select/decode → wide input MUX → adder carry → register`가 한 path가 될 수 있다.

### Parallel form: operate then select

```text
a,b ── W+1-bit adder 0 ──┐
                          ├─ final result MUX ──> result
c,d ── W+1-bit adder 1 ──┘          ▲
                                   sel
```

두 adders가 select와 독립적으로 계산되고 late select는 final MUX만 통과할 수 있다. 대신 operator, candidate register/routing와 switching이 늘 수 있다.

두 후보는 latency, throughput, carry, invalid cycle과 reset contract가 같을 때만 PPA 비교가 의미 있다. 한쪽은 W-bit wrap이고 다른 쪽은 W+1 full sum이면 같은 function이 아니다.

## 2. RTL Text는 Exact Topology 보장이 아니다

RTL에 `+`를 한 번 쓰면 반드시 adder 하나, 두 번 쓰면 반드시 adder 두 개가 된다고 가정하지 않는다. Synthesis는 다음에 따라 expression을 factor, share, duplicate 또는 restructure할 수 있다.

- Timing/area optimization 목표
- Resource-sharing option과 hierarchy boundary
- Constant/mutual-exclusivity knowledge
- Library arithmetic cells 또는 macro inference
- Fanout, physical-aware synthesis와 retiming
- Preserve/don't-touch directive

Directive로 topology를 고정하기 전에 기능과 constraint가 맞는지 확인한다. 최종 판단은 operator inference report, mapped netlist, path timing과 post-place routing evidence로 한다.

## 3. Streaming One-Stage Parallel Example

다음 module은 input backpressure가 없는 one-stage streaming interface다.

- `in_valid=1`인 모든 edge가 accepted transaction이다.
- Accepted edge의 `in_sel`은 known 0 또는 1이어야 한다.
- 그 edge에 두 W+1-bit candidate sums와 `in_sel`을 함께 capture한다.
- `out_valid`와 selected registered candidate는 acceptance edge 직후 cycle에 유효하다.
- 매 cycle 새 input을 받을 수 있으므로 initiation interval은 1이다.
- `out_ready`가 없으므로 downstream은 valid output을 stall시킬 수 없다.
- 지원 contract는 `W >= 1`이다.

```systemverilog
module parallel_add_precompute #(
  parameter int unsigned W = 8
) (
  input  logic         clk,
  input  logic         rst_n,

  input  logic         in_valid,
  input  logic         in_sel,
  input  logic [W-1:0] in_a,
  input  logic [W-1:0] in_b,
  input  logic [W-1:0] in_c,
  input  logic [W-1:0] in_d,

  output logic         out_valid,
  output logic [W:0]   out_sum
);
  logic       valid_q;
  logic       sel_q;
  logic [W:0] sum_ab_q;
  logic [W:0] sum_cd_q;

  generate
    if (W < 1) begin : g_bad_width
      initial $fatal(1, "W must be at least 1");
    end
  endgenerate

  assign out_valid = valid_q;
  assign out_sum = sel_q ? sum_cd_q : sum_ab_q;

  // Event priority: asynchronous reset invalidates the output.
  // Otherwise every cycle advances valid; payload captures only in_valid work.
  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      valid_q <= 1'b0;
    end else begin
      valid_q <= in_valid;

      if (in_valid) begin
        sum_ab_q <= {1'b0, in_a} + {1'b0, in_b};
        sum_cd_q <= {1'b0, in_c} + {1'b0, in_d};
        sel_q    <= in_sel;
      end
    end
  end
endmodule
```

Both operands of each addition are explicitly W+1 bits, so carry is preserved. Merely widening `sum_ab_q`/`sum_cd_q` without operand extension would not express the same robust contract. Width conversion details are in [Datapath Width and Signedness](width_signedness.md).

`sum_ab_q`, `sum_cd_q`와 `sel_q`는 reset하지 않는다. `valid_q=0`이면 어떤 observer도 `out_sum`을 architectural data로 사용하지 않는다는 contract가 있기 때문이다. Debug, assertion, scan/test 또는 downstream side effect가 invalid payload를 관찰한다면 resetless assumption이 깨진다.

## 4. Cycle와 NBA/SVA Sampling Audit

Source는 edge 전 setup/hold를 만족하도록 input을 제시하고, downstream은 다음 edge에서 `out_valid`와 `out_sum`을 sampling한다고 가정한다.

| Edge | Edge 직전 input | Edge 직전 output | Edge 이후 output |
|---|---|---|---|
| E0 | transaction A, `valid=1`, `sel=0` | invalid | valid, sum A(a+b) |
| E1 | transaction B, `valid=1`, `sel=1` | valid sum A | valid, sum B(c+d) |
| E2 | bubble, `valid=0` | valid sum B | invalid, payload stale |
| E3 | transaction C, `valid=1` | invalid | valid sum C |
| E4 | `rst_n=0` | C may have been valid | invalid immediately after async reset response |

Architectural latency를 “accepted at E0, result valid during E0→E1, consumed at E1”인 one registered stage로 정의한다. Clocked assertion은 preponed region에서 E0 input을 sampling하고, E0 NBA로 갱신된 output을 E1 preponed sample에서 보므로 `|=>`가 맞다.

Back-to-back A/B에서 E1 edge 직전 consumer는 A를 보고, 같은 E1 edge의 NBA 뒤 output은 B로 바뀐다. `sel_q`도 각 candidate와 같은 edge에 capture되므로 B의 current input select가 A의 registered candidates에 적용되지 않는다.

## 5. Select Alignment가 Functional State다

다음 잘못된 형태는 registered candidates에 live `in_sel`을 적용한다.

```systemverilog
// Wrong when in_sel belongs to the current input transaction.
assign out_sum = in_sel ? sum_cd_q : sum_ab_q;
```

Back-to-back transactions가 select를 번갈아 쓰면 output candidate와 select가 다른 transaction에서 온다. Mode, signedness, scale, rounding policy, destination tag와 exception-enable도 result를 해석하거나 commit하는 데 필요하면 같은 latency로 capture한다.

Control을 다시 계산하는 것이 저장보다 싸 보일 수 있지만, recomputed control이 동일 transaction과 동일 configuration snapshot을 나타내는지 증명해야 한다.

## 6. Speculative Result와 Commit Point

두 candidate register가 모두 값을 갖더라도 architectural result는 다음 조건에서 하나뿐이다.

```text
candidate ownership: internal/speculative
selection owner:     sel_q for the same transaction
commit permission:   out_valid
committed value:     sel_q ? sum_cd_q : sum_ab_q
```

Candidate 계산에는 외부 side effect를 연결하지 않는다. 다음 항목도 selected branch와 함께 commit해야 한다.

- Overflow/underflow와 saturation direction
- Divide-by-zero, invalid operation 또는 ECC status
- Destination register/write enable
- Transaction tag, byte enable와 address
- Interrupt/error event

`candidate0_error | candidate1_error`를 output error로 사용하면 선택되지 않은 speculative operation이 architectural behavior를 바꾼다. Flag도 `sel_q`로 선택하고 `out_valid`로 qualify한다. 두 branch 모두 항상 legal해야 한다는 별도 diagnostic은 architectural exception과 다른 signal로 둔다.

## 7. Stall과 Backpressure가 필요하면 구조가 달라진다

예제에는 `out_ready`가 없으므로 valid result를 downstream이 반드시 다음 edge에 받을 수 있어야 한다. Downstream stall이 가능하면 다음 중 하나가 필요하다.

- Output holding register와 ready/valid handshake
- Elastic pipeline 또는 skid buffer
- 전체 candidate/sel stage clock-enable과 upstream backpressure
- 충분한 FIFO depth

Stall 중에는 selected data, select/tag와 flags가 모두 stable해야 하고 새 input을 덮어쓰면 안 된다. `in_ready`를 추가할 때 downstream ready가 combinational chain을 거쳐 upstream valid로 되돌아가는 loop도 피한다. Buffering contract는 [Buffering and Backpressure](../02_architecture/buffering_and_backpressure.md), pipeline 구현은 [Pipeline Design](../03_timing/pipeline.md)을 참고한다.

## 8. 언제 Timing에 도움이 되는가

Parallel pre-computation이 유리할 가능성이 큰 조건:

- Candidate operands가 select보다 일찍 안정됨
- Operator delay가 input MUX보다 큼
- Final MUX가 비교적 local하고 결과 width가 관리 가능
- Select가 state/arbitration/compare 뒤 늦게 도착함
- Area/power budget이 duplicated work를 허용함

도움이 작거나 역효과일 수 있는 조건:

- 한 candidate operand 자체가 늦게 도착함
- Select가 이미 일찍 안정됨
- Final result MUX와 long candidate routes가 critical path가 됨
- 두 operators가 멀리 배치되어 congestion/net delay가 커짐
- Feedback dependency 때문에 result가 다음 iteration operand를 기다림
- Operator가 큰 macro이고 duplicate placement가 불가능하거나 비쌈

Late-available operand를 같은 후보의 pre-compute로 앞당길 수는 없다. Feedback recurrence의 initiation interval은 candidate duplication보다 dependency distance와 state update latency가 지배할 수 있다.

## 9. Power와 Operand Isolation

Parallel form에서는 `sel=0`이어도 c/d candidate adder가, `sel=1`이어도 a/b candidate adder가 input change를 capture하고 toggle한다. Dynamic power는 roughly “선택된 result 수”가 아니라 실제 toggling nodes, capacitance와 activity에 좌우된다.

가능한 isolation:

```text
candidate input → isolation MUX/clamp → operator
                         ▲
                      early enable
```

하지만 isolation은 다음을 추가한다.

- W-bit input MUX/gating logic
- Enable decode와 fanout
- Clamp transition activity
- Operator 앞 추가 timing arc
- Synthesis factoring과 testability 변화

Isolation select가 늦으면 pre-computation으로 얻으려던 timing 이익을 상쇄한다. Candidate가 거의 항상 사용되거나 input이 이미 stable하면 순전력 이득도 작을 수 있다. 적용 조건과 measurement는 [Operand Isolation](../04_low_power/operand_isolation.md)을 따른다.

## 10. Area, Clock Load와 Physical Locality

예제는 combinational adders뿐 아니라 W+1-bit candidate registers 두 개와 select/valid FF를 가진다. Shared form이 operand registers와 one result register를 쓰는지에 따라 정확한 FF 비교가 달라진다.

물리적으로는 다음을 확인한다.

- 두 candidate buses가 final MUX로 모이는 거리
- Select의 final MUX fanout와 route
- Candidate register clock/reset load
- Adder placement와 carry-chain orientation
- Congestion 때문에 생긴 buffering/upsizing
- Consumer 근처 duplication이 central sharing보다 local한지

RTL operator count와 synthesis cell area만으로 결론을 내리지 않는다. 같은 floorplan constraint에서 post-place/post-route timing, power와 footprint를 비교한다.

## 11. Constant와 Cheap Candidate

두 branch를 그대로 복제하기 전에 제거와 단순화를 먼저 적용한다.

```text
candidate 0: x + 0       → identity
candidate 1: x + 1       → incrementer
candidate 2: x + K       → constant arithmetic
candidate 3: general add → full adder
```

모든 branch가 같은 expensive operator를 필요로 하지 않을 수 있다. 단순화 뒤에도 width, carry, overflow/exception과 latency contract가 동일해야 한다. 예를 들어 identity branch가 carry=0이라는 사실까지 result metadata에 반영한다.

## 12. Synthesis, STA와 PPA 비교 절차

1. 두 후보의 bit/cycle-level functional contract를 고정한다.
2. Input/output registers, valid, reset과 backpressure를 동일하게 둔다.
3. Shared와 parallel RTL을 같은 constraints/library/options로 합성한다.
4. Inferred operator 수와 width, MUX topology, fanout를 확인한다.
5. Data arrival와 select arrival을 분리해 path report를 비교한다.
6. Representative activity로 internal switching과 clock power를 비교한다.
7. Placement 뒤 candidate route, final MUX locality와 congestion을 확인한다.
8. Equivalence 또는 transaction-level scoreboard로 기능/latency를 재확인한다.

Synthesis가 두 adders를 다시 share했다면 timing 후보가 실제로 구현되지 않은 것이다. 반대로 shared RTL을 timing 최적화가 duplicate했다면 area estimate에 그 결과를 반영한다.

## 13. 적용하면 안 되는 경우

- Latency/throughput requirement가 다른 후보를 같은 최적화로 비교한다.
- Select와 candidate metadata를 같은 edge에 capture하지 않는다.
- Output backpressure가 있는데 one-stage overwrite 구조를 그대로 사용한다.
- Unselected branch의 error, write 또는 interrupt를 commit한다.
- Feedback dependency나 late operand를 select 문제로 오진한다.
- Power budget을 보지 않고 large multiplier/divider를 무조건 duplicate한다.
- RTL text만 보고 exact operator topology를 sign-off한다.
- Isolation control이 operator 앞 critical path를 다시 만들 수 있음을 무시한다.

## 14. Common Mistakes

### Live select로 registered candidates를 고른다

Back-to-back transaction에서 candidate와 select association이 깨진다.

### Valid만 맞으면 metadata도 맞다고 생각한다

Tag, rounding mode, signedness 또는 exception-enable이 다른 cycle에서 오면 값의 해석과 commit destination이 틀린다.

### 두 branch의 flags를 OR한다

Speculative failure가 selected transaction의 failure로 잘못 보고된다.

### Both branches가 항상 toggle하지 않는다고 가정한다

Final MUX에서 버려져도 upstream operator/register는 input activity를 볼 수 있다.

### Synthesis가 의도한 duplication을 그대로 둘 것이라 믿는다

Area optimization이 다시 sharing/factoring할 수 있으므로 mapped evidence가 필요하다.

## 15. Verification Strategy

### Cycle-accurate SVA

예제의 output은 acceptance edge NBA 뒤 갱신되고 다음 preponed sample에서 관찰된다. `disable iff (!rst_n)`은 reset assertion으로 in-flight property를 abort한다.

```systemverilog
default clocking cb @(posedge clk); endclocking
default disable iff (!rst_n);

ap_valid_alignment:
  assert property (1'b1 |=> out_valid == $past(in_valid));

ap_selected_sum:
  assert property (in_valid |=>
                   out_valid &&
                   out_sum ==
                     ($past(in_sel)
                       ? ({1'b0, $past(in_c)} + {1'b0, $past(in_d)})
                       : ({1'b0, $past(in_a)} + {1'b0, $past(in_b)})));

ap_bubble_alignment:
  assert property (!in_valid |=> !out_valid);

ap_accepted_select_is_known:
  assert property (in_valid |-> !$isunknown(in_sel));

ap_full_carry_sel0:
  assert property (in_valid && !in_sel &&
                   (&in_a) && (in_b == {{(W-1){1'b0}}, 1'b1}) |=>
                   out_valid && out_sum == {1'b1, {W{1'b0}}});
```

W=1에서 마지막 antecedent의 repetition count는 zero가 되고 `in_b=1'b1`, expected result는 2'b10이다. Minimum parameter compile과 simulation에서 tool support를 확인한다. 더 portable한 production property에서는 width가 정해진 localparam `ONE`을 사용할 수 있다.

### Dynamic/reference testing

- Shared reference function과 parallel output을 valid transaction별 비교한다.
- W=1, representative width와 최대 지원 width를 parameter sweep한다.
- 0+0, max+1, max+max의 W+1-bit carry를 확인한다.
- `sel=0/1`을 매 cycle 번갈아 back-to-back 입력한다.
- Bubble 전후 stale payload가 `out_valid` 없이 commit되지 않는지 확인한다.
- Reset을 idle, valid input edge와 back-to-back stream 사이에 assert한다.
- Candidate-specific flag를 추가한 variant에서 unselected flag가 output되지 않는지 확인한다.
- Gate/mapped report에서 expected sharing/duplication과 final MUX를 확인한다.

Output backpressure variant에는 stall 동안 data/select/flags stable, no overwrite, acceptance count와 output count/ordering property를 추가한다.

## 16. Design Review Checklist

- [ ] Shared와 parallel 후보의 width, latency, II와 reset contract가 같은가?
- [ ] 두 unsigned operands를 W+1로 zero-extend해 carry를 보존하는가?
- [ ] Candidate data와 select/mode/tag를 같은 accepted edge에 capture하는가?
- [ ] W>=1 parameter contract를 configuration/elaboration에서 검사하는가?
- [ ] Output backpressure가 없다는 interface 전제가 명확한가?
- [ ] Stall이 필요하면 storage, ready와 hold semantics를 추가했는가?
- [ ] Only selected valid candidate가 architectural result와 flag를 commit하는가?
- [ ] Speculative candidate가 write/interrupt/error side effect를 만들지 않는가?
- [ ] Both branches의 dynamic switching과 candidate-register clock load를 측정했는가?
- [ ] Isolation control path가 timing 이익을 상쇄하지 않는가?
- [ ] Late select와 late operand/feedback dependency를 구분했는가?
- [ ] Final MUX, select fanout와 candidate routing locality를 확인했는가?
- [ ] Synthesis report/netlist에서 actual share/duplicate topology를 확인했는가?
- [ ] W=1, carry boundary, alternating select, bubble와 reset을 검증했는가?
- [ ] SVA가 preponed/NBA cycle과 reset abort를 올바르게 반영하는가?

## 관련 문서

- [Parallelism and Pre-computation](../02_architecture/parallelism_and_precomputation.md)
- [Resource Sharing vs Duplication](../02_architecture/resource_sharing_vs_duplication.md)
- [Datapath MUX and Select](mux_and_select.md)
- [Datapath Width and Signedness](width_signedness.md)
- [Overflow, Saturation, and Rounding](overflow_saturation_rounding.md)
- [Operand Isolation](../04_low_power/operand_isolation.md)
- [Pipeline Design](../03_timing/pipeline.md)
- [Buffering and Backpressure](../02_architecture/buffering_and_backpressure.md)
